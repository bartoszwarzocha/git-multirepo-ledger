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

import type { ActivityEntryView, CommitRefKind, HistoryModel } from '../model/types.ts';
import { buildCommits, buildFiles, commitKind, fileCountText, type RenderedCommit } from './historyRow.ts';
import { escapeHtml } from './listPanel.ts';

export type HistoryRequest =
  /** Expand or collapse a commit's file list. */
  | { readonly type: 'expand'; readonly sha: string }
  /** Open one file of a commit in the editor's diff. */
  | { readonly type: 'diff'; readonly sha: string; readonly path: string }
  /** Ask for the next page. */
  | { readonly type: 'more' }
  /** Switch the pane between the selected repository and every repository. */
  | { readonly type: 'scope'; readonly scope: string }
  /** Open one commit of the digest, which lives in a repository of its own. */
  | { readonly type: 'openAt'; readonly repositoryPath: string; readonly sha: string }
  /** Open the same period as a document, in the editor. */
  | { readonly type: 'report' };

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'repoLedger.history';

  private readonly requested = new vscode.EventEmitter<HistoryRequest>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  private model: HistoryModel = { mode: 'selected', status: { kind: 'no-selection' }, busy: false };

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

  /**
   * Expand the pane, without taking the focus.
   *
   * The list above is driven by selection and this pane is the whole of what a
   * selection does, so a reader whose History section is collapsed - which is a
   * state the editor remembers between windows - clicks a row and sees nothing.
   * `show(true)` preserves focus, so the click does not move the caret out of
   * the list the reader is still scanning.
   *
   * Silent when the view has never been resolved: the editor resolves it on
   * first reveal and it will render the current model then, so there is nothing
   * to recover from here.
   */
  reveal(): void {
    this.view?.show?.(true);
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
      case 'scope':
        if (typeof payload['scope'] === 'string') {
          this.requested.fire({ type: 'scope', scope: payload['scope'] });
        }
        return;
      case 'report':
        this.requested.fire({ type: 'report' });
        return;
      case 'openAt':
        if (
          typeof payload['repositoryPath'] === 'string' &&
          typeof payload['sha'] === 'string'
        ) {
          this.requested.fire({
            type: 'openAt',
            repositoryPath: payload['repositoryPath'],
            sha: payload['sha'],
          });
        }
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

  return `<div class="commit kind-${commitKind(commit)}${open ? ' open' : ''}">
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
  const count = `<p class="note">${escapeHtml(fileCountText(model.files.length))}</p>`;
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
  return `<div class="files">${count}${rows}</div>`;
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


/**
 * The scope switch, and it is the only control this pane has.
 *
 * `Selected` is the default because the pane sits directly under the board and
 * a reader who has just clicked a row expects to see that row's commits. `All`
 * widens the same list to every repository above it, over the same period and
 * the same filters, which are set on the board because they govern the report
 * too.
 *
 * Two positions rather than five, and no period among them: the strip used to
 * carry both scope and period as though they were one choice, so the reader had
 * four buttons for five states and none of them said which state they were in.
 */
function renderScope(model: HistoryModel): string {
  const button = (value: string, label: string, title: string): string => {
    const on = model.mode === value;
    return (
      `<button type="button" class="scope${on ? ' on' : ''}" data-scope="${escapeHtml(value)}"` +
      ` title="${escapeHtml(title)}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(label)}</button>`
    );
  };
  const where =
    model.mode === 'selected' && model.selectedLabel !== undefined
      ? `<span class="scope-where">${escapeHtml(model.selectedLabel)}</span>`
      : '';
  return (
    `<nav class="scopes" role="group" aria-label="Whose commits">` +
    button('selected', 'Selected', 'Commits from the repository selected above') +
    button('all', 'All', 'Commits from every repository above') +
    `${where}</nav>`
  );
}

function renderActivityEntry(entry: ActivityEntryView): string {
  return (
    `<button type="button" class="act${entry.merge ? ' merge' : ''}"` +
    ` data-repo="${escapeHtml(entry.repositoryPath)}" data-sha="${escapeHtml(entry.sha)}"` +
    ` title="${escapeHtml(`${entry.subject}\n\n${entry.shortSha} · ${entry.author} · ${entry.label}`)}">` +
    `<span class="a1"><span class="time">${escapeHtml(entry.time)}</span>` +
    `<span class="repo">${escapeHtml(entry.label)}</span>` +
    `<span class="who">${escapeHtml(entry.author)}</span>` +
    `${entry.merge ? '<span class="tag-merge">merge</span>' : ''}</span>` +
    `<span class="a2">${escapeHtml(entry.subject)}</span></button>`
  );
}

