import type { BugReport } from '../types/config.js';
import type { AIProviderClient, AgentResult, BugAnalysis, FixSuggestion } from './types.js';

export type { BugAnalysis, FixSuggestion, AgentResult } from './types.js';

/**
 * Resolves the configured AI provider client.
 * Provider is selected from AI_PROVIDER env var (falls back to 'gemini').
 * apiKey is read from AI_API_KEY env var if not passed explicitly.
 */
async function resolveProvider(apiKey?: string): Promise<AIProviderClient> {
  const providerName = process.env['AI_PROVIDER'] ?? 'gemini';
  const key = apiKey ?? process.env['AI_API_KEY'] ?? '';

  if (!key) {
    throw new Error('[CleverBug] AI_API_KEY is not set. Add it to your environment variables.');
  }

  if (providerName === 'claude') {
    const { ClaudeProvider } = await import('./claude.js');
    return new ClaudeProvider(key);
  }

  const { GeminiProvider } = await import('./gemini.js');
  return new GeminiProvider(key);
}

/**
 * Orchestrates the full AI analysis pipeline for a single bug report.
 *
 * Steps:
 *  1. Select provider (gemini | claude) from AI_PROVIDER env var
 *  2. Call analyzeBug → get severity + suggestedAction
 *  3. If suggestedAction === 'auto_fix' AND severity !== 'critical'
 *     → call generateFix with available code context
 *  4. Return AgentResult (analysis + optional fix)
 *
 * The agent NEVER applies any change. It only proposes.
 * All actions require human approval via Slack or PR review.
 *
 * @param report      - The deduplicated BugReport to analyze
 * @param codeContext - Relevant source code extracted from the repo (optional for analyze, required for fix)
 * @param userPrompt  - Optional developer context from Slack prompt elaboration
 * @param apiKey      - Override API key (defaults to AI_API_KEY env var)
 */
export async function runAgent(
  report: BugReport,
  codeContext?: string,
  userPrompt?: string,
  apiKey?: string
): Promise<AgentResult> {
  const provider = await resolveProvider(apiKey);

  console.log(
    `[CleverBug/agent] Analyzing bug "${report.error.name}: ${report.error.message}" ` +
      `(fingerprint: ${report.fingerprint.slice(0, 8)}…)`
  );

  const analysis = await provider.analyzeBug(report, codeContext);

  console.log(
    `[CleverBug/agent] Analysis complete — severity: ${analysis.severity}, ` +
      `action: ${analysis.suggestedAction}, confidence: ${analysis.confidence.toFixed(2)}`
  );

  // Critical bugs never get an auto-fix; monitor action means "just watch, no code change needed"
  const shouldAttemptFix =
    analysis.severity !== 'critical' &&
    analysis.suggestedAction !== 'monitor' &&
    codeContext;

  if (!shouldAttemptFix) {
    if (analysis.severity === 'critical') {
      console.log('[CleverBug/agent] Critical bug — skipping fix, escalating to developer.');
    } else if (analysis.suggestedAction === 'monitor') {
      console.log('[CleverBug/agent] Action "monitor" — no fix needed.');
    } else {
      console.log('[CleverBug/agent] No code context available — skipping fix generation.');
    }
    return { analysis };
  }

  console.log(
    `[CleverBug/agent] Generating fix proposal (action: ${analysis.suggestedAction})…`
  );
  const fix = await provider.generateFix(report, codeContext, userPrompt);

  if (fix.confidence < 0.7) {
    console.warn(
      `[CleverBug/agent] Low confidence fix (${fix.confidence.toFixed(2)}) — manual review recommended.`
    );
  }

  console.log(
    `[CleverBug/agent] Fix ready — branch: "${fix.branchName}", confidence: ${fix.confidence.toFixed(2)}`
  );

  return { analysis, fix };
}
