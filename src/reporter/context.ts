import type { BugContext, NetworkRequest } from '../types/config.js';

interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  timestamp: number;
}

/** Rolling buffer of recent console output. Installed once on first import. */
const consoleBuffer: ConsoleEntry[] = [];
const CONSOLE_BUFFER_MAX = 200;
const CONSOLE_WINDOW_MS = 30_000;

let consolePatched = false;

/**
 * Patches global console methods to capture output into a ring buffer.
 * Safe to call multiple times — only patches once.
 */
export function installConsoleCapture(): void {
  if (consolePatched) return;
  consolePatched = true;

  const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;

  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const entry: ConsoleEntry = {
        level,
        message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        timestamp: Date.now(),
      };
      consoleBuffer.push(entry);
      if (consoleBuffer.length > CONSOLE_BUFFER_MAX) {
        consoleBuffer.shift();
      }
    };
  }
}

/**
 * Returns console entries from the last 30 seconds, formatted as strings.
 */
export function getRecentConsoleLogs(): string[] {
  const cutoff = Date.now() - CONSOLE_WINDOW_MS;
  return consoleBuffer
    .filter((e) => e.timestamp >= cutoff)
    .map((e) => `[${e.level.toUpperCase()}] ${e.message}`);
}

/**
 * Extracts HTTP request info from an Express/Fastify/generic request object.
 * Uses duck-typing — no hard dependency on any framework.
 */
function extractRequestInfo(req: unknown): Pick<BugContext, 'url' | 'userAgent' | 'browser' | 'device'> {
  if (!req || typeof req !== 'object') return {};

  const r = req as Record<string, unknown>;

  const rawUrl =
    (r['url'] as string | undefined) ??
    (r['originalUrl'] as string | undefined) ??
    (r['path'] as string | undefined);

  const headers = (r['headers'] as Record<string, string | string[] | undefined>) ?? {};
  const rawUserAgent =
    (headers['user-agent'] as string | undefined) ??
    (r['userAgent'] as string | undefined);

  return {
    ...(rawUrl !== undefined && { url: rawUrl }),
    ...(rawUserAgent !== undefined && {
      userAgent: rawUserAgent,
      browser: parseBrowser(rawUserAgent),
      device: parseDevice(rawUserAgent),
    }),
  };
}

/**
 * Extracts user identity from a userInfo object (from CleverBug.identify()).
 * Accepts any shape — reads known fields via duck-typing.
 */
function extractUserInfo(
  userInfo: unknown
): Pick<BugContext, 'userId' | 'userEmail' | 'userPlan' | 'isBetaTester'> {
  if (!userInfo || typeof userInfo !== 'object') return {};

  const u = userInfo as Record<string, unknown>;

  const userId = (u['userId'] as string | undefined) ?? (u['id'] as string | undefined);
  const userEmail = (u['email'] as string | undefined) ?? (u['userEmail'] as string | undefined);
  const userPlan = (u['plan'] as string | undefined) ?? (u['userPlan'] as string | undefined);
  const isBetaTester = typeof u['isBetaTester'] === 'boolean' ? u['isBetaTester'] : undefined;

  return {
    ...(userId !== undefined && { userId }),
    ...(userEmail !== undefined && { userEmail }),
    ...(userPlan !== undefined && { userPlan }),
    ...(isBetaTester !== undefined && { isBetaTester }),
  };
}

/**
 * Coarse browser detection from User-Agent string.
 * Not exhaustive — used for debugging context only, not feature detection.
 */
function parseBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua)) return 'Safari';
  if (/MSIE|Trident/i.test(ua)) return 'Internet Explorer';
  return 'Unknown';
}

/**
 * Coarse device type detection from User-Agent string.
 */
function parseDevice(ua: string): string {
  if (/tablet|ipad/i.test(ua)) return 'Tablet';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

/**
 * Builds the BugContext object from available runtime information.
 *
 * @param req      - Optional HTTP request (Express / Fastify / any compatible shape)
 * @param userInfo - Optional user identity (from CleverBug.identify())
 * @param networkRequests - Optional tracked network requests to attach
 */
export function buildContext(
  req?: unknown,
  userInfo?: unknown,
  networkRequests?: NetworkRequest[]
): BugContext {
  const requestInfo = extractRequestInfo(req);
  const userFields = extractUserInfo(userInfo);
  const consoleLogs = getRecentConsoleLogs();

  return {
    ...requestInfo,
    ...userFields,
    ...(consoleLogs.length > 0 && { consoleLogs }),
    ...(networkRequests && networkRequests.length > 0 && { networkRequests }),
  };
}
