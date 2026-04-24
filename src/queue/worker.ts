import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { WebClient } from '@slack/web-api';
import type { AIProvider, GitHubConfig, NotionConfig, SlackConfig } from '../types/config.js';
import type { BugGroup } from '../core/deduplicator.js';
import type { BugAnalysis, FixSuggestion } from '../ai/types.js';
import type { PRResult } from '../integrations/github.js';

// ─── Job definitions ──────────────────────────────────────────────────────────

export interface AnalyzeJobData {
  bugGroup: BugGroup;
  codeContext?: string;
  userPrompt?: string;
}

export interface NotifyJobData {
  bugGroup: BugGroup;
  analysis: BugAnalysis;
  fix?: FixSuggestion;
}

export interface ApplyFixJobData {
  bugGroup: BugGroup;
  fix: FixSuggestion;
  analysis?: BugAnalysis;
}

export interface DocumentJobData {
  bugGroup: BugGroup;
  analysis: BugAnalysis;
  fix?: FixSuggestion;
  pr?: PRResult;
}

export type JobName = 'analyze' | 'notify' | 'apply-fix' | 'document';

export type JobDataMap = {
  analyze: AnalyzeJobData;
  notify: NotifyJobData;
  'apply-fix': ApplyFixJobData;
  document: DocumentJobData;
};

// ─── Config ───────────────────────────────────────────────────────────────────

export interface WorkerDeps {
  redisUrl: string;
  ai: { provider: AIProvider; apiKey: string };
  slack?: { webClient: WebClient; config: SlackConfig };
  github?: GitHubConfig;
  notion?: NotionConfig;
}

// ─── Retry backoff: 1s → 5s → 25s ────────────────────────────────────────────

const BACKOFF_DELAYS_MS = [1_000, 5_000, 25_000] as const;

function backoffDelay(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[idx] ?? 25_000;
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'custom' as const },
} as const;

const QUEUE_NAME = 'cleverbug-jobs';

// ─── Module singletons (set after startWorker) ────────────────────────────────

let _queue: Queue | null = null;
let _worker: Worker | null = null;

// ─── Public: add a job ────────────────────────────────────────────────────────

/**
 * Enqueues a job. Throws if startWorker() has not been called yet.
 */
export async function addJob<T extends JobName>(
  type: T,
  data: JobDataMap[T]
): Promise<void> {
  if (!_queue) {
    throw new Error('[CleverBug/queue] Call startWorker() before addJob().');
  }
  await _queue.add(type, data, JOB_OPTIONS);
  console.log(`[CleverBug/queue] Job enqueued: ${type}`);
}

// ─── Public: start the worker ─────────────────────────────────────────────────

/**
 * Initialises the BullMQ Queue + Worker.
 * Registers event handlers for failures and completion.
 * Safe to call once at application startup.
 */
