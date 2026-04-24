import Anthropic from '@anthropic-ai/sdk';
import type { BugReport } from '../types/config.js';
import type { AIProviderClient, BugAnalysis, FixSuggestion } from './types.js';
import {
  buildAnalyzePrompt,
  buildFixPrompt,
  parseAIJson,
  SYSTEM_PROMPTS,
} from './types.js';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 2048;

export class ClaudeProvider implements AIProviderClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async analyzeBug(report: BugReport, codeContext?: string): Promise<BugAnalysis> {
    const prompt = buildAnalyzePrompt(report, codeContext);

    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPTS.analyze,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = extractText(message.content);
    return parseAIJson<BugAnalysis>(raw, 'BugAnalysis');
  }

  async generateFix(
    report: BugReport,
    codeContext: string,
    userPrompt?: string
  ): Promise<FixSuggestion> {
    const prompt = buildFixPrompt(report, codeContext, userPrompt);

    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPTS.fix,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = extractText(message.content);
    return parseAIJson<FixSuggestion>(raw, 'FixSuggestion');
  }
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export type { AIPrompt, AIResponse } from './gemini.js';
