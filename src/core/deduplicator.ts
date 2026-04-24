import type { BugReport } from '../types/config.js';

export interface AiTriggerConfig {
  minUniqueReports: number;
  timeWindow: string;
}

export interface BugGroup {
  fingerprint: string;
  reportCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** ISO timestamp of last time AI was triggered for this group */
  lastTriggeredAt?: string;
  uniqueUserIds: string[];
  reports: BugReport[];
}

export interface DeduplicateResult {
  isNew: boolean;
  shouldTriggerAI: boolean;
  rateLimited: boolean;
  group: BugGroup;
}

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Parses a human-readable time window string into milliseconds.
 * Supports: Xs (seconds), Xm (minutes), Xh (hours), Xd (days).
 */
export function parseTimeWindow(tw: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(tw.trim());
  if (!match) {
    throw new Error(`[CleverBug] Invalid timeWindow format: "${tw}". Expected e.g. "30m", "1h", "2d".`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 's': return value * 1_000;
    case 'm': return value * 60 * 1_000;
    case 'h': return value * 60 * 60 * 1_000;
    case 'd': return value * 24 * 60 * 60 * 1_000;
    default: throw new Error(`[CleverBug] Unknown time unit: "${unit}"`);
  }
}

/**
 * In-memory deduplication store.
 * fingerprint → BugGroup accumulator.
 *
 * v1: in-memory Map, resets on process restart.
 * v2 (planned): Redis-backed store for persistence + multi-instance support.
 */
const groups = new Map<string, BugGroup>();

/**
 * Per-user report timestamps for rate limiting.
 * userId → sorted list of ISO timestamps (within last 24h).
 */
const userReportTimestamps = new Map<string, number[]>();

/**
 * Checks and records a report attempt from a userId.
 * Returns true if the user has exceeded the rate limit (3 reports / 24h).
 *
 * Exported so tests can inspect behavior independently.
 */
export function checkRateLimit(userId: string, now = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (userReportTimestamps.get(userId) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    console.warn(`[CleverBug] rate_limited userId="${userId}" (${timestamps.length} reports in last 24h)`);
    userReportTimestamps.set(userId, timestamps);
    return true;
  }

  timestamps.push(now);
  userReportTimestamps.set(userId, timestamps);
  return false;
}

/**
 * Determines whether the AI agent should be triggered for a given group.
 *
 * Triggers when BOTH conditions hold:
 *  1. reportCount >= minUniqueReports
 *  2. AI was never triggered, OR last trigger was > timeWindow ago
 *
 * Exception: source === 'sentry' always bypasses the threshold.
 */
export function shouldTriggerAI(
  report: BugReport,
  group: BugGroup,
  config: AiTriggerConfig,
  now = Date.now()
): boolean {
  if (report.source === 'sentry') return true;

  if (group.reportCount < config.minUniqueReports) return false;

  if (!group.lastTriggeredAt) return true;

  const windowMs = parseTimeWindow(config.timeWindow);
  const elapsed = now - new Date(group.lastTriggeredAt).getTime();
  return elapsed > windowMs;
}

/**
 * Deduplicates an incoming BugReport against the in-memory group store.
 *
 * Flow:
 *  1. Rate-limit check (skip if userId has exceeded quota)
 *  2. Upsert into the fingerprint group
 *  3. Decide whether to trigger AI
 *  4. Update lastTriggeredAt if AI is triggered
 *
 * WARNING: groups with different root causes but similar messages
 * are distinguished solely by fingerprint (SHA-256 of error name + message
 * + normalized stack). Never merge groups with different fingerprints.
 */
export function deduplicate(report: BugReport, config: AiTriggerConfig): DeduplicateResult {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const userId = report.context.userId;
  if (userId) {
    const limited = checkRateLimit(userId, now);
    if (limited) {
      const existing = groups.get(report.fingerprint);
      const group: BugGroup = existing ?? {
        fingerprint: report.fingerprint,
        reportCount: 0,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        uniqueUserIds: [],
        reports: [],
      };
      return { isNew: !existing, shouldTriggerAI: false, rateLimited: true, group };
    }
  }

  const existing = groups.get(report.fingerprint);
  const isNew = existing === undefined;

  const group: BugGroup = existing ?? {
    fingerprint: report.fingerprint,
    reportCount: 0,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    uniqueUserIds: [],
    reports: [],
  };

  group.reportCount += 1;
  group.lastSeenAt = nowIso;

  if (userId && !group.uniqueUserIds.includes(userId)) {
    group.uniqueUserIds.push(userId);
  }

  group.reports.push(report);
  groups.set(report.fingerprint, group);

  const triggerAI = shouldTriggerAI(report, group, config, now);
  if (triggerAI) {
    group.lastTriggeredAt = nowIso;
  }

  return { isNew, shouldTriggerAI: triggerAI, rateLimited: false, group };
}

/** Resets all in-memory state. Intended for tests only. */
export function _resetForTesting(): void {
  groups.clear();
  userReportTimestamps.clear();
}
