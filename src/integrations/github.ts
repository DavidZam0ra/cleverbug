import { Octokit } from '@octokit/rest';
import type { GitHubConfig, BugReport } from '../types/config.js';
import type { FixSuggestion, BugAnalysis } from '../ai/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PRResult {
  url: string;
  number: number;
  branch: string;
  draft: boolean;
}

interface DiffChange {
  type: 'context' | 'add' | 'remove';
  content: string;
}

interface DiffHunk {
  /** 1-indexed original file start line */
  originalStart: number;
  originalLength: number;
  newStart: number;
  newLength: number;
  changes: DiffChange[];
}

interface FileDiff {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
}

// ─── Diff parser ──────────────────────────────────────────────────────────────

/**
 * Parses a unified diff string into structured FileDiff objects.
 * Handles new files (--- /dev/null), deleted files (+++ /dev/null),
 * and standard modifications.
 */
function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Split on `--- ` headers, keeping the delimiter
  const sections = diff.split(/(?=^--- )/m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split('\n');
    let lineIdx = 0;

    const oldHeader = lines[lineIdx++] ?? '';
    const newHeader = lines[lineIdx++] ?? '';

    const oldPath = oldHeader.replace(/^--- (a\/)?/, '').trim();
    const newPath = newHeader.replace(/^\+\+\+ (b\/)?/, '').trim();

    const isNew = oldPath === '/dev/null';
    const isDeleted = newPath === '/dev/null';

    const hunks: DiffHunk[] = [];

    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      if (line === undefined) { lineIdx++; continue; }

      const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunkMatch) { lineIdx++; continue; }

      lineIdx++;

      const hunk: DiffHunk = {
        originalStart: parseInt(hunkMatch[1]!, 10),
        originalLength: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3]!, 10),
        newLength: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        changes: [],
      };

      while (lineIdx < lines.length) {
        const changeLine = lines[lineIdx];
        if (changeLine === undefined || /^(---|@@|\\ No newline)/.test(changeLine)) break;

        if (changeLine.startsWith('+')) {
          hunk.changes.push({ type: 'add', content: changeLine.slice(1) });
        } else if (changeLine.startsWith('-')) {
          hunk.changes.push({ type: 'remove', content: changeLine.slice(1) });
        } else {
          // context line (space prefix or empty)
          hunk.changes.push({ type: 'context', content: changeLine.startsWith(' ') ? changeLine.slice(1) : changeLine });
        }

        lineIdx++;
      }

      hunks.push(hunk);
    }

    files.push({ oldPath, newPath, isNew, isDeleted, hunks });
  }

  return files;
}

/**
 * Applies a list of diff hunks to a file's content string.
 * Uses context lines as anchors for robustness against minor line shifts.
 * If a hunk cannot be applied cleanly, it is skipped and logged.
 */
function applyHunks(originalContent: string, hunks: DiffHunk[]): string {
  let lines = originalContent.split('\n');

  // Apply hunks in reverse order so line indices stay valid
  for (const hunk of [...hunks].reverse()) {
    const result: string[] = [];
    // Find anchor: first context line in the hunk
    const anchorContent = hunk.changes.find((c) => c.type === 'context')?.content;

    // Search for the hunk start near the declared line number (±10 lines tolerance)
    let startIdx = hunk.originalStart - 1;
    if (anchorContent !== undefined) {
      const searchStart = Math.max(0, startIdx - 10);
      const searchEnd = Math.min(lines.length - 1, startIdx + 10);
      for (let i = searchStart; i <= searchEnd; i++) {
        if (lines[i] === anchorContent) {
          startIdx = i;
          break;
        }
      }
    }

    // Lines before the hunk
    result.push(...lines.slice(0, startIdx));

    let readIdx = startIdx;
    for (const change of hunk.changes) {
      if (change.type === 'context') {
        result.push(lines[readIdx] ?? change.content);
        readIdx++;
      } else if (change.type === 'add') {
        result.push(change.content);
      } else {
        // remove — advance past the original line
        readIdx++;
      }
    }

    // Remaining lines after the hunk
    result.push(...lines.slice(readIdx));
    lines = result;
  }

  return lines.join('\n');
}

// ─── PR body builder ──────────────────────────────────────────────────────────

