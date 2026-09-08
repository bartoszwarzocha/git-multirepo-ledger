/**
 * The repository list: a `ListModel` in, a page of rows out.
 *
 * Everything this file could get wrong is layout. Which repositories appear,
 * what order they are in, what every field says and which state a row is in are
 * all decided in `view/row.ts` and `view/order.ts`, which import no `vscode`
 * and are unit-tested; nothing here reads a repository or judges one.
 *
 * The page is self-contained and locked down: no network, no local resources, a
 * nonce on the one stylesheet and the one script. Repository names and commit
 * subjects come off the user's filesystem, so nothing is interpolated raw.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import type {
  FilterMode,
  ListModel,
  RenderedRow,
  RowAction,
  RowState,
  SortMode,
  Tally,
} from '../model/types.ts';
import { FILTER_MODES, ROW_ACTIONS, SORT_MODES } from '../model/types.ts';
import { buildRows } from './row.ts';

/** What the page asked for, once it has been checked against the known sets. */
export type PanelRequest =
  | { readonly type: 'select'; readonly path: string }
  | { readonly type: 'sort'; readonly sort: SortMode }
  | { readonly type: 'filter'; readonly filter: FilterMode }
  | { readonly type: 'action'; readonly action: RowAction; readonly path: string }
  | { readonly type: 'refresh' }
  /** The empty states offer the one setting that fills them; nothing else does. */
  | { readonly type: 'settings' };

export class ListViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'repoLedger.repositories';

  private readonly requested = new vscode.EventEmitter<PanelRequest>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  /** Until the controller says otherwise, an empty list means "not yet". */
  private model: ListModel = {
    rows: [],
    status: { kind: 'scanning' },
    tally: emptyTally(),
    sort: 'recent',
    filter: 'all',
    busy: true,
    generation: 0,
  };

  readonly onDidRequest: vscode.Event<PanelRequest> = this.requested.event;

  constructor(context: vscode.ExtensionContext) {
    // A reload must not leave the emitter alive behind a view that is gone.
    context.subscriptions.push(new vscode.Disposable(() => this.dispose()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // The page carries its own styles and icons, so nothing may be loaded
      // from disk either.
      localResourceRoots: [],
    };

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

  setModel(model: ListModel): void {
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
      this.view.webview.html = renderHtml(this.model, createNonce());
    }
  }

  /**
   * A webview message is input crossing a trust boundary even though the page
   * is ours, so every field is checked against the exported set rather than
   * cast. A page left over from an older build can send a mode this one does
   * not have, and a `filter` that reached `filterRows` unchecked would silently
   * show everything while the header claimed otherwise.
   */
  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const payload = message as Record<string, unknown>;

    switch (payload['type']) {
      case 'refresh':
        this.requested.fire({ type: 'refresh' });
        return;
      case 'select':
        if (typeof payload['path'] === 'string') {
          this.requested.fire({ type: 'select', path: payload['path'] });
        }
        return;
      case 'sort':
        if (isMember(SORT_MODES, payload['sort'])) {
          this.requested.fire({ type: 'sort', sort: payload['sort'] });
        }
        return;
      case 'filter':
        if (isMember(FILTER_MODES, payload['filter'])) {
          this.requested.fire({ type: 'filter', filter: payload['filter'] });
        }
        return;
      case 'action':
        if (isMember(ROW_ACTIONS, payload['action']) && typeof payload['path'] === 'string') {
          this.requested.fire({
            type: 'action',
            action: payload['action'],
            path: payload['path'],
          });
        }
        return;
      default:
        return;
    }
  }
}

