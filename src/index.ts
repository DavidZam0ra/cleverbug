import { WebClient } from '@slack/web-api';
import { CleverBugConfigSchema } from './types/config.js';
import { captureError as detectError } from './core/detector.js';
import { deduplicate } from './core/deduplicator.js';
import { startWorker, addJob } from './queue/worker.js';

// ─── Public type exports ──────────────────────────────────────────────────────

export type { CleverBugConfig, EndUser, BugReport, BugContext, BugSeverity, BugSource, AIProvider, UserRole, EndUserLevel, GitHubConfig, SlackConfig, NotionConfig, LinearConfig, NetworkRequest } from './types/config.js';
export type { BugAnalysis, FixSuggestion, AgentResult } from './ai/types.js';
export type { BugGroup, DeduplicateResult, AiTriggerConfig } from './core/deduplicator.js';
export type { PRResult } from './integrations/github.js';
export type { NotionPage } from './integrations/notion.js';
export type { WorkerDeps } from './queue/worker.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface UserInfo {
  userId: string;
  email?: string;
  plan?: string;
  isBetaTester?: boolean;
  [key: string]: unknown;
}

/** Minimal Express-compatible error handler (no express dep required) */
type ExpressErrorMiddleware = (
  err: Error,
  req: unknown,
  res: unknown,
  next: (err?: unknown) => void
) => void;

// ─── Module state ─────────────────────────────────────────────────────────────

let _config: ReturnType<typeof CleverBugConfigSchema.parse> | null = null;
let _currentUser: UserInfo | null = null;
let _slackClient: WebClient | null = null;
let _initialized = false;

// ─── Pipeline: detector → deduplicator → queue ───────────────────────────────

function runPipeline(error: Error, req?: unknown, source: 'manual' | 'sentry' | 'posthog' | 'synthetic' = 'manual'): void {
  if (!_config) return;

  const report = detectError(error, req, _currentUser, source);
  const aiTrigger = {
    minUniqueReports: _config.aiTrigger?.minUniqueReports ?? 1,
    timeWindow: _config.aiTrigger?.timeWindow ?? '1h',
  };

  const result = deduplicate(report, aiTrigger);

  if (result.rateLimited) {
    console.log(`[CleverBug] Report rate-limited for user: ${report.context.userId ?? 'anonymous'}`);
    return;
  }

  if (result.shouldTriggerAI) {
    addJob('analyze', {
      bugGroup: result.group,
    }).catch((err: unknown) => {
      console.error('[CleverBug] Failed to enqueue analyze job:', err);
    });
  } else {
    console.log(
      `[CleverBug] Bug deduplicated (fingerprint: ${report.fingerprint.slice(0, 8)}…, ` +
      `reportCount: ${result.group.reportCount}, ` +
      `threshold: ${aiTrigger.minUniqueReports})`
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises CleverBug. Call once at app startup before any middleware.
 *
 * @example
 * CleverBug.init({
 *   slack: { token: process.env.SLACK_BOT_TOKEN, channel: '#bugs' },
 *   github: { token: process.env.GITHUB_TOKEN, repo: 'org/repo' },
 *   ai: { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY },
 * });
 */
function init(rawConfig: unknown): void {
  if (_initialized) {
    console.warn('[CleverBug] init() called more than once — ignoring.');
    return;
  }

  const result = CleverBugConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new Error(
      `[CleverBug] Invalid configuration:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`
    );
  }

  _config = result.data;
  _initialized = true;

  _slackClient = new WebClient(_config.slack.token);

  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  startWorker({
    redisUrl,
    ai: { provider: _config.ai.provider, apiKey: _config.ai.apiKey },
    slack: { webClient: _slackClient, config: _config.slack },
    ..._config.github !== undefined && { github: _config.github },
    ..._config.notion !== undefined && { notion: _config.notion },
  });

  console.log('[CleverBug] Initialized:', {
    channel: _config.slack.channel,
    repo: _config.github.repo,
    ai: _config.ai.provider,
    redis: redisUrl,
    environments: _config.environments,
  });
}

/**
 * Associates an end user with subsequent bug reports from this process context.
 * Call this in your auth middleware or session handler.
 *
 * For concurrent Node.js servers, consider AsyncLocalStorage for per-request isolation.
 *
 * @example
 * CleverBug.identify({ userId: req.user.id, email: req.user.email, plan: req.user.plan });
 */
function identify(userInfo: UserInfo): void {
  if (!_initialized) {
    throw new Error('[CleverBug] Call CleverBug.init() before CleverBug.identify()');
  }
  _currentUser = userInfo;
}

/**
 * Manually captures an error and pushes it through the full pipeline:
 * detect → deduplicate → (if threshold met) analyze with AI → notify Slack → create PR.
 *
 * @example
 * try {
 *   await processCheckout(cart);
 * } catch (err) {
 *   CleverBug.captureError(err as Error, req);
 *   res.status(500).json({ error: 'Something went wrong' });
 * }
 */
function captureError(error: Error, req?: unknown): void {
  if (!_initialized) {
    console.warn('[CleverBug] captureError() called before init() — ignoring.');
    return;
  }
  runPipeline(error, req, 'manual');
}

/**
 * Returns an Express-compatible error handler middleware.
 * Captures every unhandled error that reaches it, then calls next(err)
 * to preserve the normal Express error flow.
 *
 * Must be registered AFTER all routes:
 * @example
 * app.use(CleverBug.middleware());
 */
function middleware(): ExpressErrorMiddleware {
  const capture = captureError;
  return (err: Error, req: unknown, _res: unknown, next: (err?: unknown) => void): void => {
    capture(err, req);
    next(err);
  };
}

function getConfig(): ReturnType<typeof CleverBugConfigSchema.parse> {
  if (!_config) throw new Error('[CleverBug] Not initialized. Call CleverBug.init() first.');
  return _config;
}

function getSlackClient(): WebClient {
  if (!_slackClient) throw new Error('[CleverBug] Not initialized. Call CleverBug.init() first.');
  return _slackClient;
}

// ─── Named export (matches bloque requirement) ────────────────────────────────

export const CleverBug = { init, identify, captureError, middleware, getConfig, getSlackClient };

export default CleverBug;
