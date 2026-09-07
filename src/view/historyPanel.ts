/**
 * The history pane: a `HistoryModel` in, a page of commits out.
 *
 * A webview rather than a tree, for the same reason the list above it is one: a
 * commit row is a hash, a date, an author, a subject and a run of ref chips,
 * and a `TreeItem` has two text slots. Rendering that as `label` plus
 * `description` puts the subject - the only part worth reading at a glance -
 * behind the metadata, and drops the chips entirely.
 *
 * Every judgement is made in `view/historyRow.ts`, which imports no `vscode`.
 * This file places strings.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import type { CommitRefKind, HistoryModel } from '../model/types.ts';
import { buildCommits, buildFiles, type RenderedCommit } from './historyRow.ts';
import { escapeHtml } from './listPanel.ts';

export type HistoryRequest =
  /** Expand or collapse a commit's file list. */
  | { readonly type: 'expand'; readonly sha: string }
  /** Open one file of a commit in the editor's diff. */
  | { readonly type: 'diff'; readonly sha: string; readonly path: string }
  /** Ask for the next page. */
  | { readonly type: 'more' };

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'repoLedger.history';

  private readonly requested = new vscode.EventEmitter<HistoryRequest>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  private model: HistoryModel = { status: { kind: 'no-selection' }, busy: false };

  readonly onDidRequest: vscode.Event<HistoryRequest> = this.requested.event;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(new vscode.Disposable(() => this.dispose()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.listeners.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
        }
      }),
    );
    this.render();
  }

  setModel(model: HistoryModel): void {
    this.model = model;
    this.render();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.listeners.splice(0, this.listeners.length)) {
      listener.dispose();
    }
    this.requested.dispose();
    this.view = undefined;
  }

  private render(): void {
    if (this.view && !this.disposed) {
      this.view.webview.html = renderHistoryHtml(this.model, createNonce());
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const payload = message as Record<string, unknown>;
    switch (payload['type']) {
      case 'more':
        this.requested.fire({ type: 'more' });
        return;
      case 'expand':
        if (typeof payload['sha'] === 'string') {
          this.requested.fire({ type: 'expand', sha: payload['sha'] });
        }
        return;
      case 'diff':
        if (typeof payload['sha'] === 'string' && typeof payload['path'] === 'string') {
          this.requested.fire({ type: 'diff', sha: payload['sha'], path: payload['path'] });
        }
        return;
      default:
        return;
    }
  }
}

function createNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

const REF_TITLES: Record<CommitRefKind, string> = {
  head: 'where HEAD is',
  branch: 'a local branch',
  remote: 'a remote-tracking branch',
  tag: 'a tag',
};

function renderCommit(commit: RenderedCommit, model: HistoryModel): string {
  const open = model.expanded === commit.sha;
  const chips = commit.refs
    .map(
      (ref) =>
        `<span class="ref ${ref.kind}" title="${escapeHtml(REF_TITLES[ref.kind])}">` +
        `${escapeHtml(ref.name)}</span>`,
    )
    .join('');

  // Marked only when the set was established. A commit that nobody checked
  // carries no mark rather than an absent one that reads as "pushed".
  const unpushed = commit.unpushed
    ? '<span class="unpushed" title="Exists on no remote this repository knows about">only here</span>'
    : '';

  const merge =
    commit.mergeOf !== undefined
      ? `<span class="merge" title="A merge; its changes belong to its parents">merge of ${commit.mergeOf}</span>`
      : '';

  const files = open ? renderFiles(commit, model) : '';

  return `<div class="commit${open ? ' open' : ''}">
<button type="button" class="commit-main" data-sha="${escapeHtml(commit.sha)}"
 title="${escapeHtml(commit.tooltip)}" aria-expanded="${open ? 'true' : 'false'}">
<span class="c1"><span class="sha">${escapeHtml(commit.shortSha)}</span><span class="age">${escapeHtml(commit.age)}</span><span class="author">${escapeHtml(commit.author)}</span>${unpushed}${merge}</span>
<span class="c2">${escapeHtml(commit.subject)}</span>
${chips.length > 0 ? `<span class="refs">${chips}</span>` : ''}
</button>
${files}
</div>`;
}

function renderFiles(commit: RenderedCommit, model: HistoryModel): string {
  if (commit.mergeOf !== undefined) {
    return `<div class="files"><p class="note">A merge brings no changes of its own. Open one of its ${commit.mergeOf} parents to see what came in.</p></div>`;
  }
  if (model.files === undefined) {
    return `<div class="files"><p class="note">Reading…</p></div>`;
  }
  if (model.files.length === 0) {
    return `<div class="files"><p class="note">This commit changed no files.</p></div>`;
  }
  const rows = buildFiles(model.files)
    .map(
      (file) =>
        `<button type="button" class="file" data-sha="${escapeHtml(commit.sha)}"` +
        ` data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.tooltip)}">` +
        `<span class="st ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>` +
        `<span class="dir">${escapeHtml(file.directory)}</span>` +
        `<span class="fname">${escapeHtml(file.name)}</span></button>`,
    )
    .join('');
  return `<div class="files">${rows}</div>`;
}

