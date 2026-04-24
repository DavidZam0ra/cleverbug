import type { BugReport } from '../types/config.js';

export type BugSeverityAI = 'critical' | 'medium' | 'low';

export interface BugAnalysis {
  severity: BugSeverityAI;
  /** 0–1 confidence score */
  confidence: number;
  /** Explanation in Spanish, max 3 sentences */
  reasoning: string;
  affectedArea: string;
  suggestedAction: 'escalate_to_dev' | 'auto_fix' | 'monitor';
}

export interface FixSuggestion {
  /** e.g. 'fix/cleverbug-null-check-checkout' */
  branchName: string;
  commitMessage: string;
  /** Unified diff of the proposed fix */
  diff: string;
  /** What changes and why, in Spanish */
  explanation: string;
  /** 0–1 — if <0.7 recommend manual review */
  confidence: number;
}

/** Common interface both Gemini and Claude providers must implement */
export interface AIProviderClient {
  analyzeBug(report: BugReport, codeContext?: string): Promise<BugAnalysis>;
  generateFix(report: BugReport, codeContext: string, userPrompt?: string): Promise<FixSuggestion>;
}

export interface AgentResult {
  analysis: BugAnalysis;
  /** Only present when suggestedAction === 'auto_fix' and severity !== 'critical' */
  fix?: FixSuggestion;
}

// ─── Prompt builders (shared between providers) ───────────────────────────────

export function buildAnalyzePrompt(report: BugReport, codeContext?: string): string {
  const ctx = report.context;
  const lines: string[] = [
    '## Bug Report',
    `- Error name: ${report.error.name}`,
    `- Message: ${report.error.message}`,
    `- Source: ${report.source}`,
    `- Environment: ${report.environment}`,
    `- Timestamp: ${report.timestamp}`,
  ];

  if (report.error.stack) {
    lines.push('', '## Stack Trace', '```', report.error.stack, '```');
  }

  if (ctx.url) lines.push(`- URL: ${ctx.url}`);
  if (ctx.userId) lines.push(`- User ID: ${ctx.userId}`);
  if (ctx.userPlan) lines.push(`- Plan: ${ctx.userPlan}`);
  if (ctx.browser) lines.push(`- Browser: ${ctx.browser} / ${ctx.device ?? 'unknown device'}`);

  if (ctx.consoleLogs && ctx.consoleLogs.length > 0) {
    lines.push('', '## Console Logs (last 30s)', ctx.consoleLogs.slice(-10).join('\n'));
  }

  if (ctx.networkRequests && ctx.networkRequests.length > 0) {
    lines.push('', '## Recent Network Requests');
    for (const req of ctx.networkRequests.slice(-5)) {
      lines.push(`  ${req.method} ${req.url} → ${req.status ?? '?'}`);
    }
  }

  if (codeContext) {
    lines.push('', '## Relevant Code', '```', codeContext, '```');
  }

  lines.push(
    '',
    '## Instructions',
    'Analyze this bug and respond ONLY with a JSON object matching this exact schema:',
    '```json',
    JSON.stringify(
      {
        severity: '"critical" | "medium" | "low"',
        confidence: '0.0 to 1.0',
        reasoning: 'Explanation in Spanish. Maximum 3 sentences.',
        affectedArea: 'Which feature/module/component is affected',
        suggestedAction: '"escalate_to_dev" | "auto_fix" | "monitor"',
      },
      null,
      2
    ),
    '```',
    'Rules:',
    '- severity=critical: data loss, auth bypass, payment errors, service down',
    '- severity=medium: broken feature, degraded UX',
    '- severity=low: cosmetic, edge case',
    '- suggestedAction=auto_fix when confidence>0.6 and severity!=critical and the fix is a simple code change',
    '- suggestedAction=escalate_to_dev only for architectural issues, missing context, or security concerns',
    '- reasoning and affectedArea MUST be in Spanish',
    '- Return ONLY the JSON, no markdown, no explanation outside the JSON.'
  );

  return lines.join('\n');
}

export function buildFixPrompt(
  report: BugReport,
  codeContext: string,
  userPrompt?: string
): string {
  const slug = report.error.message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const lines: string[] = [
    '## Bug to Fix',
    `- Error: ${report.error.name}: ${report.error.message}`,
    `- Environment: ${report.environment}`,
  ];

  if (report.error.stack) {
    lines.push('', '## Stack Trace', '```', report.error.stack, '```');
  }

  lines.push('', '## Relevant Code to Fix', '```', codeContext, '```');

  if (userPrompt) {
    lines.push('', '## Developer Context', userPrompt);
  }

  lines.push(
    '',
    '## Instructions',
    'Generate a fix for this bug and respond ONLY with a JSON object matching this exact schema:',
    '```json',
    JSON.stringify(
      {
        branchName: `fix/cleverbug-${slug}`,
        commitMessage: 'fix: concise description of what was fixed',
        diff: '--- a/path/to/file.ts\n+++ b/path/to/file.ts\n@@ ... @@\n- old line\n+ new line',
        explanation: 'Qué cambia y por qué, en español.',
        confidence: '0.0 to 1.0',
      },
      null,
      2
    ),
    '```',
    'Rules:',
    '- diff must be a valid unified diff',
    '- branchName must follow the pattern: fix/cleverbug-<short-slug>',
    '- commitMessage must follow conventional commits format',
    '- explanation MUST be in Spanish',
    '- If confidence < 0.7, note in explanation that manual review is recommended',
    '- Return ONLY the JSON, no markdown wrapper.'
  );

  return lines.join('\n');
}

/** Strips markdown code fences from AI response and parses JSON */
export function parseAIJson<T>(raw: string, label: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    throw new Error(
      `[CleverBug] AI returned invalid JSON for ${label}.\nRaw response:\n${raw.slice(0, 500)}`
    );
  }
}

const ANALYZE_SYSTEM = `You are CleverBug, an expert software bug analyzer.
You receive bug reports from production applications and classify them.
You ALWAYS respond with strict JSON only — no prose, no markdown outside the JSON.
Your reasoning must be written in Spanish.`;

const FIX_SYSTEM = `You are CleverBug, an expert software engineer that fixes bugs.
You receive a bug report and the relevant source code.
You generate a minimal, safe fix as a unified diff.
You ALWAYS respond with strict JSON only — no prose, no markdown outside the JSON.
Your explanation must be written in Spanish.`;

export const SYSTEM_PROMPTS = { analyze: ANALYZE_SYSTEM, fix: FIX_SYSTEM } as const;
