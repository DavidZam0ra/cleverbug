import { createHash, randomUUID } from 'node:crypto';
import { buildContext } from '../reporter/context.js';
import type { BugReport, BugSource } from '../types/config.js';

/**
 * Strips line/column numbers and absolute paths from a stack line
 * so the fingerprint is stable across deploys and machines.
 *
 * "at foo (/home/user/project/src/app.ts:42:7)"
 * → "at foo (app.ts)"
 */
function normalizeStackLine(line: string): string {
  return line
    .replace(/:\d+:\d+/g, '')
    .replace(/\(.*[/\\]([^/\\]+)\)/, '($1)')
    .trim();
}

/**
 * Generates a deterministic SHA-256 fingerprint for a given error.
 * Input: error.message + first 3 normalized stack lines.
 * Same logical bug produces the same fingerprint regardless of deploy path or line numbers.
 */
export function generateFingerprint(error: Error): string {
  const stackLines = (error.stack ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('at '))
    .slice(0, 3)
    .map(normalizeStackLine);

  const raw = [error.name, error.message, ...stackLines].join('\n');

  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Normalizes any Error into a BugReport, enriched with request/user context.
 *
 * @param error - The captured Error object
 * @param req   - Optional HTTP request (Express / Fastify / any compatible shape)
 * @param userInfo - Optional user identity (from CleverBug.identify())
 * @param source - Where the error originated (default: 'manual')
 */
export function captureError(
  error: Error,
  req?: unknown,
  userInfo?: unknown,
  source: BugSource = 'manual'
): BugReport {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    fingerprint: generateFingerprint(error),
    error: {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined && { stack: error.stack }),
    },
    context: buildContext(req, userInfo),
    reportCount: 1,
    uniqueUserCount: 1,
    environment: process.env['NODE_ENV'] ?? 'unknown',
  };
}

/**
 * Builds a BugReport from a raw Sentry webhook payload.
 * Sentry sends normalized error data — we extract what we need.
 */
export function captureFromSentry(payload: unknown): BugReport {
  const p = payload as Record<string, unknown>;

  const exception = (p['exception'] as Record<string, unknown> | undefined)?.['values'];
  const firstException = Array.isArray(exception)
    ? (exception[0] as Record<string, unknown>)
    : undefined;

  const syntheticError = new Error(
    typeof p['message'] === 'string'
      ? p['message']
      : (firstException?.['value'] as string | undefined) ?? 'Unknown Sentry error'
  );
  syntheticError.name =
    (firstException?.['type'] as string | undefined) ?? 'Error';

  const rawFrames = (firstException?.['stacktrace'] as Record<string, unknown> | undefined)
    ?.['frames'];
  if (Array.isArray(rawFrames) && rawFrames.length > 0) {
    syntheticError.stack = rawFrames
      .slice(-5)
      .map(
        (f: unknown) =>
          `  at ${(f as Record<string, unknown>)['function'] ?? '<anonymous>'} (${(f as Record<string, unknown>)['filename'] ?? '?'})`
      )
      .join('\n');
  }

  const report = captureError(syntheticError, undefined, undefined, 'sentry');

  const userRecord = p['user'] as Record<string, unknown> | undefined;
  if (userRecord) {
    const uid = userRecord['id'];
    const email = userRecord['email'];
    if (typeof uid === 'string') report.context.userId = uid;
    if (typeof email === 'string') report.context.userEmail = email;
  }

  const tags = p['tags'] as Record<string, unknown> | undefined;
  if (typeof tags?.['environment'] === 'string') {
    report.environment = tags['environment'] as string;
  }

  return report;
}

/**
 * Builds a BugReport from a PostHog behavioral anomaly alert.
 * PostHog doesn't surface a JS Error — we construct one from the event.
 */
export function captureFromPostHog(payload: unknown): BugReport {
  const p = payload as Record<string, unknown>;

  const eventName = (p['event'] as string | undefined) ?? 'unknown_posthog_event';
  const description =
    (p['description'] as string | undefined) ??
    `Behavioral anomaly detected: ${eventName}`;

  const syntheticError = new Error(description);
  syntheticError.name = 'BehavioralAnomaly';

  const report = captureError(syntheticError, undefined, undefined, 'posthog');

  const distinctId = p['distinct_id'] as string | undefined;
  if (distinctId) {
    report.context.userId = distinctId;
  }

  return report;
}

/**
 * Builds a BugReport from a synthetic test failure (Playwright / Checkly).
 */
export function captureFromSynthetic(payload: unknown): BugReport {
  const p = payload as Record<string, unknown>;

  const message =
    (p['message'] as string | undefined) ??
    (p['error'] as string | undefined) ??
    'Synthetic test failed';

  const syntheticError = new Error(message);
  syntheticError.name = 'SyntheticTestFailure';

  if (typeof p['stack'] === 'string') {
    syntheticError.stack = p['stack'];
  }

  const report = captureError(syntheticError, undefined, undefined, 'synthetic');

  if (typeof p['url'] === 'string') {
    report.context.url = p['url'];
  }

  return report;
}
