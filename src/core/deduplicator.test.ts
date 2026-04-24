import { describe, it, expect, beforeEach } from 'vitest';
import {
  deduplicate,
  parseTimeWindow,
  checkRateLimit,
  _resetForTesting,
} from './deduplicator.js';
import type { BugReport } from '../types/config.js';
import type { AiTriggerConfig } from './deduplicator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    id: 'test-id-1',
    timestamp: new Date().toISOString(),
    source: 'manual',
    fingerprint: 'fp-abc123',
    error: { name: 'TypeError', message: 'Cannot read properties of undefined' },
    context: {},
    reportCount: 1,
    uniqueUserCount: 1,
    environment: 'test',
    ...overrides,
  };
}

const defaultConfig: AiTriggerConfig = {
  minUniqueReports: 1,
  timeWindow: '1h',
};

beforeEach(() => {
  _resetForTesting();
});

// ─── parseTimeWindow ───────────────────────────────────────────────────────────

describe('parseTimeWindow', () => {
  it('parses seconds', () => {
    expect(parseTimeWindow('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseTimeWindow('30m')).toBe(1_800_000);
  });

  it('parses hours', () => {
    expect(parseTimeWindow('1h')).toBe(3_600_000);
  });

  it('parses days', () => {
    expect(parseTimeWindow('2d')).toBe(172_800_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseTimeWindow('1week')).toThrow('Invalid timeWindow format');
    expect(() => parseTimeWindow('')).toThrow('Invalid timeWindow format');
  });
});

// ─── First report ─────────────────────────────────────────────────────────────

describe('deduplicate — first report', () => {
  it('marks isNew: true on the first report for a fingerprint', () => {
    const report = makeBugReport();
    const result = deduplicate(report, defaultConfig);

    expect(result.isNew).toBe(true);
  });

  it('creates a group with reportCount 1', () => {
    const report = makeBugReport();
    const result = deduplicate(report, defaultConfig);

    expect(result.group.reportCount).toBe(1);
  });

  it('triggers AI when minUniqueReports is 1 (default)', () => {
    const report = makeBugReport();
    const result = deduplicate(report, defaultConfig);

    expect(result.shouldTriggerAI).toBe(true);
  });

  it('does not trigger AI when minUniqueReports is 3 and only 1 report', () => {
    const report = makeBugReport();
    const result = deduplicate(report, { minUniqueReports: 3, timeWindow: '1h' });

    expect(result.shouldTriggerAI).toBe(false);
  });

  it('stores firstSeenAt and lastSeenAt as ISO strings', () => {
    const before = new Date().toISOString();
    const result = deduplicate(makeBugReport(), defaultConfig);
    const after = new Date().toISOString();

    expect(result.group.firstSeenAt >= before).toBe(true);
    expect(result.group.firstSeenAt <= after).toBe(true);
    expect(result.group.lastSeenAt).toBe(result.group.firstSeenAt);
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe('deduplicate — subsequent reports (same fingerprint)', () => {
  it('marks isNew: false on the second report', () => {
    const fp = 'fp-same';
    deduplicate(makeBugReport({ fingerprint: fp }), defaultConfig);
    const result = deduplicate(makeBugReport({ id: 'test-id-2', fingerprint: fp }), defaultConfig);

    expect(result.isNew).toBe(false);
  });

  it('increments reportCount', () => {
    const fp = 'fp-same';
    deduplicate(makeBugReport({ fingerprint: fp }), defaultConfig);
    deduplicate(makeBugReport({ id: 'test-id-2', fingerprint: fp }), defaultConfig);
    const result = deduplicate(makeBugReport({ id: 'test-id-3', fingerprint: fp }), defaultConfig);

    expect(result.group.reportCount).toBe(3);
  });

  it('accumulates all reports in the group', () => {
    const fp = 'fp-same';
    deduplicate(makeBugReport({ fingerprint: fp }), defaultConfig);
    const result = deduplicate(makeBugReport({ id: 'test-id-2', fingerprint: fp }), defaultConfig);

    expect(result.group.reports).toHaveLength(2);
  });

  it('tracks unique userIds', () => {
    const fp = 'fp-same';
    deduplicate(makeBugReport({ fingerprint: fp, context: { userId: 'u1' } }), defaultConfig);
    deduplicate(makeBugReport({ fingerprint: fp, context: { userId: 'u2' } }), defaultConfig);
    const result = deduplicate(makeBugReport({ fingerprint: fp, context: { userId: 'u1' } }), defaultConfig);

    expect(result.group.uniqueUserIds).toEqual(['u1', 'u2']);
  });

  it('does NOT merge two different fingerprints', () => {
    deduplicate(makeBugReport({ fingerprint: 'fp-A' }), defaultConfig);
    const result = deduplicate(makeBugReport({ fingerprint: 'fp-B' }), defaultConfig);

    expect(result.isNew).toBe(true);
    expect(result.group.fingerprint).toBe('fp-B');
    expect(result.group.reportCount).toBe(1);
  });
});

// ─── AI trigger threshold ─────────────────────────────────────────────────────

describe('deduplicate — AI trigger threshold', () => {
  it('triggers AI on report N when minUniqueReports is N', () => {
    const fp = 'fp-threshold';
    const config: AiTriggerConfig = { minUniqueReports: 3, timeWindow: '1h' };

    deduplicate(makeBugReport({ fingerprint: fp }), config);
    const second = deduplicate(makeBugReport({ fingerprint: fp }), config);
    expect(second.shouldTriggerAI).toBe(false);

    const third = deduplicate(makeBugReport({ fingerprint: fp }), config);
    expect(third.shouldTriggerAI).toBe(true);
  });

  it('does not re-trigger AI within the timeWindow after first trigger', () => {
    const fp = 'fp-cooldown';
    const config: AiTriggerConfig = { minUniqueReports: 1, timeWindow: '1h' };

    const first = deduplicate(makeBugReport({ fingerprint: fp }), config);
    expect(first.shouldTriggerAI).toBe(true);

    const second = deduplicate(makeBugReport({ fingerprint: fp }), config);
    expect(second.shouldTriggerAI).toBe(false);
  });

  it('re-triggers AI after timeWindow has elapsed', () => {
    const fp = 'fp-retrigger';
    const config: AiTriggerConfig = { minUniqueReports: 1, timeWindow: '1h' };

    deduplicate(makeBugReport({ fingerprint: fp }), config);

    const group = deduplicate(makeBugReport({ fingerprint: fp }), config).group;
    // Manually backdate lastTriggeredAt to simulate elapsed window
    group.lastTriggeredAt = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const result = deduplicate(makeBugReport({ fingerprint: fp }), config);
    expect(result.shouldTriggerAI).toBe(true);
  });

  it('sentry source always triggers AI regardless of threshold', () => {
    const fp = 'fp-sentry';
    const config: AiTriggerConfig = { minUniqueReports: 999, timeWindow: '1h' };

    const result = deduplicate(makeBugReport({ fingerprint: fp, source: 'sentry' }), config);
    expect(result.shouldTriggerAI).toBe(true);
  });

  it('sentry triggers AI again even within timeWindow', () => {
    const fp = 'fp-sentry-repeat';
    const config: AiTriggerConfig = { minUniqueReports: 1, timeWindow: '1h' };

    deduplicate(makeBugReport({ fingerprint: fp, source: 'sentry' }), config);
    const second = deduplicate(makeBugReport({ fingerprint: fp, source: 'sentry' }), config);

    expect(second.shouldTriggerAI).toBe(true);
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('allows up to 3 reports per user in 24h', () => {
    const userId = 'user-rl';
    const now = Date.now();

    expect(checkRateLimit(userId, now)).toBe(false);
    expect(checkRateLimit(userId, now + 1)).toBe(false);
    expect(checkRateLimit(userId, now + 2)).toBe(false);
    expect(checkRateLimit(userId, now + 3)).toBe(true);
  });

  it('resets after the 24h window', () => {
    const userId = 'user-reset';
    const now = Date.now();

    checkRateLimit(userId, now - 23 * 3_600_000);
    checkRateLimit(userId, now - 23 * 3_600_000 + 1);
    checkRateLimit(userId, now - 23 * 3_600_000 + 2);

    // All 3 of the above are within 24h → 4th should be limited
    expect(checkRateLimit(userId, now)).toBe(true);

    // But if the 3 old timestamps fall outside the 24h window, reset
    _resetForTesting();
    checkRateLimit(userId, now - 25 * 3_600_000);
    checkRateLimit(userId, now - 25 * 3_600_000 + 1);
    checkRateLimit(userId, now - 25 * 3_600_000 + 2);
    // Those are now older than 24h from `now` → should not count
    expect(checkRateLimit(userId, now)).toBe(false);
  });

  it('deduplicate returns rateLimited: true when user is over limit', () => {
    const userId = 'user-ded-rl';
    const fp = 'fp-rl';
    const config = defaultConfig;
    const ctx = { userId };

    deduplicate(makeBugReport({ fingerprint: fp, context: ctx }), config);
    deduplicate(makeBugReport({ fingerprint: fp, context: ctx }), config);
    deduplicate(makeBugReport({ fingerprint: fp, context: ctx }), config);

    const limited = deduplicate(makeBugReport({ fingerprint: fp, context: ctx }), config);
    expect(limited.rateLimited).toBe(true);
    expect(limited.shouldTriggerAI).toBe(false);
  });

  it('rate limit is per-user, other users are unaffected', () => {
    const fp = 'fp-multi-user';
    const config = defaultConfig;

    for (let i = 0; i < 4; i++) {
      deduplicate(makeBugReport({ fingerprint: fp, context: { userId: 'heavy-user' } }), config);
    }

    const other = deduplicate(makeBugReport({ fingerprint: fp, context: { userId: 'other-user' } }), config);
    expect(other.rateLimited).toBe(false);
  });

  it('reports without userId are never rate limited', () => {
    const fp = 'fp-anon';
    const config = defaultConfig;

    for (let i = 0; i < 10; i++) {
      const result = deduplicate(makeBugReport({ fingerprint: fp, id: `id-${i}` }), config);
      expect(result.rateLimited).toBe(false);
    }
  });
});