function buildPRBody(
  report: BugReport,
  fix: FixSuggestion,
  analysis?: BugAnalysis
): string {
  const sectionDivider = '\n---\n';
  const sections: string[] = [];

  sections.push(
    '## 🐛 Bug Report\n' +
    `- **Error:** \`${report.error.name}: ${report.error.message}\`\n` +
    `- **Source:** ${report.source}\n` +
    `- **Environment:** ${report.environment}\n` +
    `- **First seen:** ${report.timestamp}\n` +
    `- **Fingerprint:** \`${report.fingerprint.slice(0, 16)}…\``
  );

  if (report.context.url) {
    sections[0] += `\n- **URL:** ${report.context.url}`;
  }

  if (analysis) {
    sections.push(
      '## 🤖 Análisis del agente\n' +
      `- **Severidad:** ${analysis.severity}\n` +
      `- **Confianza:** ${Math.round(analysis.confidence * 100)}%\n` +
      `- **Área afectada:** ${analysis.affectedArea}\n\n` +
      `> ${analysis.reasoning}`
    );
  }

  sections.push(
    '## 🔧 Fix propuesto\n' +
    `${fix.explanation}\n\n` +
    '```diff\n' +
    `${fix.diff.slice(0, 3000)}\n` +
    '```'
  );

  const warningLines = [
    '## ⚠️ Revisar antes de mergear\n',
    '- [ ] El diff es correcto y no introduce regresiones',
    '- [ ] Los tests pasan (`npm test`)',
    '- [ ] El fix no expone información sensible',
    '- [ ] El commit message sigue las convenciones del proyecto',
  ];

  if (fix.confidence < 0.8) {
    warningLines.push(
      `\n> ⚠️ **Confianza baja (${Math.round(fix.confidence * 100)}%)** — este fix fue generado con baja certeza. Revisión manual obligatoria.`
    );
  }

  sections.push(warningLines.join('\n'));
  sections.push('*Generado automáticamente por [CleverBug](https://github.com/cleverbug)*');

  return sections.join(sectionDivider);
}

// ─── GitLab stub ─────────────────────────────────────────────────────────────

async function applyFixGitLab(_fix: FixSuggestion, _report: BugReport): Promise<PRResult> {
  // GitLab uses a different API (Merge Requests, not Pull Requests).
  // Requires @gitbeaker/rest. Planned for v2.
  throw new Error(
    '[CleverBug] GitLab support is planned for v2. ' +
    'Use platform: "github" or contribute the GitLab adapter at src/integrations/github.ts.'
  );
}

// ─── Main implementation ──────────────────────────────────────────────────────

interface RepoCoords {
  owner: string;
  repo: string;
}

function parseRepo(repoStr: string): RepoCoords {
  const [owner, repo] = repoStr.split('/');
  if (!owner || !repo) throw new Error(`[CleverBug] Invalid repo format: "${repoStr}"`);
  return { owner, repo };
}

/**
 * Parses a stack trace and returns unique repo-relative source file paths,
 * excluding node_modules and Node.js internals.
 *
 * Handles:
 *   - Unix absolute:   /home/user/project/src/index.ts:10:5
 *   - Windows absolute: D:\project\src\index.ts:10:5  or  D:/project/src/index.ts:10:5
 *   - Relative:        src/checkout/index.ts:42:7
 *
 * Absolute paths are converted to relative by stripping the cwd prefix.
 */
