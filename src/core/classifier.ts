import type { BugReport, BugSeverity } from '../types/config.js';

export interface ClassificationResult {
  severity: BugSeverity;
  summary: string;
  suggestedOwner?: string;
  autoFixable: boolean;
  reasoning: string;
}

/**
 * Calls the AI agent to classify severity and determine
 * if the bug is auto-fixable (medium/low) or needs direct dev attention (critical).
 */
export class Classifier {
  // TODO: build prompt from BugReport + repo context
  // TODO: call AI provider (gemini or claude based on config)
  // TODO: parse structured response from AI
  async classify(_report: BugReport): Promise<ClassificationResult> {
    throw new Error('Not implemented');
  }
}
