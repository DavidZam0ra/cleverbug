import type { LinearConfig, BugReport, BugSeverity } from '../types/config.js';

export interface LinearTicket {
  id: string;
  url: string;
  identifier: string;
}

/**
 * Linear integration via @linear/sdk.
 * Creates tickets for critical bugs with max priority.
 */
export class LinearIntegration {
  constructor(_config: LinearConfig) {
    // TODO: initialize Linear client with apiKey
  }

  // TODO: create ticket with priority based on severity
  async createTicket(_report: BugReport, _severity: BugSeverity): Promise<LinearTicket> {
    throw new Error('Not implemented');
  }

  // TODO: update ticket with PR link once fix is created
  async linkPR(_ticketId: string, _prUrl: string): Promise<void> {
    throw new Error('Not implemented');
  }
}