export function listRelevantFiles(stackTrace: string, cwd?: string): string[] {
  const base = (cwd ?? process.cwd()).replace(/\\/g, '/').replace(/\/$/, '');

  // Normalise the entire stack trace to forward slashes once
  const normalised = stackTrace.replace(/\\/g, '/');

  // Match anything that looks like a file path before :line:col
  // Covers: absolute Unix, absolute Windows (C:/...), relative paths
  const pattern = /(?:\(|at\s+)([A-Za-z]?:?(?:\/[^/\s()\n:]+)+\.[a-z]{1,5}):\d+:\d+/gm;

  const found = new Set<string>();

  for (const match of normalised.matchAll(pattern)) {
    let p = match[1];
    if (!p) continue;
    if (p.includes('node_modules') || p.startsWith('node:')) continue;

    // Strip cwd prefix to get repo-relative path
    if (p.startsWith(base + '/')) {
      p = p.slice(base.length + 1);
    } else if (p.startsWith('/')) {
      // Unknown absolute path — skip, can't map to repo
      continue;
    }

    found.add(p);
  }

  return [...found];
}

/**
 * Reads a single file from the repo at the default branch.
 */
export async function readFileContent(
  config: GitHubConfig,
  filePath: string
): Promise<string> {
  if (config.platform === 'gitlab') {
    throw new Error('[CleverBug] GitLab readFileContent not yet implemented.');
  }

  const octokit = new Octokit({ auth: config.token });
  const { owner, repo } = parseRepo(config.repo);

  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref: config.defaultBranch,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`[CleverBug] "${filePath}" is not a file.`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/**
 * Applies an AI-generated fix to the repository by:
 *  1. Creating a new branch from the default branch
 *  2. Parsing fix.diff to identify changed files
 *  3. Fetching current file contents, applying patches, committing via git tree API
 *  4. Opening a Draft PR if confidence < 0.8, regular PR otherwise
 *
 * NEVER merges. The PR requires human review.
 */
export async function applyFix(
  config: GitHubConfig,
  fix: FixSuggestion,
  report: BugReport,
  analysis?: BugAnalysis
): Promise<PRResult> {
  if (config.platform === 'gitlab') {
    return applyFixGitLab(fix, report);
  }

  const octokit = new Octokit({ auth: config.token });
  const { owner, repo } = parseRepo(config.repo);
  const baseBranch = config.defaultBranch;

  // ── 1. Get base branch SHA ──────────────────────────────────────────────

  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  const baseSha = refData.object.sha;

  const { data: baseCommit } = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  const baseTreeSha = baseCommit.tree.sha;

  // ── 2. Create branch ────────────────────────────────────────────────────

  const branchName = fix.branchName;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  console.log(`[CleverBug/github] Branch created: ${branchName}`);

  // ── 3. Parse diff and build new tree ────────────────────────────────────

  const fileDiffs = parseDiff(fix.diff);

  if (fileDiffs.length === 0) {
    throw new Error('[CleverBug] fix.diff produced no parseable file changes.');
  }

  const treeEntries: Array<{
    path: string;
    mode: '100644';
    type: 'blob';
    sha?: string;
    content?: string;
  }> = [];

  for (const fileDiff of fileDiffs) {
    const targetPath = fileDiff.isNew
      ? fileDiff.newPath
      : fileDiff.oldPath === '/dev/null'
        ? fileDiff.newPath
        : fileDiff.oldPath;

    if (fileDiff.isDeleted) {
      // Deletion: omit from tree (GitHub handles via null sha, use blob approach)
      console.log(`[CleverBug/github] Deleting: ${targetPath}`);
      // Deleted files are represented by absence from the new tree — handled below
      continue;
    }

    let newContent: string;

    if (fileDiff.isNew) {
      // New file: collect all added lines
      newContent = fileDiff.hunks
        .flatMap((h) => h.changes.filter((c) => c.type === 'add').map((c) => c.content))
        .join('\n');
    } else {
      // Modified file: fetch current content and apply patches
      let current = '';
      try {
        current = await readFileContent(config, targetPath);
      } catch {
        console.warn(`[CleverBug/github] Could not fetch ${targetPath} — treating as empty.`);
      }
      newContent = applyHunks(current, fileDiff.hunks);
    }

    treeEntries.push({
      path: targetPath,
      mode: '100644',
      type: 'blob',
      content: newContent,
    });
  }

  if (treeEntries.length === 0) {
    throw new Error('[CleverBug] No files to commit after applying diff.');
  }

  // ── 4. Create git tree, commit, update ref ───────────────────────────────

  const { data: newTree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message: fix.commitMessage,
    tree: newTree.sha,
    parents: [baseSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha,
  });

  console.log(`[CleverBug/github] Committed: ${newCommit.sha.slice(0, 8)} → ${branchName}`);

  // ── 5. Ensure labels exist ───────────────────────────────────────────────

  const severity = analysis?.severity ?? 'low';
  const labels = ['cleverbug', 'bug', severity];

  for (const label of labels) {
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: label,
        color: label === 'cleverbug' ? '0075ca'
          : label === 'bug' ? 'd73a4a'
          : label === 'critical' ? 'b60205'
          : label === 'medium' ? 'e4e669'
          : '0e8a16',
      });
    } catch {
      // Label already exists — that's fine
    }
  }

  // ── 6. Open PR ───────────────────────────────────────────────────────────

  const isDraft = fix.confidence < 0.8;

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: `[CleverBug] ${fix.commitMessage}`,
    body: buildPRBody(report, fix, analysis),
    head: branchName,
    base: baseBranch,
    draft: isDraft,
  });

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: pr.number,
    labels,
  });

  console.log(
    `[CleverBug/github] PR #${pr.number} opened${isDraft ? ' (draft)' : ''}: ${pr.html_url}`
  );

  return {
    url: pr.html_url,
    number: pr.number,
    branch: branchName,
    draft: isDraft,
  };
}
