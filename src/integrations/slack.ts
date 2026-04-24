import type { BlockAction, ButtonAction } from '@slack/bolt';
import { App } from '@slack/bolt';  
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { SlackConfig } from '../types/config.js';
import type { BugGroup } from '../core/deduplicator.js';
import type { BugAnalysis, FixSuggestion } from '../ai/types.js';
import type { PRResult } from './github.js';

// ─── Registry: persists notification state between button clicks ──────────────

interface BugNotification {
  channel: string;
  ts: string;
  bugGroup: BugGroup;
  analysis: BugAnalysis;
  fix?: FixSuggestion;
  confirmedSeverity?: BugAnalysis['severity'];
  confirmedBy?: string;
}

/** fingerprint → notification state */
const registry = new Map<string, BugNotification>();

// ─── Action IDs ───────────────────────────────────────────────────────────────

const ACTION = {
  SEVERITY_CRITICAL: 'cb_severity_critical',
  SEVERITY_MEDIUM: 'cb_severity_medium',
  SEVERITY_LOW: 'cb_severity_low',
  APPLY_FIX: 'cb_apply_fix',
  CONFIRM_FIX: 'cb_confirm_fix',
  CANCEL_FIX: 'cb_cancel_fix',
  IGNORE: 'cb_ignore',
} as const;

// ─── Block Kit builders ───────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<BugAnalysis['severity'], string> = {
  critical: '🚨',
  medium: '🟡',
  low: '🟢',
};

function headerBlock(severity: BugAnalysis['severity'], errorName: string, errorMsg: string): KnownBlock {
  const label = `${SEVERITY_EMOJI[severity]} [${severity.toUpperCase()}] ${errorName}: ${errorMsg}`;
  return {
    type: 'header',
    text: { type: 'plain_text', text: label.slice(0, 150), emoji: true },
  };
}

function statsSection(group: BugGroup): KnownBlock {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('es-ES', { timeZone: 'UTC', hour12: false });

  return {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Reportes totales:*\n${group.reportCount}` },
      { type: 'mrkdwn', text: `*Usuarios únicos:*\n${group.uniqueUserIds.length}` },
      { type: 'mrkdwn', text: `*Primera vez:*\n${fmt(group.firstSeenAt)} UTC` },
      { type: 'mrkdwn', text: `*Última vez:*\n${fmt(group.lastSeenAt)} UTC` },
    ],
  };
}

function analysisSection(analysis: BugAnalysis): KnownBlock {
  const pct = Math.round(analysis.confidence * 100);
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Análisis del agente* (confianza: ${pct}%)\n` +
        `> ${analysis.reasoning}\n\n` +
        `*Área afectada:* ${analysis.affectedArea}`,
    },
  };
}

function fixSection(fix: FixSuggestion): KnownBlock {
  const diffPreview = fix.diff.split('\n').slice(0, 8).join('\n');
  const warning = fix.confidence < 0.7 ? '\n⚠️ _Confianza baja — se recomienda revisión manual._' : '';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Fix propuesto:* \`${fix.branchName}\`\n` +
        `${fix.explanation}${warning}\n\n` +
        `\`\`\`\n${diffPreview}\n\`\`\``,
    },
  };
}

type ButtonEl = {
  type: 'button';
  text: { type: 'plain_text'; text: string; emoji: true };
  action_id: string;
  value: string;
  style?: 'danger' | 'primary';
};

function fpVal(fingerprint: string): string {
  return JSON.stringify({ fingerprint });
}

function actionButtons(fingerprint: string, analysis: BugAnalysis, fix?: FixSuggestion): KnownBlock {
  const fp = fpVal(fingerprint);

  const elements: ButtonEl[] = [
    { type: 'button', text: { type: 'plain_text', text: '🚨 Crítico', emoji: true }, action_id: ACTION.SEVERITY_CRITICAL, value: fp, style: 'danger' },
    { type: 'button', text: { type: 'plain_text', text: '🟡 Medio', emoji: true }, action_id: ACTION.SEVERITY_MEDIUM, value: fp },
    { type: 'button', text: { type: 'plain_text', text: '🟢 Bajo', emoji: true }, action_id: ACTION.SEVERITY_LOW, value: fp, style: 'primary' },
  ];

  if (fix && fix.confidence > 0.7 && analysis.severity !== 'critical') {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '✅ Aplicar fix', emoji: true },
      action_id: ACTION.APPLY_FIX,
      value: fp,
      style: 'primary',
    });
  }

  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: '❌ Ignorar', emoji: true },
    action_id: ACTION.IGNORE,
    value: fp,
    style: 'danger',
  });

  return { type: 'actions', elements };
}

