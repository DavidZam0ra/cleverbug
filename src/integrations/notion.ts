import { Client } from '@notionhq/client';
import type { NotionConfig } from '../types/config.js';
import type { BugGroup } from '../core/deduplicator.js';
import type { BugAnalysis, FixSuggestion } from '../ai/types.js';
import type { PRResult } from './github.js';

export interface NotionPage {
  id: string;
  url: string;
}

// ─── Notion block helpers ─────────────────────────────────────────────────────

// Notion limits: 2000 chars per rich_text item, 100 children per request.
const RICH_TEXT_MAX = 2000;
const CHILDREN_PER_REQUEST = 100;

type RichText = { type: 'text'; text: { content: string }; annotations?: Record<string, boolean> };
type Block = Record<string, unknown>;

function richText(content: string, bold = false): RichText[] {
  // Split content into ≤2000 char chunks
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_MAX) {
    chunks.push({
      type: 'text',
      text: { content: content.slice(i, i + RICH_TEXT_MAX) },
      ...(bold ? { annotations: { bold: true } } : {}),
    });
  }
  return chunks.length > 0 ? chunks : [{ type: 'text', text: { content: '' } }];
}

function heading2(text: string): Block {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(text) } };
}

function heading3(text: string): Block {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(text) } };
}

function paragraph(text: string, bold = false): Block {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text, bold) } };
}

function divider(): Block {
  return { object: 'block', type: 'divider', divider: {} };
}

/**
 * Code blocks are limited to 2000 chars per rich_text segment.
 * For longer content, we create multiple consecutive code blocks.
 */
function codeBlocks(content: string, language = 'plain text'): Block[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_MAX) {
    chunks.push(content.slice(i, i + RICH_TEXT_MAX));
  }
  if (chunks.length === 0) chunks.push('');

  return chunks.map((chunk) => ({
    object: 'block',
    type: 'code',
    code: {
      language,
      rich_text: [{ type: 'text', text: { content: chunk } }],
    },
  }));
}

function callout(text: string, emoji = '📝'): Block {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji },
      rich_text: richText(text),
    },
  };
}

function bulletItem(text: string): Block {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(text) },
  };
}

// ─── Page body builder ────────────────────────────────────────────────────────

function buildPageBlocks(
  bugGroup: BugGroup,
  analysis: BugAnalysis,
  fix?: FixSuggestion,
  pr?: PRResult
): Block[] {
  const firstReport = bugGroup.reports[0];
  const blocks: Block[] = [];

  // ── Bug summary ─────────────────────────────────────────────────────────

  blocks.push(heading2('🐛 Resumen del bug'));
  blocks.push(bulletItem(`Error: ${firstReport?.error.name ?? 'Unknown'}: ${firstReport?.error.message ?? 'Unknown'}`));
  blocks.push(bulletItem(`Fuente: ${firstReport?.source ?? 'unknown'}`));
  blocks.push(bulletItem(`Entorno: ${firstReport?.environment ?? 'unknown'}`));
  blocks.push(bulletItem(`Reportes totales: ${bugGroup.reportCount} (${bugGroup.uniqueUserIds.length} usuarios únicos)`));
  blocks.push(bulletItem(`Primera vez: ${bugGroup.firstSeenAt}`));
  blocks.push(bulletItem(`Última vez: ${bugGroup.lastSeenAt}`));
  blocks.push(bulletItem(`Fingerprint: ${bugGroup.fingerprint}`));

  if (firstReport?.context.url) {
    blocks.push(bulletItem(`URL: ${firstReport.context.url}`));
  }

  // ── Stack trace ─────────────────────────────────────────────────────────

  blocks.push(divider());
  blocks.push(heading2('📋 Stack Trace'));

  const stack = firstReport?.error.stack ?? firstReport?.error.message ?? 'No stack trace available';
  blocks.push(...codeBlocks(stack, 'javascript'));

  // ── Agent analysis ──────────────────────────────────────────────────────

  blocks.push(divider());
  blocks.push(heading2('🤖 Análisis del Agente'));
  blocks.push(bulletItem(`Severidad: ${analysis.severity.toUpperCase()}`));
  blocks.push(bulletItem(`Confianza: ${Math.round(analysis.confidence * 100)}%`));
  blocks.push(bulletItem(`Área afectada: ${analysis.affectedArea}`));
  blocks.push(bulletItem(`Acción sugerida: ${analysis.suggestedAction}`));
  blocks.push(paragraph(analysis.reasoning));

  // ── Fix applied ─────────────────────────────────────────────────────────

  if (fix) {
    blocks.push(divider());
    blocks.push(heading2('🔧 Fix Aplicado'));
    blocks.push(bulletItem(`Rama: ${fix.branchName}`));
    blocks.push(bulletItem(`Commit: ${fix.commitMessage}`));
    blocks.push(bulletItem(`Confianza del fix: ${Math.round(fix.confidence * 100)}%`));
    blocks.push(paragraph(fix.explanation));
    blocks.push(heading3('Diff'));
    blocks.push(...codeBlocks(fix.diff, 'diff'));

    if (pr) {
      blocks.push(bulletItem(`PR: ${pr.url}`));
      if (pr.draft) {
        blocks.push(callout('Esta PR fue creada como borrador por baja confianza. Requiere revisión manual antes de mergear.', '⚠️'));
      }
    }
  }

  // ── Console logs ────────────────────────────────────────────────────────

  const consoleLogs = firstReport?.context.consoleLogs;
  if (consoleLogs && consoleLogs.length > 0) {
    blocks.push(divider());
    blocks.push(heading2('🖥️ Console Logs (últimos 30s)'));
    blocks.push(...codeBlocks(consoleLogs.join('\n'), 'plain text'));
  }

  // ── Network requests ────────────────────────────────────────────────────

  const netReqs = firstReport?.context.networkRequests;
  if (netReqs && netReqs.length > 0) {
    blocks.push(divider());
    blocks.push(heading2('🌐 Llamadas de Red'));
    const summary = netReqs
      .map((r) => `${r.method} ${r.url} → ${r.status ?? '?'} (${r.responseTime ?? '?'}ms)`)
      .join('\n');
    blocks.push(...codeBlocks(summary, 'plain text'));
  }

  // ── Postmortem (empty for dev to fill) ──────────────────────────────────

  blocks.push(divider());
  blocks.push(heading2('📝 Postmortem'));
  blocks.push(
    callout(
      'Completa esta sección después de resolver el bug: causa raíz, impacto, acciones correctivas y preventivas.',
      '📝'
    )
  );
  blocks.push(heading3('Causa raíz'));
  blocks.push(paragraph(' '));
  blocks.push(heading3('Impacto'));
  blocks.push(paragraph(' '));
  blocks.push(heading3('Acciones correctivas'));
  blocks.push(paragraph(' '));
  blocks.push(heading3('Acciones preventivas'));
  blocks.push(paragraph(' '));

  return blocks;
}

