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
import { authorOptions } from './activity.ts';
import type { Badge } from './badge.ts';
import { buildRows } from './row.ts';

/** What the page asked for, once it has been checked against the known sets. */
export type PanelRequest =
  | { readonly type: 'select'; readonly path: string }
  | { readonly type: 'sort'; readonly sort: SortMode }
  | { readonly type: 'filter'; readonly filter: FilterMode }
  | { readonly type: 'action'; readonly action: RowAction; readonly path: string }
  | { readonly type: 'refresh' }
  /** The empty states offer the one setting that fills them; nothing else does. */
  | { readonly type: 'settings' }
  /** The period every commit question is asked over. */
  | { readonly type: 'period'; readonly period: string }
  /** Narrow the commits, in the pane and the report alike. */
  | {
      readonly type: 'commitFilter';
      readonly mergesOnly?: boolean;
      /** An identity key from `authorsOf`, not a display name. */
      readonly authorId?: string;
    };

export class ListViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'multirepoLedger.repositories';

  private readonly requested = new vscode.EventEmitter<PanelRequest>();
  private readonly listeners: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private badge: Badge | undefined;
  private disposed = false;

  /** Until the controller says otherwise, an empty list means "not yet". */
  private model: ListModel = {
    rows: [],
    status: { kind: 'scanning' },
    tally: emptyTally(),
    sort: 'recent',
    filter: 'all',
    busy: true,
    fetchEnabled: false,
    generation: 0,
    period: 'week',
    mergesOnly: false,
    authors: [],
  };

  readonly onDidRequest: vscode.Event<PanelRequest> = this.requested.event;

  constructor(context: vscode.ExtensionContext) {
    // A reload must not leave the emitter alive behind a view that is gone.
    context.subscriptions.push(new vscode.Disposable(() => this.dispose()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Whatever the badge was before the container was first opened. It is set
    // long before this runs, and the reader who never opens the panel is the
    // one the badge exists for.
    view.badge = this.badge;
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

  /**
   * The number on the Activity Bar icon, or `undefined` for none.
   *
   * Held rather than set straight through, because the view does not exist
   * until the container is first opened and a badge set before that would be
   * dropped - which is exactly the case the badge is for, a reader who has not
   * opened the panel yet.
   */
  setBadge(badge: Badge | undefined): void {
    this.badge = badge;
    if (this.view) {
      this.view.badge = badge;
    }
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
      case 'period':
        if (typeof payload['period'] === 'string') {
          this.requested.fire({ type: 'period', period: payload['period'] });
        }
        return;
      case 'commitFilter':
        this.requested.fire({
          type: 'commitFilter',
          ...(typeof payload['mergesOnly'] === 'boolean'
            ? { mergesOnly: payload['mergesOnly'] }
            : {}),
          ...(typeof payload['authorId'] === 'string'
            ? { authorId: payload['authorId'] }
            : {}),
        });
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
 * One coloured dot per row, which is what the mockup this was chosen from
 * showed and what a board of twenty rows can actually be read at.
 *
 * One shape, ten colours - not ten shapes. A column of different glyphs asks
 * the reader to learn a vocabulary before the board tells them anything; a
 * column of dots is scanned in one pass and the odd colour out is the row worth
 * looking at. The word is in the tooltip and, for everything that is not
 * `clean`, on line 1 or line 3 in text as well, so the colour is never the only
 * carrier of the fact.
 *
 * Drawn rather than borrowed because a webview has no codicon font and an emoji
 * would render as somebody else's artwork at somebody else's size. Both shapes
 * carry `currentColor`, so the row's state colour paints them without a second
 * table of colours.
 */
const DOT = '<circle cx="8" cy="8" r="4.2" fill="currentColor"/>';

const HOLLOW =
  '<circle cx="8" cy="8" r="3.9" fill="none" stroke="currentColor" stroke-width="1.4"/>';
const STATE_ICONS: Record<RowState, string> = {
  clean: DOT,
  dirty: DOT,
  unpushed: DOT,
  behind: DOT,
  diverged: DOT,
  detached: DOT,
  operation: DOT,
  'no-upstream': DOT,
  unborn: DOT,
  unreadable: DOT,
  // The one exception, and it is not a state of the repository: nothing has been
  // read yet, so the mark is hollow. A filled dot in the state colours would be
  // claiming a state nobody established.
  unknown: HOLLOW,
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
interface Chip {
  readonly filter: FilterMode;
  readonly key: keyof Tally;
  readonly label: string;
  /**
   * What the chip says when its count is zero.
   *
   * Written out per chip rather than composed from the label: the labels are
   * adjectives and noun phrases in the same list, so one template produces
   * "No repository is needs a look" for at least one of them.
   */
  readonly none: string;
}

const CHIPS: readonly Chip[] = [
  {
    filter: 'unpushed',
    key: 'unpushed',
    label: 'unpushed',
    none: 'Every repository has pushed everything it has committed',
  },
  {
    filter: 'dirty',
    key: 'dirty',
    label: 'uncommitted',
    none: 'No repository is holding uncommitted work',
  },
  {
    filter: 'behind',
    key: 'behind',
    label: 'behind',
    none: 'No repository is behind its upstream, as of the last fetch of each',
  },
  {
    filter: 'attention',
    key: 'attention',
    label: 'needs a look',
    none: 'Nothing is detached, mid-operation, unborn or without an upstream',
  },
  {
    filter: 'unreadable',
    key: 'unreadable',
    label: 'unreadable',
    none: 'git answered for every repository',
  },
];


/**
 * The lens: the period, and who and what counts inside it.
 *
 * On the board rather than on the pane below, because it governs both the
 * pane's list and the report in the editor. It was on the pane, and a reader
 * changing the period there found that the report followed it - a control at
 * the bottom silently deciding what a command at the top produced, which is
 * the wrong way round and impossible to guess.
 */
/**
 * Three ranges, and no `All` among them.
 *
 * A range can be turned off, so the fourth button was saying the same thing as
 * none of the other three being on - two controls for one state, and the reader
 * had to work out that pressing `All` and un-pressing `7 days` were the same
 * gesture. Pressing the lit one clears it, and nothing lit means no date bound.
 */
const PERIODS: ReadonlyArray<[string, string, string]> = [
  ['today', 'Today', 'Only commits from midnight - press again to drop the limit'],
  ['week', '7 days', 'Only the last seven days - press again to drop the limit'],
  ['month', '30 days', 'Only the last thirty days - press again to drop the limit'],
];

function renderLens(model: ListModel): string {
  const periods = PERIODS.map(([value, label, title]) => {
    const on = model.period === value;
    // The lit button sends `all`, which is this extension's word for no bound.
    // The same click both narrows and widens, so there is one control per range
    // rather than one per range plus one to undo them.
    return (
      `<button type="button" class="period${on ? ' on' : ''}"` +
      ` data-period="${on ? 'all' : escapeHtml(value)}"` +
      ` title="${escapeHtml(on ? 'Showing this range - press to drop the limit' : title)}"` +
      ` aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(label)}</button>`
    );
  }).join('');

  const merges =
    `<button type="button" class="toggle${model.mergesOnly ? ' on' : ''}"` +
    ` data-merges="${model.mergesOnly ? 'off' : 'on'}"` +
    ` title="${escapeHtml(model.mergesOnly ? 'Count every commit' : 'Count only merges')}"` +
    ` aria-pressed="${model.mergesOnly ? 'true' : 'false'}">merges only</button>`;

  // Always drawn, and labelled. It used to appear only when the current answer
  // held more than one name, so on a quiet day - the very case where a reader
  // asks "who did anything" - the control vanished, and a filter that is absent
  // when the list is short is a filter nobody knows exists.
  //
  // One option per person, keyed on the address. Keyed on the display name it
  // offered the same person once per machine they commit from, and picking one
  // spelling hid the work done under the others. The controller keeps a chosen
  // person in this list even when the range no longer holds a commit of theirs,
  // so narrowing does not drop the filter behind the reader's back.
  const authors =
    `<label class="author-label">Author<select class="author">` +
    `<option value=""${model.authorId === undefined ? ' selected' : ''}>Everyone</option>` +
    authorOptions(model.authors)
      .map(
        (author) =>
          `<option value="${escapeHtml(author.id)}"` +
          `${model.authorId === author.id ? ' selected' : ''}` +
          `${author.title.length > 0 ? ` title="${escapeHtml(author.title)}"` : ''}>` +
          `${escapeHtml(author.text)}</option>`,
      )
      .join('') +
    `</select></label>`;

  // Stated, because "no range" is otherwise indistinguishable from "the button
  // did not register": three unlit buttons look the same either way.
  const unbounded =
    model.period === 'all'
      ? `<span class="period-none" title="No date limit is set">no limit</span>`
      : '';

  return (
    `<div class="lens"><div class="periods" role="group" aria-label="Period">${periods}${unbounded}</div>` +
    `<div class="lens-filters">${merges}${authors}</div></div>`
  );
}

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

  // Every chip is drawn, including the ones at zero. Hiding them was the
  // earlier behaviour and it was wrong twice over: on a board where everything
  // is clean the strip collapsed to a single word and stopped looking like a
  // control at all, and a reader could not learn what the board is able to tell
  // them without first being in the state that reveals it. A zero here is a
  // measured zero - every one of these counts is derived from a read that
  // returned - so saying "nothing unpushed" out loud is information, not noise.
  // What a zero is not is clickable: filtering to an empty list would answer a
  // question the strip has already answered.
  const chips = CHIPS.map((chip) => {
    const count = model.tally[chip.key];
    if (count === 0) {
      return (
        `<span class="chip zero" title="${escapeHtml(chip.none)}">` +
        `<span class="count">0</span> ${escapeHtml(chip.label)}</span>`
      );
    }
    const on = model.filter === chip.filter;
    const title = on ? `Showing only ${chip.label} — click to show all` : `Show only ${chip.label}`;
    return (
      `<button type="button" class="chip ${chip.filter}${on ? ' on' : ''}"` +
      ` data-filter="${on ? 'all' : chip.filter}" title="${escapeHtml(title)}"` +
      ` aria-pressed="${on ? 'true' : 'false'}">` +
      `<span class="count">${count}</span> ${escapeHtml(chip.label)}</button>`
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

  // Labelled in the page rather than only in `aria-label`: an unlabelled select
  // in a sidebar is a control whose purpose the reader has to infer from its
  // current value, and the current value is a sentence about repositories,
  // which reads as a filter rather than as an ordering.
  const sort =
    `<label class="sort-label">Order<select class="sort">` +
    SORT_LABELS.map(
      ([mode, label]) =>
        `<option value="${mode}"${model.sort === mode ? ' selected' : ''}>${escapeHtml(label)}</option>`,
    ).join('') +
    `</select></label>`;

  return (
    `<header class="head"><div class="chips">${all}${chips.join('')}${unknown}</div>` +
    `<div class="controls">${sort}</div>` +
    `${renderLens(model)}` +
    `${model.busy ? BUSY_BAR : ''}</header>`
  );
}

/**
 * Each option says what the ordering does, not what it is named after.
 *
 * `Name` on its own is a noun with no direction, and next to `Most diverged` a
 * reader has to work out that one is a key and the other is a ranking. Every
 * option is now a sentence about the first row, which is the row they are
 * looking at while they read it.
 */
const SORT_LABELS: ReadonlyArray<[SortMode, string]> = [
  ['recent', 'Newest commit first'],
  ['name', 'Name, A to Z'],
  ['divergence', 'Most diverged first'],
  ['dirty', 'Most uncommitted first'],
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
    // The one action here that writes. Drawn only when the setting allows it,
    // which is why this table is filtered rather than rendered whole.
    action: 'fetch',
    title: 'Fetch from the remote',
    svg:
      '<path d="M8 2.4v6.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M5.2 6.6 8 9.4l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M2.7 12.6h10.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  },
  {
    action: 'copy-path',
    title: 'Copy the path',
    svg:
      '<rect x="5.4" y="2.2" width="8.4" height="9.6" rx="1.1" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M10.6 13.8H3.3a1.1 1.1 0 0 1-1.1-1.1V4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  },
];

function renderRow(row: RenderedRow, selected: boolean, fetchEnabled: boolean): string {
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

  const actions = ROW_ACTION_ICONS.filter(
    (entry) => entry.action !== 'fetch' || fetchEnabled,
  ).map(
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
<p class="hint">The directory your repositories live in is usually not the one you have open — name it in <code>multirepoLedger.additionalRoots</code>.</p>
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
        .map((row) => renderRow(row, row.path === model.selectedPath, model.fetchEnabled))
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
.clean { --state: var(--vscode-charts-green, #6a9955); }
.dirty { --state: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground, #cca700)); }
.unpushed { --state: var(--vscode-charts-blue, #4a8cd8); }
.behind { --state: var(--vscode-charts-purple, #9a7bd0); }
.diverged { --state: var(--vscode-list-warningForeground, #cca700); }
.detached { --state: var(--vscode-charts-orange, #d99a4a); }
.operation { --state: var(--vscode-list-errorForeground, var(--vscode-editorError-foreground, #d97a6a)); }
.no-upstream { --state: var(--vscode-descriptionForeground); }
/* Not a state of the repository but a state of our knowledge, so it is the one
   glyph drawn at less than full strength. */
.unknown { --state: var(--vscode-descriptionForeground); opacity: 0.7; }
.unborn { --state: var(--vscode-charts-purple, #9a7bd0); }
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
/* A count of zero, and it is a measured one: dimmed so it does not compete with
   the states that want attention, and not a button because filtering to an
   empty list answers nothing. */
.chip.zero { opacity: 0.45; cursor: default; }
.chip.zero .count { color: inherit; }
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
.sort-label {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 0.86em;
  color: var(--vscode-descriptionForeground);
}
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
/* The lens sits under the board's own controls and above the rule, because it
   governs the pane below and the report, not this list. */
.lens { padding: 4px 12px 7px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
.periods { display: flex; align-items: center; gap: 3px; }
.period-none {
  flex: none;
  padding-left: 4px;
  font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
.period {
  flex: 1 1 0; min-width: 0; margin: 0; padding: 2px 4px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px;
  background: none; color: var(--vscode-descriptionForeground);
  font: inherit; font-size: 0.86em; white-space: nowrap; cursor: pointer;
}
.period:hover { background: var(--vscode-toolbar-hoverBackground); }
.period:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.period.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
  font-weight: 600;
}
.lens-filters { display: flex; gap: 5px; align-items: center; margin-top: 4px; }
.toggle {
  margin: 0; padding: 1px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px;
  background: none; color: var(--vscode-descriptionForeground);
  font: inherit; font-size: 0.86em; cursor: pointer; white-space: nowrap;
}
.toggle.on {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.toggle:focus-visible, .author:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.author-label {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
}
.author {
  flex: 1 1 auto; min-width: 0; padding: 1px 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  border-radius: 4px;
  background: var(--vscode-dropdown-background, transparent);
  color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  font: inherit; font-size: 0.86em;
}
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
  if (!(target instanceof HTMLSelectElement)) { return; }
  if (target.classList.contains('sort')) {
    api.postMessage({ type: 'sort', sort: target.value });
  } else if (target.classList.contains('author')) {
    api.postMessage({ type: 'commitFilter', authorId: target.value });
  }
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }

  const period = target.closest('button[data-period]');
  if (period) {
    api.postMessage({ type: 'period', period: period.getAttribute('data-period') });
    return;
  }

  const merges = target.closest('button[data-merges]');
  if (merges) {
    api.postMessage({
      type: 'commitFilter',
      mergesOnly: merges.getAttribute('data-merges') === 'on',
    });
    return;
  }

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