export function startWorker(deps: WorkerDeps): void {
  if (_worker) {
    console.warn('[CleverBug/queue] startWorker() called more than once — ignoring.');
    return;
  }

  const connection = parseRedisConnection(deps.redisUrl);

  _queue = new Queue(QUEUE_NAME, { connection });

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[CleverBug/queue] Processing job: ${job.name} (attempt ${job.attemptsMade + 1}/3)`);
      await dispatch(job.name as JobName, job.data as JobDataMap[JobName], deps);
    },
    {
      connection,
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade),
      },
    }
  );

  _worker.on('completed', (job) => {
    console.log(`[CleverBug/queue] Job completed: ${job.name} (id: ${job.id})`);
  });

  _worker.on('failed', (job, err) => {
    if (!job) return;

    const isExhausted = job.attemptsMade >= 3;

    if (isExhausted && job.name === 'notify') {
      // Last line of defence: log full bug info so nothing is lost
      const data = job.data as NotifyJobData;
      console.error(
        '[CleverBug/queue] CRITICAL: Slack notify failed after 3 retries. Bug info follows to prevent data loss.',
        {
          jobId: job.id,
          fingerprint: data.bugGroup.fingerprint,
          error: data.bugGroup.reports[0]?.error,
          reportCount: data.bugGroup.reportCount,
          uniqueUsers: data.bugGroup.uniqueUserIds.length,
          firstSeen: data.bugGroup.firstSeenAt,
          lastSeen: data.bugGroup.lastSeenAt,
          analysis: data.analysis,
          failureReason: err.message,
        }
      );
    } else {
      console.error(
        `[CleverBug/queue] Job failed: ${job.name} (attempt ${job.attemptsMade}/3)`,
        { jobId: job.id, error: err.message }
      );
    }
  });

  _worker.on('error', (err) => {
    console.error('[CleverBug/queue] Worker error:', err.message);
  });

  console.log(`[CleverBug/queue] Worker started. Queue: "${QUEUE_NAME}". Redis: ${deps.redisUrl}`);
}

/**
 * Gracefully shuts down the worker and queue.
 * Waits for active jobs to finish before closing.
 */
export async function stopWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
  console.log('[CleverBug/queue] Worker stopped.');
}

// ─── Job dispatcher ───────────────────────────────────────────────────────────

async function dispatch(
  name: JobName,
  data: JobDataMap[JobName],
  deps: WorkerDeps
): Promise<void> {
  switch (name) {
    case 'analyze':
      return handleAnalyze(data as AnalyzeJobData, deps);
    case 'notify':
      return handleNotify(data as NotifyJobData, deps);
    case 'apply-fix':
      return handleApplyFix(data as ApplyFixJobData, deps);
    case 'document':
      return handleDocument(data as DocumentJobData, deps);
    default:
      throw new Error(`[CleverBug/queue] Unknown job type: ${String(name)}`);
  }
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

async function handleAnalyze(data: AnalyzeJobData, deps: WorkerDeps): Promise<void> {
  const { runAgent } = await import('../ai/agent.js');

  const firstReport = data.bugGroup.reports[0] ?? (() => { throw new Error('Empty bugGroup'); })();

  // Auto-fetch relevant source files from GitHub to give the AI code context
  let codeContext = data.codeContext;
  if (!codeContext && deps.github) {
    try {
      const { listRelevantFiles, readFileContent } = await import('../integrations/github.js');
      const stackTrace = firstReport.error.stack ?? '';
      const filePaths = listRelevantFiles(stackTrace, process.cwd());

      if (filePaths.length > 0) {
        const contents = await Promise.all(
          filePaths.slice(0, 5).map(async (fp) => {
            const src = await readFileContent(deps.github!, fp);
            return src ? `// ${fp}\n${src}` : null;
          })
        );
        const fetched = contents.filter(Boolean).join('\n\n---\n\n');
        if (fetched) codeContext = fetched;
      }
    } catch (err) {
      console.warn('[CleverBug/queue] Could not fetch code context from GitHub:', (err as Error).message);
    }
  }

  const result = await runAgent(firstReport, codeContext, data.userPrompt, deps.ai.apiKey);

  if (!_queue) return;

  // Always notify Slack (with fix attached if one was generated)
  await _queue.add('notify', {
    bugGroup: data.bugGroup,
    analysis: result.analysis,
    ...(result.fix !== undefined && { fix: result.fix }),
  } satisfies NotifyJobData, JOB_OPTIONS);

  // auto_fix: immediately apply without human approval
  // escalate_to_dev: fix is shown in Slack for human approval (handled via Slack button → onApplyFix)
  if (result.fix && result.analysis.suggestedAction === 'auto_fix') {
    await _queue.add('apply-fix', {
      bugGroup: data.bugGroup,
      fix: result.fix,
      analysis: result.analysis,
    } satisfies ApplyFixJobData, JOB_OPTIONS);
  }

  await _queue.add('document', {
    bugGroup: data.bugGroup,
    analysis: result.analysis,
    ...(result.fix !== undefined && { fix: result.fix }),
  } satisfies DocumentJobData, JOB_OPTIONS);
}

async function handleNotify(data: NotifyJobData, deps: WorkerDeps): Promise<void> {
  if (!deps.slack) {
    console.warn('[CleverBug/queue] notify job skipped — Slack not configured.');
    return;
  }

  const { notifyBug } = await import('../integrations/slack.js');

  await notifyBug(
    deps.slack.webClient,
    deps.slack.config,
    data.bugGroup,
    data.analysis,
    data.fix
  );
}

async function handleApplyFix(data: ApplyFixJobData, deps: WorkerDeps): Promise<void> {
  if (!deps.github) {
    console.warn('[CleverBug/queue] apply-fix job skipped — GitHub not configured.');
    return;
  }

  const { applyFix } = await import('../integrations/github.js');

  const firstReport = data.bugGroup.reports[0];
  if (!firstReport) throw new Error('[CleverBug/queue] apply-fix: bugGroup has no reports');

  const pr = await applyFix(deps.github, data.fix, firstReport, data.analysis);

  // Chain: update the document job with the PR link
  if (_queue) {
    await _queue.add('document', {
      bugGroup: data.bugGroup,
      analysis: data.analysis ?? { severity: 'low', confidence: 0, reasoning: '', affectedArea: '', suggestedAction: 'auto_fix' },
      fix: data.fix,
      pr,
    } satisfies DocumentJobData, JOB_OPTIONS);
  }
}

async function handleDocument(data: DocumentJobData, deps: WorkerDeps): Promise<void> {
  if (!deps.notion) {
    console.warn('[CleverBug/queue] document job skipped — Notion not configured.');
    return;
  }

  const { documentBug } = await import('../integrations/notion.js');

  await documentBug(
    deps.notion,
    data.bugGroup,
    data.analysis,
    data.fix,
    data.pr
  );
}

// ─── Redis URL parser ─────────────────────────────────────────────────────────

/**
 * Parses a Redis URL string into BullMQ ConnectionOptions.
 * Supports: redis://[:password@]host[:port][/db]
 */
function parseRedisConnection(url: string): ConnectionOptions {
  try {
    const parsed = new URL(url);
    const conn: ConnectionOptions = {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    };
    if (parsed.password) conn.password = parsed.password;
    if (parsed.username) conn.username = parsed.username;
    const db = parseInt(parsed.pathname.slice(1), 10);
    if (!isNaN(db) && db >= 0) conn.db = db;
    return conn;
  } catch {
    // Fallback for bare host:port strings
    const [host, portStr] = url.replace('redis://', '').split(':');
    return {
      host: host || 'localhost',
      port: portStr ? parseInt(portStr, 10) : 6379,
    };
  }
}