function renderActivity(model: HistoryModel): string {
  const view = model.activity;
  if (!view) {
    return '<div class="empty"><p>Reading every repository…</p></div>';
  }

  const body =
    view.days.length === 0
      ? `<div class="empty"><p>${escapeHtml(view.summary)}</p></div>`
      : view.days
          .map(
            (day) =>
              `<div class="day"><h2>${escapeHtml(day.heading)}</h2>` +
              `${day.entries.map(renderActivityEntry).join('')}</div>`,
          )
          .join('');

  return (
    `<div class="digest"><p class="summary">${escapeHtml(view.summary)}</p>` +
    `${view.unreadable ? `<p class="warn">${escapeHtml(view.unreadable)}</p>` : ''}` +
    `<div class="filters"><button type="button" class="toggle report" data-report="1"` +
    ` title="Open this period as a document: totals per repository, per author and per day">` +
    `open the report</button></div></div>${body}`
  );
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
    model.mode === 'all'
      ? renderActivity(model)
      : commits.length > 0
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
${renderScope(model)}
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
/* One word per mode, and the strip is always on screen: the digest is the
   answer this extension exists to give, and a mode nobody can see is one nobody
   uses. */
.scopes {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 3px;
  padding: 6px 8px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
.scope {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  padding: 2px 4px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  font-size: 0.88em;
  white-space: nowrap;
  cursor: pointer;
}
.scope:hover { background: var(--vscode-toolbar-hoverBackground); }
.scope:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
/* The named repository is the one button whose width is its content: the four
   periods share the rest evenly, so a long repository name cannot squeeze them
   into initials. */
.mode.selected-repo { flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.scope.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
  font-weight: 600;
}
/* Which repository, when it is one: the switch says the shape, this says the
   name, and without it "Selected" is a word with no referent. */
.scope-where {
  flex: 1 1 auto; min-width: 0; align-self: center; padding-left: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.86em; font-weight: 600;
}
.digest { padding: 8px 10px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
.summary { margin: 0 0 4px; font-weight: 600; }
/* Named, not counted: a repository that could not be read is not a quiet one. */
.warn { margin: 0 0 6px; font-size: 0.9em; color: var(--vscode-list-warningForeground, #cca700); }
.filters { display: flex; gap: 6px; align-items: center; }
.toggle {
  margin: 0; padding: 1px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  border-radius: 4px; background: none; color: var(--vscode-descriptionForeground);
  font: inherit; font-size: 0.88em; cursor: pointer; white-space: nowrap;
}
.toggle.report { margin-left: auto; }
.toggle.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.toggle:focus-visible, .author:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.author {
  flex: 1 1 auto; min-width: 0; padding: 1px 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  border-radius: 4px;
  background: var(--vscode-dropdown-background, transparent);
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  font: inherit; font-size: 0.88em;
}
.day { display: flex; flex-direction: column; }
.day h2 {
  position: sticky; top: 33px; z-index: 1;
  margin: 0; padding: 4px 10px 3px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  font-size: 0.82em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.act {
  display: grid; row-gap: 1px; width: 100%; box-sizing: border-box;
  margin: 0; padding: 4px 10px 5px;
  border: none; border-left: 2px solid transparent; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.act:hover { background: var(--vscode-list-hoverBackground); }
.act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* A merge is the one entry whose contents are not its own, so it is tinted
   rather than left to be told apart by reading it. */
.act.merge {
  background: color-mix(in srgb, var(--vscode-charts-purple, #9a7bd0) 12%, transparent);
  border-left-color: var(--vscode-charts-purple, #9a7bd0);
}
.a1 { display: flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 0.86em; color: var(--vscode-descriptionForeground); }
.time { flex: none; font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family); }
.repo { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); font-weight: 600; }
.who { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-merge { flex: none; margin-left: auto; padding: 0 4px; border-radius: 3px; background: var(--vscode-charts-purple, #9a7bd0); color: var(--vscode-editor-background); font-size: 0.9em; }
.a2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The same idea in the single-repository history: the kind of commit is visible
   before it is read. */
.commit.kind-merge { background: color-mix(in srgb, var(--vscode-charts-purple, #9a7bd0) 10%, transparent); }
.commit.kind-tagged { background: color-mix(in srgb, var(--vscode-charts-yellow, #d0a54a) 10%, transparent); }
.commit.kind-local { background: color-mix(in srgb, var(--vscode-charts-blue, #4a8cd8) 8%, transparent); }
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

  const mode = target.closest('button[data-mode]');
  if (mode) {
    const value = mode.getAttribute('data-mode');
    api.postMessage(value === 'selected' ? { type: 'mode' } : { type: 'mode', period: value });
    return;
  }

  if (target.closest('button[data-report]')) {
    api.postMessage({ type: 'report' });
    return;
  }

  const merges = target.closest('button[data-merges]');
  if (merges) {
    api.postMessage({ type: 'activityFilter', mergesOnly: merges.getAttribute('data-merges') === 'on' });
    return;
  }

  const act = target.closest('button.act');
  if (act) {
    api.postMessage({
      type: 'openAt',
      repositoryPath: act.getAttribute('data-repo'),
      sha: act.getAttribute('data-sha'),
    });
    return;
  }

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