function confirmFixButtons(fingerprint: string): KnownBlock {
  const fp = fpVal(fingerprint);
  const elements: ButtonEl[] = [
    { type: 'button', text: { type: 'plain_text', text: '✅ Sí, crear PR', emoji: true }, action_id: ACTION.CONFIRM_FIX, value: fp, style: 'primary' },
    { type: 'button', text: { type: 'plain_text', text: '❌ No por ahora', emoji: true }, action_id: ACTION.CANCEL_FIX, value: fp, style: 'danger' },
  ];
  return { type: 'actions', elements };
}

function buildBlocks(
  group: BugGroup,
  analysis: BugAnalysis,
  fix?: FixSuggestion,
  state?: {
    confirmedSeverity?: BugAnalysis['severity'];
    confirmedBy?: string;
    prUrl?: string;
    cancelled?: boolean;
    ignored?: boolean;
    ignoredBy?: string;
  }
): KnownBlock[] {
  const first = group.reports[0];
  const errorName = first?.error.name ?? 'Error';
  const errorMsg = first?.error.message ?? 'Unknown error';

  const blocks: KnownBlock[] = [
    headerBlock(analysis.severity, errorName, errorMsg),
    { type: 'divider' },
    statsSection(group),
    { type: 'divider' },
    analysisSection(analysis),
  ];

  if (fix) {
    blocks.push({ type: 'divider' }, fixSection(fix));
  }

  blocks.push({ type: 'divider' });

  if (state?.ignored) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🚫 Bug ignorado por <@${state.ignoredBy}>` },
    });
    return blocks;
  }

  if (state?.prUrl) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `✅ PR creada: <${state.prUrl}|Ver Pull Request>` },
    });
    return blocks;
  }

  if (state?.cancelled && state.confirmedSeverity && state.confirmedBy) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${SEVERITY_EMOJI[state.confirmedSeverity]} Severidad confirmada: *${state.confirmedSeverity.toUpperCase()}* por <@${state.confirmedBy}>\n` +
          `_Fix cancelado._`,
      },
    });
    return blocks;
  }

  if (state?.confirmedSeverity && state.confirmedBy) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${SEVERITY_EMOJI[state.confirmedSeverity]} Severidad confirmada: *${state.confirmedSeverity.toUpperCase()}* por <@${state.confirmedBy}>`,
      },
    });

    // Medium/low + good fix → ask for confirmation
    if (fix && fix.confidence > 0.7 && state.confirmedSeverity !== 'critical') {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: '¿Aplicar el fix propuesto?' } },
        confirmFixButtons(group.fingerprint)
      );
    }

    return blocks;
  }

  // Default: show action buttons
  blocks.push(actionButtons(group.fingerprint, analysis, fix));
  return blocks;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type EscalateHandler = (group: BugGroup, analysis: BugAnalysis) => Promise<void>;
export type ApplyFixHandler = (group: BugGroup, fix: FixSuggestion) => Promise<PRResult>;

/**
 * Posts a bug notification to the configured Slack channel using Block Kit.
 * Stores the notification state so action handlers can update the same message.
 */
export async function notifyBug(
  client: WebClient,
  config: SlackConfig,
  bugGroup: BugGroup,
  analysis: BugAnalysis,
  fix?: FixSuggestion
): Promise<void> {
  const first = bugGroup.reports[0];
  const fallback = `[${analysis.severity.toUpperCase()}] ${first?.error.name ?? 'Error'}: ${first?.error.message ?? 'Unknown'}`;

  const result = await client.chat.postMessage({
    channel: config.channel,
    text: fallback,
    blocks: buildBlocks(bugGroup, analysis, fix) as KnownBlock[],
  });

  if (result.ts && result.channel) {
    registry.set(bugGroup.fingerprint, {
      channel: result.channel,
      ts: result.ts,
      bugGroup,
      analysis,
      ...(fix !== undefined && { fix }),
    });
  }
}

/**
 * Registers all Slack interactive button handlers on the Bolt App.
 * Call once at startup.
 *
 * @param app         - Slack Bolt App (use socketMode: true for local dev)
 * @param onEscalate  - Called when severity=critical is confirmed
 * @param onApplyFix  - Called to create the PR; must return PRResult
 */
export function setupSlackActions(
  app: App,
  onEscalate: EscalateHandler,
  onApplyFix: ApplyFixHandler
): void {

  // ─── Shared helpers (close over `app`) ──────────────────────────────────

  async function updateMessage(
    notification: BugNotification,
    body: BlockAction,
    state?: Parameters<typeof buildBlocks>[3]
  ): Promise<void> {
    const channel = body.channel?.id ?? notification.channel;
    const ts = (body.message as { ts?: string } | undefined)?.ts ?? notification.ts;

    await app.client.chat.update({
      channel,
      ts,
      text: 'Bug actualizado',
      blocks: buildBlocks(notification.bugGroup, notification.analysis, notification.fix, state),
    });
  }

  async function createPRAndUpdate(
    notification: BugNotification,
    fingerprint: string,
    body: BlockAction
  ): Promise<void> {
    if (!notification.fix) return;

    try {
      const pr = await onApplyFix(notification.bugGroup, notification.fix);
      await updateMessage(notification, body, {
        ...(notification.confirmedSeverity !== undefined && { confirmedSeverity: notification.confirmedSeverity }),
        ...(notification.confirmedBy !== undefined && { confirmedBy: notification.confirmedBy }),
        prUrl: pr.url,
      });
      registry.delete(fingerprint);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const channel = body.channel?.id ?? notification.channel;
      const ts = (body.message as { ts?: string } | undefined)?.ts ?? notification.ts;
      await app.client.chat.update({
        channel,
        ts,
        text: `❌ Error al crear PR: ${msg}`,
      });
    }
  }

  function parseFingerprint(actionValue: string | undefined): string | undefined {
    if (!actionValue) return undefined;
    return (JSON.parse(actionValue) as { fingerprint: string }).fingerprint;
  }

  // ─── Severity handlers ───────────────────────────────────────────────────

  async function handleSeverity(
    severity: BugAnalysis['severity'],
    action: ButtonAction,
    body: BlockAction,
    ack: () => Promise<void>
  ): Promise<void> {
    await ack();
    const fingerprint = parseFingerprint(action.value);
    if (!fingerprint) return;
    const notification = registry.get(fingerprint);
    if (!notification) return;

    notification.confirmedSeverity = severity;
    notification.confirmedBy = body.user.id;

    await updateMessage(notification, body, {
      confirmedSeverity: severity,
      confirmedBy: body.user.id,
    });

    if (severity === 'critical') {
      await onEscalate(notification.bugGroup, notification.analysis);
    }
  }

  app.action(ACTION.SEVERITY_CRITICAL, async ({ action, body, ack }) => {
    await handleSeverity('critical', action as ButtonAction, body as BlockAction, ack);
  });

  app.action(ACTION.SEVERITY_MEDIUM, async ({ action, body, ack }) => {
    await handleSeverity('medium', action as ButtonAction, body as BlockAction, ack);
  });

  app.action(ACTION.SEVERITY_LOW, async ({ action, body, ack }) => {
    await handleSeverity('low', action as ButtonAction, body as BlockAction, ack);
  });

  // ─── Apply fix directly (before severity selection) ──────────────────────

  app.action(ACTION.APPLY_FIX, async ({ action, body, ack, respond }) => {
    await ack();
    const fingerprint = parseFingerprint((action as ButtonAction).value);
    if (!fingerprint) return;
    const notification = registry.get(fingerprint);
    if (!notification?.fix) return;

    await respond({
      response_type: 'ephemeral',
      text: `⏳ Aplicando fix en rama \`${notification.fix.branchName}\`…`,
    });

    await createPRAndUpdate(notification, fingerprint, body as BlockAction);
  });

  // ─── Confirm fix (after severity selection) ───────────────────────────────

  app.action(ACTION.CONFIRM_FIX, async ({ action, body, ack, respond }) => {
    await ack();
    const fingerprint = parseFingerprint((action as ButtonAction).value);
    if (!fingerprint) return;
    const notification = registry.get(fingerprint);
    if (!notification?.fix) return;

    await respond({
      response_type: 'ephemeral',
      text: `⏳ Aplicando fix en rama \`${notification.fix.branchName}\`…`,
    });

    await createPRAndUpdate(notification, fingerprint, body as BlockAction);
  });

  // ─── Cancel fix ──────────────────────────────────────────────────────────

  app.action(ACTION.CANCEL_FIX, async ({ action, body, ack }) => {
    await ack();
    const fingerprint = parseFingerprint((action as ButtonAction).value);
    if (!fingerprint) return;
    const notification = registry.get(fingerprint);
    if (!notification) return;

    await updateMessage(notification, body as BlockAction, {
      ...(notification.confirmedSeverity !== undefined && { confirmedSeverity: notification.confirmedSeverity }),
      ...(notification.confirmedBy !== undefined && { confirmedBy: notification.confirmedBy }),
      cancelled: true,
    });
  });

  // ─── Ignore ──────────────────────────────────────────────────────────────

  app.action(ACTION.IGNORE, async ({ action, body, ack }) => {
    await ack();
    const fingerprint = parseFingerprint((action as ButtonAction).value);
    if (!fingerprint) return;
    const notification = registry.get(fingerprint);
    if (!notification) return;

    await updateMessage(notification, body as BlockAction, {
      ignored: true,
      ignoredBy: (body as BlockAction).user.id,
    });

    registry.delete(fingerprint);
  });
}

/** Creates a Slack Bolt App configured for socket mode (local dev) */
export function createSlackApp(config: SlackConfig): App {
  return new App({
    token: config.token,
    socketMode: true,
    appToken: process.env['SLACK_APP_TOKEN'] ?? '',
  });
}