function renderEmpty(model: HistoryModel): string {
  switch (model.status.kind) {
    case 'no-selection':
      return `<div class="empty"><p>Select a repository above.</p>
<p class="hint">Its recent commits appear here, so reading a repository’s past never means opening it.</p></div>`;
    case 'reading':
      return `<div class="empty"><p>Reading ${escapeHtml(model.status.label)}…</p></div>`;
    case 'unborn':
      return `<div class="empty"><p><strong>${escapeHtml(model.status.label)}</strong> has no commits yet.</p>
<p class="hint">There is nothing to show until something is committed.</p></div>`;
    case 'unreadable':
      return `<div class="empty"><p><strong>${escapeHtml(model.status.label)}</strong> could not be read.</p>
<pre class="why">${escapeHtml(model.status.reason)}</pre></div>`;
    case 'ready':
      return '';
  }
}

export function renderHistoryHtml(model: HistoryModel, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const page = model.page;
  const commits =
    page && page.commits.length > 0
      ? buildCommits(page.commits, Date.now(), page.unpushedKnown)
          .map((commit) => renderCommit(commit, model))
          .join('')
      : '';

  const header =
    page && page.commits.length > 0
      ? `<header class="head"><span class="where">${escapeHtml(page.label)}</span>` +
        `${model.busy ? BUSY : ''}</header>`
      : '';

  const more =
    page?.more === true
      ? `<div class="more"><button type="button" class="link" data-more="1">Show more</button></div>`
      : '';

  const body =
    commits.length > 0
      ? `${header}<div class="commits">${commits}</div>${more}`
      : renderEmpty(model);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>History</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const BUSY = '<span class="busy" role="status" aria-label="Reading"></span>';

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  margin: 0;
  padding: 0 0 10px;
  line-height: 1.35;
}
p { margin: 0 0 6px; }
.head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}
.where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.busy {
  width: 8px; height: 8px; flex: none; border-radius: 50%;
  background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: 0.25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .busy { animation: none; opacity: 0.8; } }
.commits { display: flex; flex-direction: column; }
.commit + .commit { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.16)); }
.commit.open { background: var(--vscode-list-hoverBackground); }
.commit-main {
  display: grid;
  row-gap: 2px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 5px 10px 6px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.commit-main:hover { background: var(--vscode-list-hoverBackground); }
.commit-main:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.c1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 0.88em;
  color: var(--vscode-descriptionForeground);
}
.sha {
  flex: none;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-textLink-foreground);
}
.age { flex: none; font-variant-numeric: tabular-nums; }
.author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Named in words, because "only here" is the fact worth acting on and an arrow
   would make the reader learn a glyph to find it. */
.unpushed {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--vscode-charts-blue, #4a8cd8);
  color: var(--vscode-editor-background);
  font-size: 0.92em;
}
.merge { flex: none; opacity: 0.8; }
.c2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.refs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.ref {
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.82em;
  font-family: var(--vscode-editor-font-family);
  white-space: nowrap;
}
.ref.head { color: var(--vscode-charts-green, #7fb98b); }
.ref.branch { color: var(--vscode-charts-blue, #4a8cd8); }
.ref.remote { color: var(--vscode-descriptionForeground); }
.ref.tag { color: var(--vscode-charts-yellow, #d0a54a); }
.files { display: flex; flex-direction: column; padding: 0 10px 7px 10px; }
.note { margin: 2px 0 4px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.file {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 0;
  padding: 2px 6px;
  border: none;
  border-radius: 3px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.9em;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.file:hover { background: var(--vscode-toolbar-hoverBackground); }
.file:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.st {
  flex: none;
  width: 1.4em;
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-descriptionForeground);
}
.st.A { color: var(--vscode-charts-green, #7fb98b); }
.st.M { color: var(--vscode-charts-yellow, #d0a54a); }
.st.D { color: var(--vscode-charts-red, #d97a6a); }
.st.R, .st.C { color: var(--vscode-charts-blue, #4a8cd8); }
.dir { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.55; }
.fname { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 12px 12px 0; max-width: 60ch; }
.empty .hint { color: var(--vscode-descriptionForeground); }
.why {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--vscode-list-errorForeground, #d97a6a);
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  font-family: var(--vscode-editor-font-family);
  font-size: 0.86em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.more { padding: 6px 12px; }
.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.link:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
`;

const SCRIPT = `
const api = acquireVsCodeApi();
const saved = api.getState();
if (saved && typeof saved.scrollTop === 'number') {
  window.scrollTo(0, saved.scrollTop);
}
window.addEventListener('scroll', () => {
  api.setState({ scrollTop: window.scrollY });
}, { passive: true });

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }

  const file = target.closest('button.file');
  if (file) {
    api.postMessage({
      type: 'diff',
      sha: file.getAttribute('data-sha'),
      path: file.getAttribute('data-path'),
    });
    return;
  }

  if (target.closest('button[data-more]')) {
    api.postMessage({ type: 'more' });
    return;
  }

  const commit = target.closest('button.commit-main');
  if (commit) {
    api.postMessage({ type: 'expand', sha: commit.getAttribute('data-sha') });
  }
});
`;
