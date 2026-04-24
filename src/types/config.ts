import { z } from 'zod';

export const SlackConfigSchema = z.object({
  token: z.string().min(1),
  channel: z.string().min(1),
});

export const GitHubConfigSchema = z.object({
  token: z.string().min(1),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'repo must be "owner/repo"'),
  platform: z.enum(['github', 'gitlab']).default('github'),
  defaultBranch: z.string().default('main'),
});

export const NotionConfigSchema = z.object({
  token: z.string().min(1),
  databaseId: z.string().min(1),
});

export const LinearConfigSchema = z.object({
  apiKey: z.string().min(1),
  teamId: z.string().min(1),
});

export const AIConfigSchema = z.object({
  provider: z.enum(['gemini', 'claude']),
  apiKey: z.string().min(1),
});

export const AITriggerSchema = z.object({
  minUniqueReports: z.number().int().positive().default(1),
  timeWindow: z.string().default('1h'),
});

export const EndUserReportingSchema = z.object({
  enabled: z.boolean().default(false),
  allowedIf: z.function().args(z.any()).returns(z.boolean()).optional(),
});

export const CleverBugConfigSchema = z.object({
  slack: SlackConfigSchema,
  github: GitHubConfigSchema,
  notion: NotionConfigSchema.optional(),
  linear: LinearConfigSchema.optional(),
  ai: AIConfigSchema,
  aiTrigger: AITriggerSchema.optional(),
  endUserReporting: EndUserReportingSchema.optional(),
  environments: z.array(z.string()).default(['staging', 'qa', 'production']),
});

export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type LinearConfig = z.infer<typeof LinearConfigSchema>;
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type AITrigger = z.infer<typeof AITriggerSchema>;
export type EndUserReporting = z.infer<typeof EndUserReportingSchema>;
export type CleverBugConfig = z.infer<typeof CleverBugConfigSchema>;

export type AIProvider = 'gemini' | 'claude';

export type BugSeverity = 'critical' | 'medium' | 'low';

export type BugSource = 'sentry' | 'posthog' | 'manual' | 'synthetic';

export type UserRole = 'admin' | 'developer' | 'qa' | 'manager';

export type EndUserLevel = 'normal' | 'verified' | 'beta';

export interface EndUser {
  userId: string;
  email?: string;
  plan?: string;
  isBetaTester?: boolean;
  [key: string]: unknown;
}

export interface BugErrorInfo {
  message: string;
  stack?: string;
  name: string;
}

export interface NetworkRequest {
  method: string;
  url: string;
  status?: number;
  responseTime?: number;
  timestamp: string;
}

/** @deprecated Use NetworkRequest */
export interface ApiCall {
  method: string;
  url: string;
  status: number;
  responseTime: number;
  timestamp: Date;
}

export interface BugContext {
  url?: string;
  userId?: string;
  userEmail?: string;
  userPlan?: string;
  isBetaTester?: boolean;
  browser?: string;
  device?: string;
  userAgent?: string;
  consoleLogs?: string[];
  networkRequests?: NetworkRequest[];
  screenshot?: string;
  /** @deprecated Use networkRequests */
  apiCalls?: ApiCall[];
  lastClicks?: string[];
}

export interface BugReport {
  id: string;
  timestamp: string;
  source: BugSource;
  severity?: BugSeverity;
  fingerprint: string;
  error: BugErrorInfo;
  context: BugContext;
  reportCount: number;
  uniqueUserCount: number;
  environment: string;
}
