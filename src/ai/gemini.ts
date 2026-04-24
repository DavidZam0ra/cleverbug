import { GoogleGenerativeAI } from '@google/generative-ai';
import type { BugReport } from '../types/config.js';
import type { AIProviderClient, BugAnalysis, FixSuggestion } from './types.js';
import {
  buildAnalyzePrompt,
  buildFixPrompt,
  parseAIJson,
  SYSTEM_PROMPTS,
} from './types.js';

/** Primary model; fallback used automatically on 503/overload errors */
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const;

async function generateWithFallback(
  client: GoogleGenerativeAI,
  systemInstruction: string,
  prompt: string
): Promise<string> {
  let lastError: unknown;

  for (const modelId of MODELS) {
    try {
      const model = client.getGenerativeModel({ model: modelId, systemInstruction });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = msg.includes('503') || msg.includes('overloaded') || msg.includes('high demand') || msg.includes('404');
      if (isRetryable) {
        console.warn(`[CleverBug/gemini] ${modelId} unavailable (${msg.slice(0, 80)}), trying fallback…`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export class GeminiProvider implements AIProviderClient {
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async analyzeBug(report: BugReport, codeContext?: string): Promise<BugAnalysis> {
    const prompt = buildAnalyzePrompt(report, codeContext);
    const raw = await generateWithFallback(this.client, SYSTEM_PROMPTS.analyze, prompt);
    return parseAIJson<BugAnalysis>(raw, 'BugAnalysis');
  }

  async generateFix(
    report: BugReport,
    codeContext: string,
    userPrompt?: string
  ): Promise<FixSuggestion> {
    const prompt = buildFixPrompt(report, codeContext, userPrompt);
    const raw = await generateWithFallback(this.client, SYSTEM_PROMPTS.fix, prompt);
    return parseAIJson<FixSuggestion>(raw, 'FixSuggestion');
  }
}

// Keep old interface for backward compatibility with any existing code
export interface AIPrompt {
  system: string;
  user: string;
}

export interface AIResponse {
  content: string;
  model: string;
  tokensUsed: number;
}