// ─── Notion property builders ─────────────────────────────────────────────────

const SEVERITY_MAP: Record<BugAnalysis['severity'], string> = {
  critical: 'Crítico',
  medium: 'Medio',
  low: 'Bajo',
};

function buildProperties(
  bugGroup: BugGroup,
  analysis: BugAnalysis,
  fix?: FixSuggestion,
  pr?: PRResult
): Record<string, unknown> {
  const firstReport = bugGroup.reports[0];
  const title = `${firstReport?.error.name ?? 'Error'}: ${firstReport?.error.message ?? 'Unknown error'}`.slice(0, 200);

  const props: Record<string, unknown> = {
    'Bug title': { title: [{ text: { content: title } }] },
    'Severity': { select: { name: SEVERITY_MAP[analysis.severity] } },
    'Status': { select: { name: pr ? 'Resuelto' : 'Detectado' } },
    'Affected users': { number: bugGroup.uniqueUserIds.length },
    'First seen': { date: { start: bugGroup.firstSeenAt.slice(0, 10) } },
    'Auto-fixed': { checkbox: pr !== undefined },
  };

  if (pr) {
    props['PR link'] = { url: pr.url };
  }

  return props;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates (or could update) a Notion database page documenting the bug.
 *
 * Page properties follow the expected schema:
 *   Bug title (title), Severity (select), Status (select),
 *   Affected users (number), First seen (date),
 *   PR link (url), Auto-fixed (checkbox)
 *
 * Page body: stack trace, agent analysis, fix diff, empty postmortem section.
 *
 * Handles Notion's 100-children-per-request and 2000-char-per-rich-text limits.
 */
export async function documentBug(
  config: NotionConfig,
  bugGroup: BugGroup,
  analysis: BugAnalysis,
  fix?: FixSuggestion,
  pr?: PRResult
): Promise<NotionPage> {
  const notion = new Client({ auth: config.token });

  const allBlocks = buildPageBlocks(bugGroup, analysis, fix, pr);

  // First 100 blocks go in the create call; rest appended after
  const firstBatch = allBlocks.slice(0, CHILDREN_PER_REQUEST);
  const remaining = allBlocks.slice(CHILDREN_PER_REQUEST);

  type CreateParams = Parameters<typeof notion.pages.create>[0];
  type ChildrenType = Exclude<CreateParams['children'], undefined>;

  const page = await notion.pages.create({
    parent: { type: 'database_id', database_id: config.databaseId },
    properties: buildProperties(bugGroup, analysis, fix, pr) as CreateParams['properties'],
    children: firstBatch as ChildrenType,
  });

  // Append remaining blocks in batches
  for (let i = 0; i < remaining.length; i += CHILDREN_PER_REQUEST) {
    const batch = remaining.slice(i, i + CHILDREN_PER_REQUEST);
    await notion.blocks.children.append({
      block_id: page.id,
      children: batch as Parameters<typeof notion.blocks.children.append>[0]['children'],
    });
  }

  const pageUrl = 'url' in page ? (page.url as string) : `https://notion.so/${page.id.replace(/-/g, '')}`;

  console.log(`[CleverBug/notion] Page created: ${pageUrl}`);

  return { id: page.id, url: pageUrl };
}