function isMember<T extends string>(known: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (known as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function createNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Escapes text for element content and for quoted attribute values alike.
 *
 * Repository names, branch names and commit subjects all originate in the
 * user's repositories, so every one of them goes through here on its way into
 * the page. A commit subject is the most dangerous string this extension
 * handles: it is arbitrary text somebody else wrote, and it reaches the page on
 * every row.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emptyTally(): Tally {
  return {
    total: 0,
    clean: 0,
    dirty: 0,
    unpushed: 0,
    behind: 0,
    attention: 0,
    unreadable: 0,
    unknown: 0,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * One glyph per row state, drawn rather than borrowed.
 *
 * A webview has no codicon font, and an emoji would render as somebody else's
 * artwork at somebody else's size. Each shape carries `currentColor`, so the
 * row's state colour paints it without a second table of colours.
 */
const STATE_ICONS: Record<RowState, string> = {
  clean: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  dirty:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="2.6" fill="currentColor"/>',
  // An arrow out: work that exists only here.
  unpushed:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M8 11.2V5.2M5.6 7.4 8 5 10.4 7.4" fill="none" stroke="currentColor"' +
    ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  behind:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M8 4.8v6M5.6 8.6 8 11 10.4 8.6" fill="none" stroke="currentColor"' +
    ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  diverged:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.4 10.6 10.6 5.4M8.4 5.2h2.4v2.4M7.6 10.8H5.2V8.4" fill="none"' +
    ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  // Cut loose from the ring.
  detached:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"' +
    ' stroke-dasharray="3 2.4"/>',
  operation:
    '<path d="M8 1.9 15 14.1H1Z" fill="none" stroke="currentColor" stroke-width="1.25"' +
    ' stroke-linejoin="round"/>' +
    '<path d="M8 6.2v3.6" fill="none" stroke="currentColor" stroke-width="1.4"' +
    ' stroke-linecap="round"/><circle cx="8" cy="12" r="0.8" fill="currentColor"/>',
  'no-upstream':
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.2 8h5.6" fill="none" stroke="currentColor" stroke-width="1.4"' +
    ' stroke-linecap="round"/>',
  unborn:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"' +
    ' stroke-dasharray="1.6 2.2"/>',
  unreadable:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" fill="none" stroke="currentColor"' +
    ' stroke-width="1.4" stroke-linecap="round"/>',
  // A hollow ring, deliberately the quietest glyph on the board: nothing has
  // been established about this repository, and a mark that drew the eye would
  // be claiming otherwise.
  unknown:
    '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1"' +
    ' stroke-dasharray="1 2.6" stroke-linecap="round"/>',
};

function icon(state: RowState): string {
  return (
    `<svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"` +
    ` focusable="false">${STATE_ICONS[state]}</svg>`
  );
}

/**
 * The header chips, in the order a reader wants them.
 *
 * Every chip is a filter, because a count you cannot act on is decoration:
 * being told three repositories hold work that exists nowhere else, and then
 * having to find them by eye, is exactly the friction this view exists to
 * remove. Pressing the chip that is already on clears the filter, so the same
 * click both narrows and widens.
 *
 * `clean` gets no chip. "Show me the ones with nothing to do" is not a question
 * anybody opens this view to ask, and spending a chip on it would push the ones
 * that do want attention further along the row.
 */
const CHIPS: ReadonlyArray<{ filter: FilterMode; key: keyof Tally; label: string }> = [
  { filter: 'unpushed', key: 'unpushed', label: 'unpushed' },
  { filter: 'dirty', key: 'dirty', label: 'uncommitted' },
  { filter: 'behind', key: 'behind', label: 'behind' },
  { filter: 'attention', key: 'attention', label: 'needs a look' },
  { filter: 'unreadable', key: 'unreadable', label: 'unreadable' },
];

function renderHeader(model: ListModel): string {
  // The "all" chip is always drawn, and it is why the header can never be
  // empty. A board where everything is clean and pushed has no other chip to
  // show, and an empty header leaves a reader who filtered five minutes ago no
  // way back and no sign that filtering exists at all.
  const showingAll = model.filter === 'all';
  const all =
    `<button type="button" class="chip all${showingAll ? ' on' : ''}" data-filter="all"` +
    ` title="${escapeHtml(showingAll ? `All ${model.tally.total} repositories` : 'Show all repositories')}"` +
    ` aria-pressed="${showingAll ? 'true' : 'false'}">` +
    `<span class="count">${model.tally.total}</span> all</button>`;

  const chips = CHIPS.filter((chip) => model.tally[chip.key] > 0).map((chip) => {
    const on = model.filter === chip.filter;
    const title = on ? `Showing only ${chip.label} — click to show all` : `Show only ${chip.label}`;
    return (
      `<button type="button" class="chip ${chip.filter}${on ? ' on' : ''}"` +
      ` data-filter="${on ? 'all' : chip.filter}" title="${escapeHtml(title)}"` +
      ` aria-pressed="${on ? 'true' : 'false'}">` +
      `<span class="count">${model.tally[chip.key]}</span> ${escapeHtml(chip.label)}</button>`
    );
  });

  // Stated rather than left to be inferred from a shorter list: a reader who
  // filtered five minutes ago and scrolled away has no other way to tell an
  // empty result from a narrow one.
  const unknown =
    model.tally.unknown > 0
      ? `<span class="chip quiet" title="Discovered, not yet read">` +
        `<span class="count">${model.tally.unknown}</span> reading</span>`
      : '';

  const sort =
    `<select class="sort" aria-label="Order">` +
    SORT_LABELS.map(
      ([mode, label]) =>
        `<option value="${mode}"${model.sort === mode ? ' selected' : ''}>${escapeHtml(label)}</option>`,
    ).join('') +
    `</select>`;

  return (
    `<header class="head"><div class="chips">${all}${chips.join('')}${unknown}</div>` +
    `<div class="controls">${sort}</div>` +
    `${model.busy ? BUSY_BAR : ''}</header>`
  );
}

const SORT_LABELS: ReadonlyArray<[SortMode, string]> = [
  ['recent', 'Recently committed'],
  ['name', 'Name'],
  ['divergence', 'Most diverged'],
  ['dirty', 'Most uncommitted'],
];

/**
 * A two-pixel indeterminate bar.
 *
 * There is no total to count towards - the pass reads however many
 * repositories the directory has - so a determinate bar would be a fiction, and
 * a spinner in place of the list would take away rows that are still worth
 * reading while the next answer arrives.
 */
const BUSY_BAR = '<div class="busy" role="status" aria-label="Reading"><span></span></div>';

/**
 * Two actions ride on the row, revealed on hover or focus like the tree's own
 * inline actions, so a list of forty repositories is not a wall of buttons.
 *
 * They are here rather than on the primary click because both leave this view:
 * one opens a window, the other writes the clipboard. An action that big has to
 * be aimed at.
 */
const ROW_ACTION_ICONS: ReadonlyArray<{ action: string; title: string; svg: string }> = [
  {
    action: 'open-window',
    title: 'Open in a new window',
    svg:
      '<rect x="1.9" y="3.2" width="12.2" height="9.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M1.9 6.1h12.2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  },
  {
    action: 'copy-path',
    title: 'Copy the path',
    svg:
      '<rect x="5.4" y="2.2" width="8.4" height="9.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M10.6 13.8H3.3a1.1 1.1 0 0 1-1.1-1.1V4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  },
];

function renderRow(row: RenderedRow, selected: boolean): string {
  const where = `data-path="${escapeHtml(row.path)}"`;

  // Line 1. The name wins the width contest; the evidence age is the dimmed
  // trailing span, and is the first thing to disappear as the sidebar narrows -
  // it is the only field whose absence degrades to "I don't know" rather than
  // to a wrong impression.
  const divergence =
    row.divergence !== undefined && row.divergence !== ''
      ? `<span class="div${row.divergenceDimmed ? ' word' : ''}">${escapeHtml(row.divergence)}</span>`
      : '';
  const dirty =
    row.dirty !== undefined && row.dirty !== ''
      ? `<span class="dirty">${escapeHtml(row.dirty)}</span>`
      : '';
  const freshness =
    row.freshness !== undefined
      ? `<span class="fresh">${escapeHtml(row.freshness)}</span>`
      : '';
  const qualifier =
    row.qualifier !== undefined ? `<span class="qual">${escapeHtml(row.qualifier)}</span>` : '';

  // Line 2. The subject is truncated here rather than in `row.ts` because the
  // width is the page's to know; the tooltip carries it whole either way.
  const age = row.age !== undefined ? `<span class="age">${escapeHtml(row.age)}</span>` : '';
  const line2 = `<span class="l2">${age}<span class="subj">${escapeHtml(row.subject)}</span></span>`;

  // Line 3. Absent entirely for a row that has not been read, rather than
  // rendered empty: a blank line reads as a repository with no branch.
  const kind = row.kind !== undefined ? `<span class="kind">${escapeHtml(row.kind)}</span>` : '';
  // Absent both when nobody asked and when nothing is open, which is why there
  // is no zero here to render.
  const review =
    row.review !== undefined ? `<span class="review">${escapeHtml(row.review)}</span>` : '';
  const line3 =
    row.headState.length > 0 || kind.length > 0 || review.length > 0
      ? `<span class="l3"><span class="head-state">${escapeHtml(row.headState)}</span>${kind}${review}</span>`
      : '';

  const reason =
    row.unreadableReason !== undefined
      ? `<span class="why">${escapeHtml(row.unreadableReason)}</span>`
      : '';

  const actions = ROW_ACTION_ICONS.map(
    (entry) =>
      `<button type="button" class="row-action" data-action="${entry.action}" ${where}` +
      ` title="${escapeHtml(entry.title)}" aria-label="${escapeHtml(`${entry.title}: ${row.name}`)}">` +
      `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">${entry.svg}</svg>` +
      `</button>`,
  ).join('');

  return `<div class="row ${row.state}${selected ? ' selected' : ''}">
<button type="button" class="row-main" ${where} title="${escapeHtml(row.tooltip)}"
 aria-pressed="${selected ? 'true' : 'false'}">
${icon(row.state)}
<span class="l1">${qualifier}<span class="name">${escapeHtml(row.name)}</span>${divergence}${dirty}${freshness}</span>
${line2}
${line3}
${reason}
</button><span class="row-actions">${actions}</span>
</div>`;
}

/**
 * An empty list is an answer, and which answer it is matters: one says wait,
 * one says open a folder, one says the filter is hiding everything, and one
 * says git is not installed.
 */
function renderEmpty(model: ListModel): string {
  switch (model.status.kind) {
    case 'scanning':
      return `<div class="empty"><p>Looking for repositories…</p>
<p class="hint">Rows appear as each repository answers, rather than after all of them do.</p></div>`;
    case 'nothing-to-scan':
      return `<div class="empty"><p>No folder is open and no directory is configured, so there is nothing to scan.</p>
<p class="hint">The directory your repositories live in is usually not the one you have open — name it in <code>repoLedger.additionalRoots</code>.</p>
<p><button type="button" class="link" data-action-global="settings">Configure directories</button></p></div>`;
    case 'no-git':
      return `<div class="empty"><p><code>git</code> was not found on <code>PATH</code>.</p>
<p class="hint">Nothing can be read without it. Every row would say the same thing, so the list says it once instead.</p></div>`;
    case 'no-repositories':
      return `<div class="empty"><p>Nothing with a <code>.git</code> was found.</p>
<p class="hint">The search descends to any depth beneath the open folders — so a repository several levels down is found too — but a directory outside them is searched only if you add it.</p>
<p><button type="button" class="link" data-action-global="settings">Add a directory</button>
<button type="button" class="link" data-action-global="refresh">Refresh</button></p></div>`;
    case 'ready':
      return `<div class="empty"><p>No repository matches this filter.</p>
<p class="hint">Press the active chip above to show all ${model.tally.total} again.</p></div>`;
  }
}

export function renderHtml(model: ListModel, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const rendered = buildRows(model.rows, Date.now());
  const empty = rendered.length === 0;
  const header = model.status.kind === 'ready' ? renderHeader(model) : '';
  const body = empty
    ? `${header}${renderEmpty(model)}`
    : `${header}<div class="rows">${rendered
        .map((row) => renderRow(row, row.path === model.selectedPath))
        .join('')}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Repositories</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  margin: 0;
  padding: 0 0 12px;
  line-height: 1.35;
}
p { margin: 0 0 6px; }
code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
/* State lives in one custom property per row, so the glyph and the edge rule
   are coloured from the same decision. Only the states that ask for a decision
   are tinted; colouring all ten would leave the eye nothing to land on. */
.clean { --state: var(--vscode-descriptionForeground); }
.dirty { --state: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground, #cca700)); }
.unpushed { --state: var(--vscode-charts-blue, #4a8cd8); }
.behind { --state: var(--vscode-charts-purple, #9a7bd0); }
.diverged { --state: var(--vscode-list-warningForeground, #cca700); }
.detached { --state: var(--vscode-descriptionForeground); }
.operation { --state: var(--vscode-list-errorForeground, var(--vscode-editorError-foreground, #d97a6a)); }
.no-upstream { --state: var(--vscode-descriptionForeground); }
.unborn { --state: var(--vscode-descriptionForeground); }
.unreadable { --state: var(--vscode-list-errorForeground, #d97a6a); }
.icon { color: var(--state); flex: none; }
.head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
.chips { display: flex; flex-wrap: wrap; gap: 2px 10px; padding: 7px 12px 2px; }
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin: 0;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.chip.quiet { cursor: default; opacity: 0.75; }
/* The one chip that is always present, so the header is never empty and the way
   back from a filter is always on screen. */
.chip.all { font-weight: 600; }
.chip:not(.quiet):hover { background: var(--vscode-toolbar-hoverBackground); }
.chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* The active filter is stated, not merely implied by a shorter list. */
.chip.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.chip .count { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
.chip.on .count { color: inherit; }
.controls { display: flex; padding: 2px 12px 7px; }
.sort {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  border-radius: 3px;
  background: var(--vscode-dropdown-background, transparent);
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  font: inherit;
  font-size: 0.92em;
}
.sort:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.busy { height: 2px; overflow: hidden; background: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
.busy > span {
  display: block;
  width: 34%;
  height: 100%;
  background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(390%); } }
/* Motion is decoration here: the bar's presence is the message, so a reader who
   has asked for less of it still sees the state. */
@media (prefers-reduced-motion: reduce) {
  .busy > span { width: 100%; animation: none; opacity: 0.6; }
}
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: stretch; border-left: 2px solid transparent; }
/* Selection is the primary click's whole effect, so it has to be visible:
   without this, clicking a row would look like nothing happened at all. */
.row.selected { background: var(--vscode-list-activeSelectionBackground); }
.row.selected .row-main, .row.selected .subj, .row.selected .name {
  color: var(--vscode-list-activeSelectionForeground);
}
.row-actions { display: flex; align-items: center; flex: none; }
.row-action {
  margin: 0 2px;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  opacity: 0;
}
.row:hover .row-action, .row-action:focus-visible { opacity: 1; }
.row-action:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.row-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.row + .row { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.16)); }
/* The rule down the edge is spent on the states that want a decision. */
.row.operation, .row.unreadable, .row.diverged { border-left-color: var(--state); }
.row:hover, .row:focus-within { background: var(--vscode-list-hoverBackground); }
.row-main {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
  align-items: start;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 6px 8px 7px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row-main:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
  background: var(--vscode-list-hoverBackground);
}
.row-main > .icon { grid-row: 1 / span 1; margin-top: 2px; }
.l1, .l2, .l3, .why { grid-column: 2; }
.l1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.qual { flex: none; opacity: 0.55; }
/* The name never yields: it is the only field that says which repository this
   row is about. */
.name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.div { flex: none; font-variant-numeric: tabular-nums; color: var(--state); }
.div.word { color: var(--vscode-descriptionForeground); font-variant-numeric: normal; }
.dirty { flex: none; color: var(--vscode-list-warningForeground, #cca700); font-family: var(--vscode-editor-font-family); }
/* Dimmed, trailing, and the first thing to go: it is the only field whose
   absence degrades to "I don't know" rather than to a wrong impression. */
.fresh {
  flex: 0 1 auto;
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.88em;
  opacity: 0.55;
}
.l2 { display: flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 0.94em; }
.age { flex: none; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.subj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l3 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}
.head-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review {
  flex: none;
  margin-left: auto;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--vscode-charts-green, #7fb98b);
  color: var(--vscode-editor-background);
  font-size: 0.9em;
  font-variant-numeric: tabular-nums;
}
.kind {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
  border-radius: 3px;
  font-size: 0.9em;
}
.why {
  margin-top: 3px;
  font-size: 0.9em;
  color: var(--vscode-list-errorForeground, #d97a6a);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.empty { padding: 14px 14px 0; max-width: 60ch; }
.empty .hint { color: var(--vscode-descriptionForeground); }
.link {
  margin: 0 10px 0 0;
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

/**
 * The click handler, and one small courtesy: a refresh replaces the whole
 * document, and a reader who has scrolled to the bottom of forty repositories
 * should not be sent back to the top every time one of them answers.
 */
const SCRIPT = `
const api = acquireVsCodeApi();
const saved = api.getState();
if (saved && typeof saved.scrollTop === 'number') {
  window.scrollTo(0, saved.scrollTop);
}
window.addEventListener('scroll', () => {
  api.setState({ scrollTop: window.scrollY });
}, { passive: true });

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.classList.contains('sort')) {
    api.postMessage({ type: 'sort', sort: target.value });
  }
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }

  const chip = target.closest('button[data-filter]');
  if (chip) {
    api.postMessage({ type: 'filter', filter: chip.getAttribute('data-filter') });
    return;
  }

  const global = target.closest('button[data-action-global]');
  if (global) {
    const what = global.getAttribute('data-action-global');
    api.postMessage(what === 'refresh' ? { type: 'refresh' } : { type: 'action', action: 'settings', path: '' });
    return;
  }

  const action = target.closest('button.row-action');
  if (action) {
    api.postMessage({
      type: 'action',
      action: action.getAttribute('data-action'),
      path: action.getAttribute('data-path'),
    });
    return;
  }

  const row = target.closest('button.row-main');
  if (row) {
    api.postMessage({ type: 'select', path: row.getAttribute('data-path') });
  }
});
`;
