/**
 * The repository row as pure data: every string the list shows, already decided.
 *
 * The webview places fields and paints them; it decides nothing. Every label,
 * every judgement about which fields are silent, and the precedence between
 * states a repository holds at once are made here, in a module with no `vscode`
 * import, so that all of it is reachable from `node --test` without an
 * extension host. The sibling project draws the same boundary in
 * `src/view/overview.ts` and for the same reason: a rule that only exists
 * inside a template string is a rule nobody can test.
 *
 * The rule this file keeps, everywhere: **a fact nobody established is not a
 * fact established as zero.** In the returned strings that shows up as the
 * difference between `undefined` (nobody asked, or nobody answered) and `''`
 * (asked, answered, nothing to say). Both draw as nothing on the row; they
 * differ in the tooltip and they differ in the tally, and the moment they are
 * folded together the board starts reporting repositories as fine because it
 * has not got round to them.
 *
 * Nothing here truncates. The subject and the HEAD state yield at narrow widths
 * (design D24), but which width is narrow depends on the theme's font and the
 * reader's sidebar, so the shortening is CSS and the full text always travels
 * with the row for the tooltip.
 */

import * as path from 'node:path';

import { normalizePath, pathKey, shortSha } from '../model/keys.ts';
import type {
  ReviewState,
  DiscoveredRepository,
  Divergence,
  FetchEvidence,
  HeadState,
  Operation,
  ReadFailure,
  RenderedRow,
  RepositoryRow,
  RowState,
  WorkingTree,
} from '../model/types.ts';
import { forgeKindOf, parseForgeTarget, type ForgeKind } from '../forge/remote.ts';

// ---------------------------------------------------------------------------
// Relative dates
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `just now`, `12m ago`, `3h ago`, `2d ago`, `5w ago`, `7mo ago`, `3y ago`.
 *
 * Computed here rather than asked of git (design D25). `%(committerdate:relative)`
 * and `--date=relative` are worded in git's own locale, so on a machine whose
 * git speaks German the row would read `vor 3 Tagen - fix: correct the parser`:
 * half a line in each language, from a formatting choice nobody made. Every
 * other string on this row is English, so this one is too.
 *
 * Rejected for the same reason from the other side: `Intl.RelativeTimeFormat`
 * against the editor's display language, which would make the date the single
 * localised token in an English sentence.
 *
 * A timestamp in the future reads as `just now`. A row saying `in 3 days` is
 * read as a bug in the extension and it very nearly always is a bug in
 * somebody's clock; the tooltip carries the absolute time, so nothing is lost.
 *
 * @param at   whole seconds since the epoch, as `%(committerdate:unix)` gives them
 * @param now  milliseconds since the epoch, passed in so this is a function of its inputs
 */
export function relativeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - at);
  if (seconds < MINUTE) {
    return 'just now';
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m ago`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)}h ago`;
  }
  const days = Math.floor(seconds / DAY);
  if (days < 7) {
    return `${days}d ago`;
  }
  const years = Math.floor(days / 365);
  if (years >= 1) {
    return `${years}y ago`;
  }
  const months = Math.floor(days / 30);
  if (months >= 1) {
    return `${months}mo ago`;
  }
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * `2026-09-07 14:32`, in the reader's own timezone.
 *
 * Rejected: `toLocaleString`, which follows the machine's locale. Two relative
 * dates cannot be compared against each other precisely, so the tooltip is
 * where a reader goes to settle exactly when something happened - and a format
 * that reverses day and month depending on the machine is the one thing that
 * position must not do. The ISO-ordered form is unambiguous in every locale and
 * carries no words to translate.
 */
export function absoluteTime(at: number): string {
  const date = new Date(at * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Facts the row and the ordering both need
// ---------------------------------------------------------------------------

/**
 * The two figures, when the extension established both, and nothing otherwise.
 *
 * `in-sync` returns `{ 0, 0 }` because that pair *was* established; `gone`,
 * `no-upstream` and `unknown` return nothing because no pair exists to report.
 * That difference is what stops the divergence sort from ranking a repository
 * with no upstream as though it were level with one (design D31), and it is why
 * `view/order.ts` asks through this function rather than reading the union.
 */
export function divergenceFigures(
  divergence: Divergence,
): { readonly ahead: number; readonly behind: number } | undefined {
  switch (divergence.kind) {
    case 'in-sync':
      return { ahead: 0, behind: 0 };
    case 'diverged':
      return { ahead: divergence.ahead, behind: divergence.behind };
    case 'no-upstream':
    case 'gone':
    case 'unknown':
      return undefined;
  }
}

/**
 * How many entries `status` counted, or nothing when it did not run.
 *
 * A `not-read` tree is the default state of every row, because the second-tier
 * read ships off; an `incomplete` one is a read that returned damaged. Neither
 * is a zero, and returning one would let the dirty sort order the whole board
 * by an answer nobody has.
 */
export function dirtyCount(tree: WorkingTree): number | undefined {
  if (tree.kind !== 'counted') {
    return undefined;
  }
  const { staged, unstaged, untracked, conflicted } = tree.counts;
  return staged + unstaged + untracked + conflicted;
}

/** The row's name, and the key the name sort uses. */
export function repositoryName(repository: DiscoveredRepository): string {
  return path.basename(normalizePath(repository.path));
}

// ---------------------------------------------------------------------------
// The state a row carries
// ---------------------------------------------------------------------------

/**
 * The one word the row is filed under, and the precedence between the several
 * that can be true at once.
 *
 * A repository is routinely dirty *and* behind *and* detached; the header's
 * counts and filters handle that by asking the underlying facts (see
 * `view/order.ts`), so this function is free to answer the narrower question
 * the row itself asks: which single state should the row's accent name. The
 * order below is the whole of that decision, stated in one place so that two
 * surfaces can never disagree about it.
 *
 * 1. `unreadable`. git would not answer, so nothing else on the row was
 *    established and no other state can be claimed.
 * 2. `unknown`. Nobody has read this repository yet. Deliberately above
 *    everything except the failure: a row that has not answered must never fall
 *    through to `clean`, which is the specific way a scan-in-progress board
 *    tells its reader that everything is fine.
 * 3. `unborn`. `git init` and nothing since. It has no commit to be ahead of
 *    and no tree worth describing, so the arithmetic below does not apply -
 *    and it is emphatically not `clean`, which would read as "nothing to do".
 * 4. `operation`. A merge, rebase, cherry-pick, revert or bisect was left
 *    running. It outranks dirtiness because a stopped rebase leaves a dirty
 *    tree by construction, so `dirty` would name the symptom and hide the
 *    cause; it outranks `detached` because HEAD *is* detached during a rebase
 *    and `detached at 7c86ebf` is true and useless exactly then (design D17).
 * 5. `detached`. Commits made here land on no branch. That outranks the states
 *    below it because it changes what happens to any work the row is also
 *    reporting - a dirty tree on a detached HEAD is the one that can be lost.
 * 6. `dirty`. Rejected: ranking the divergence states above this one, which
 *    keeps the row's word from changing when the reader enables the second-tier
 *    read. It loses to the plainer argument that uncommitted work exists
 *    nowhere but this disk, while ahead and behind describe committed history
 *    that is safe wherever it already is.
 * 7. `diverged`, then `unpushed`, then `behind`. Diverged first because it is
 *    the case that needs a decision rather than a push or a pull; unpushed
 *    ahead of behind because unpushed is the question the header leads on
 *    (design D30) and the two must read in the same order.
 * 8. `no-upstream`, which also takes `gone`: both mean there is no upstream to
 *    measure against. The row still says *which* of the two in its own words,
 *    so the distinction is not lost - only the filing is shared.
 * 9. `clean`.
 *
 * `clean` does not require the working tree to have been counted, and that is a
 * deliberate exception to this file's own rule. The second-tier read ships off,
 * so requiring it would file every row on a default board under `unknown` and
 * empty the word of meaning. Design D27 resolves the ambiguity globally
 * instead: while the read is off the glyph slot is empty on every row and the
 * header states once that uncommitted changes are not being read. What is
 * resolved by a visible control for the whole board does not need resolving
 * again per row - but a row nobody has read at all still does, which is case 2.
 */
export function rowStateOf(row: RepositoryRow): RowState {
  if (row.failure) {
    return 'unreadable';
  }
  if (row.head.kind === 'unknown') {
    return 'unknown';
  }
  if (row.head.kind === 'unborn') {
    return 'unborn';
  }
  if (row.operation) {
    return 'operation';
  }
  if (row.head.kind === 'detached') {
    return 'detached';
  }

  const dirty = dirtyCount(row.workingTree);
  if (dirty !== undefined && dirty > 0) {
    return 'dirty';
  }

  const figures = divergenceFigures(row.divergence);
  if (figures) {
    if (figures.ahead > 0 && figures.behind > 0) {
      return 'diverged';
    }
    if (figures.ahead > 0) {
      return 'unpushed';
    }
    if (figures.behind > 0) {
      return 'behind';
    }
    return 'clean';
  }

  if (row.divergence.kind === 'no-upstream' || row.divergence.kind === 'gone') {
    return 'no-upstream';
  }
  // The read answered for HEAD but left the tracking figures unestablished - a
  // truncated record, a field git did not fill. Reporting that as `clean` would
  // be the wrong impression rather than the missing one.
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/**
 * `^2 v1`, or one arrow, or nothing at all, or a word.
 *
 * Returns `''` when the branch is level with its upstream: twenty rows reading
 * `^0 v0` is twenty pieces of furniture the eye has to step over to find the
 * two rows that are not zero, and the whole value of the board is that the
 * exceptions are the only marks on it. Silence is safe here only because a row
 * that has not answered is in a *stated* reading state on line 2, so this field
 * never has to imply whether the question was asked (design D26).
 *
 * Returns `undefined` when the read established nothing, which is a different
 * silence and is reported as one in the tooltip.
 *
 * Ahead leads. The built-in git extension writes the pair the other way round,
 * and matching a neighbour's convention is normally worth something - but the
 * header leads on unpushed work, and a chip that filters to "these three have
 * work only on this machine" has to land on rows whose first figure is that
 * same number, or the click feels like it went somewhere else.
 *
 * Rejected: `%(upstream:trackshort)`, whose `>`, `<`, `<>`, `=` alphabet is
 * compact and throws away the counts, which are the actionable part.
 */
export function divergenceText(divergence: Divergence): string | undefined {
  switch (divergence.kind) {
    case 'in-sync':
      return '';
    case 'diverged': {
      const parts: string[] = [];
      if (divergence.ahead > 0) {
        parts.push(`↑${divergence.ahead}`);
      }
      if (divergence.behind > 0) {
        parts.push(`↓${divergence.behind}`);
      }
      // A `diverged` carrying two zeros can only reach here from a hand-built
      // value, and it renders as nothing for the same reason `in-sync` does.
      return parts.join(' ');
    }
    case 'no-upstream':
      return 'no upstream';
    case 'gone':
      return 'gone';
    case 'unknown':
      return undefined;
  }
}

/** Whether the divergence field is a word about the branch, which renders dimmed. */
export function divergenceIsWord(divergence: Divergence): boolean {
  return divergence.kind === 'no-upstream' || divergence.kind === 'gone';
}

/**
 * What line 3 says HEAD is doing.
 *
 * The operation wins when there is one. During a rebase HEAD is detached, so
 * without the marker files the row would read `detached at 7c86ebf` - true, and
 * useless at the one moment the reader needs to know what is going on.
 *
 * The rebase form names the branch being rebased, from `rebase-merge/head-name`.
 * It deliberately does not name what is being rebased *onto*: `rebase-merge/onto`
 * holds a raw object id rather than a name, and resolving it would cost a second
 * process and, where several refs point at that commit, would be a guess. The
 * tooltip quotes the id as it was read.
 *
 * A step count is printed only when both halves were recovered. "rebasing main"
 * with no numbers is a true and useful sentence; "rebasing main 1/?" is not.
 */
export function headStateText(head: HeadState, operation?: Operation): string {
  if (operation) {
    return operationText(operation);
  }
  switch (head.kind) {
    case 'branch':
      return head.name;
    case 'detached':
      return `detached at ${shortSha(head.sha)}`;
    case 'unborn':
      // The branch name is worth keeping: it is the branch the first commit
      // will land on, and it is the only thing about HEAD that is true yet.
      return head.name ? `${head.name} · no commits yet` : 'no commits yet';
    case 'unknown':
      // Nothing has answered. Line 2 says `reading...` where the reader is
      // already looking; repeating it here would spend line 3 on the same word.
      return '';
  }
}

function operationText(operation: Operation): string {
  switch (operation.kind) {
    case 'merge':
      return 'merging';
    case 'cherry-pick':
      return 'cherry-picking';
    case 'revert':
      return 'reverting';
    case 'bisect':
      return 'bisecting';
    case 'rebase': {
      const parts = ['rebasing'];
      if (operation.branch) {
        parts.push(operation.branch);
      }
      if (operation.step !== undefined && operation.total !== undefined) {
        parts.push(`${operation.step}/${operation.total}`);
      }
      return parts.join(' ');
    }
  }
}

/**
 * `*` for working-tree changes, `+` for staged, `!` for conflicts - and
 * `undefined` when nobody has looked.
 *
 * These three are not invented. They are the markers the built-in git extension
 * already puts in its own status-bar text in the same window, so a reader who
 * has used VS Code for a week can already read them. Rejected: a second glyph
 * vocabulary for the same three facts.
 *
 * Rejected: a count of changed files. Core's own judgement is visible in its
 * default - `scm.providerCountBadge` is `hidden`, so the count is off out of the
 * box while the markers are on - and a count invites arithmetic across rows that
 * means nothing, because porcelain v2 counts entries, not units of review.
 *
 * `undefined` and `''` are different answers and both draw as nothing: `''` is a
 * tree that was counted and is clean, `undefined` is a tree nobody counted. The
 * page renders a dimmed placeholder for the second only while the second-tier
 * read is on, because that is the only time the ambiguity is local rather than
 * already answered by the header (design D27).
 */
export function dirtyText(tree: WorkingTree): string | undefined {
  if (tree.kind !== 'counted') {
    return undefined;
  }
  const { staged, unstaged, untracked, conflicted } = tree.counts;
  let glyphs = '';
  if (unstaged > 0 || untracked > 0) {
    glyphs += '*';
  }
  if (staged > 0) {
    glyphs += '+';
  }
  if (conflicted > 0) {
    glyphs += '!';
  }
  return glyphs;
}

/**
 * `checked 2h ago`, or nothing at all.
 *
 * The word is `checked`, never `fetched`, `in sync` or `up to date`. What the
 * mtime of `FETCH_HEAD` proves is that a fetch *ran*: git touches the file when
 * the fetch changed nothing, and truncates it to zero bytes but still touches it
 * when the fetch failed. So the strongest honest claim is that something was
 * checked at that time (design D18).
 *
 * When the file is absent this returns `undefined` and the row says nothing
 * there. Rejected: `never checked`, which is false immediately after a clone -
 * the commonest case of an absent `FETCH_HEAD` is a repository that is perfectly
 * current. The tooltip carries the reason for the silence instead.
 */
export function freshnessText(fetch: FetchEvidence, now: number): string | undefined {
  if (fetch.kind === 'no-record') {
    return undefined;
  }
  return `checked ${relativeAge(fetch.at, now)}`;
}

/**
 * `worktree`, `submodule`, `bare`, `shallow` - and nothing for an ordinary
 * repository, so the marker's presence is itself the signal.
 *
 * The kind wins over shallowness when a repository is both, because the kind is
 * what explains why the row exists at all - a submodule appearing beside its
 * parent needs a word more than a truncated history does. The shallowness is
 * still stated, in the tooltip, where it also gets the sentence it needs about
 * what it does to the divergence figures.
 */
/**
 * Line 3: `2 PR`, `2 MR`, or nothing.
 *
 * Nothing in three different cases, and that is the point of the type behind
 * it: nobody asked (the forge layer is off, or this host has no client), the
 * question failed, or the answer was none. The first two must not render as a
 * zero, and the third has nothing worth a field - a board of forty rows each
 * saying `0 PR` spends its narrowest line telling the reader nothing happened.
 *
 * The unpluralised form is deliberate. `2 PRs` and `1 PR` differ by a character
 * that carries no information and costs a re-measure of the column, and every
 * forge's own interface writes the abbreviation as a unit.
 */
export function reviewText(review: ReviewState | undefined, kind: ForgeKind | undefined): string | undefined {
  if (review === undefined || review.kind === 'unavailable') {
    return undefined;
  }
  if (review.open <= 0) {
    return undefined;
  }
  // `41+` when the query stopped at its limit: a floor drawn as a total would
  // be a number the extension never established.
  const figure = review.atLeast === true ? `${review.open}+` : String(review.open);
  return `${figure} ${kind === 'gitlab' ? 'MR' : 'PR'}`;
}

export function kindMarker(repository: DiscoveredRepository): string | undefined {
  if (repository.kind !== 'plain') {
    return repository.kind;
  }
  return repository.shallow ? 'shallow' : undefined;
}

/**
 * Why the row could not be read, with the command that failed, verbatim.
 *
 * The command is the point. This extension's whole claim is that everything it
 * runs is a read, and the way a reader checks that claim - or debugs a
 * repository git is refusing - is by retyping the command in their own shell. A
 * row that says "could not read" without saying what was run is unfalsifiable,
 * and an unfalsifiable claim from a status board is worth nothing.
 */
export function unreadableText(failure: ReadFailure): string {
  const lines = [`not readable — ${failure.summary}`, `The command was: ${failure.command}`];
  const said = firstLine(failure.stderr);
  if (said) {
    lines.push(`git said: ${said}`);
  }
  return lines.join('\n');
}

function firstLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const [first = ''] = trimmed.split(/\r?\n/, 1);
  return first;
}

// ---------------------------------------------------------------------------
// Line 2
// ---------------------------------------------------------------------------

/**
 * The sentence in the subject's place when there is no subject.
 *
 * Every one of these is a stated condition rather than a blank: a blank line 2
 * is indistinguishable from a row that is still loading, and the reader would
 * have no way to tell which of the three it was looking at (design D35).
 */
function subjectFor(row: RepositoryRow): string {
  if (row.failure) {
    return `not readable — ${row.failure.summary}`;
  }
  if (row.head.kind === 'unknown') {
    return 'reading…';
  }
  if (row.head.kind === 'unborn') {
    return 'no commits yet';
  }
  if (row.lastCommit) {
    return row.lastCommit.subject;
  }
  // HEAD answered but no commit came back with it - a record that stopped
  // short, a field git did not fill. Leaving line 2 blank here would make the
  // row indistinguishable from one that is still loading, so the shortfall is
  // stated instead.
  return row.incomplete ? `read did not finish: ${row.incomplete}` : 'no commit was read';
}

// ---------------------------------------------------------------------------
// The tooltip
// ---------------------------------------------------------------------------

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The row spelled out.
 *
 * Everything the glyphs abbreviate is written here as a sentence, so the arrows
 * and the three dirt markers never have to be learned and a high-contrast theme
 * that flattens colour loses nothing. It is also the only place the absolute
 * commit time appears, because two relative dates cannot be compared against
 * each other precisely.
 */
function divergenceSentence(divergence: Divergence): string {
  switch (divergence.kind) {
    case 'in-sync':
      return (
        `Level with ${divergence.upstream}, measured against the remote-tracking` +
        ' ref on this disk - which is as old as the last fetch.'
      );
    case 'diverged': {
      const here = `${plural(divergence.ahead, 'commit')} here ${divergence.ahead === 1 ? 'is' : 'are'} not on ${divergence.upstream}`;
      const there = `${plural(divergence.behind, 'commit')} on ${divergence.upstream} ${divergence.behind === 1 ? 'is' : 'are'} not here`;
      return `${here}; ${there}. Measured against the remote-tracking ref on this disk, which is as old as the last fetch.`;
    }
    case 'no-upstream':
      return 'This branch tracks nothing, so there is no divergence to measure.';
    case 'gone':
      return `The upstream ${divergence.upstream} no longer exists on the remote.`;
    case 'unknown':
      return 'How far this branch stands from its upstream was not established.';
  }
}

function fetchSentence(fetch: FetchEvidence, now: number): string {
  if (fetch.kind === 'no-record') {
    return (
      'There is no FETCH_HEAD in this repository, so nothing is known about when it' +
      ' last heard from its remote. That is the normal state of a fresh clone.'
    );
  }
  return (
    `Last fetch attempt ${relativeAge(fetch.at, now)}. FETCH_HEAD records an attempt,` +
    ' not a success: git touches it even when the fetch reached nothing.'
  );
}

function workingTreeSentence(tree: WorkingTree, repository: DiscoveredRepository): string {
  if (repository.kind === 'bare') {
    return 'A bare repository has no working tree, so uncommitted changes do not apply.';
  }
  switch (tree.kind) {
    case 'not-read':
      return 'Uncommitted changes have not been read for this repository.';
    case 'incomplete':
      return `Uncommitted changes could not be read: ${tree.reason}`;
    case 'counted': {
      const { staged, unstaged, untracked, conflicted } = tree.counts;
      const present: string[] = [];
      if (unstaged > 0) {
        present.push('changes not staged');
      }
      if (untracked > 0) {
        present.push('untracked files');
      }
      if (staged > 0) {
        present.push('staged changes');
      }
      if (conflicted > 0) {
        present.push('conflicts');
      }
      // Categories, never counts: a number here would be the same arithmetic
      // across rows that the glyphs exist to avoid.
      return present.length > 0
        ? `Working tree holds ${present.join(', ')}.`
        : 'Working tree is clean.';
    }
  }
}

function kindSentence(repository: DiscoveredRepository): string | undefined {
  switch (repository.kind) {
    case 'worktree':
      return 'A linked worktree: it shares an object store with the repository it was created from.';
    case 'submodule':
      return 'A submodule checked out inside another repository.';
    case 'bare':
      return 'A bare repository: it has no working tree.';
    case 'plain':
      return undefined;
  }
}

function operationSentence(operation: Operation): string {
  const detail: string[] = [];
  if (operation.branch) {
    detail.push(`on ${operation.branch}`);
  }
  if (operation.step !== undefined && operation.total !== undefined) {
    detail.push(`at step ${operation.step} of ${operation.total}`);
  }
  if (operation.onto) {
    // `rebase-merge/onto` holds a raw object id, so it is quoted as it was read
    // rather than resolved to a branch name, which would be a guess.
    detail.push(`onto ${shortSha(operation.onto)}`);
  }
  const tail = detail.length > 0 ? ` ${detail.join(', ')}` : '';
  return `A ${operation.kind} was left running${tail}.`;
}

function tooltipFor(row: RepositoryRow, now: number): string {
  const repository = row.repository;
  const lines: string[] = [repositoryName(repository), repository.path];

  if (row.failure) {
    lines.push('', unreadableText(row.failure));
    if (repository.problem) {
      lines.push(repository.problem);
    }
    return lines.join('\n');
  }

  if (row.head.kind === 'unknown') {
    lines.push('', 'Discovered. No git process has answered for it yet.');
    return lines.join('\n');
  }

  lines.push('', headStateText(row.head, row.operation));
  if (row.operation) {
    lines.push(operationSentence(row.operation));
  }

  if (row.lastCommit) {
    lines.push(
      '',
      `${absoluteTime(row.lastCommit.committedAt)}  ${row.lastCommit.shortSha}  ${row.lastCommit.author}`,
      row.lastCommit.subject,
    );
  } else if (row.head.kind === 'unborn') {
    lines.push('', 'Nothing has been committed here yet.');
  }

  lines.push('', divergenceSentence(row.divergence), fetchSentence(row.fetch, now));
  lines.push(workingTreeSentence(row.workingTree, repository));

  const kind = kindSentence(repository);
  if (kind) {
    lines.push(kind);
  }
  if (repository.shallow) {
    lines.push(
      'A shallow clone: the history is truncated, so the figures above are measured' +
        ' against an incomplete graph.',
    );
  }
  if (repository.problem) {
    lines.push(repository.problem);
  }
  if (row.incomplete) {
    lines.push(`This read did not finish: ${row.incomplete}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Names that collide
// ---------------------------------------------------------------------------

/**
 * How many ancestor segments the walk will add before giving up.
 *
 * A guard, not a tuning figure: two repositories that still share a name six
 * levels up are distinguished by the tooltip's full path anyway, and an
 * unbounded walk on a pathological layout would put most of a path in the
 * name slot, which is the unreadable row this disambiguation exists to avoid.
 */
const MAX_QUALIFIER_DEPTH = 4;

/**
 * The dimmed segment drawn ahead of a name that another row also uses.
 *
 * A directory holding `client/api` and `server/api` produces two rows reading
 * `api`, and two rows that read identically are worse than one row that reads
 * long: the reader cannot tell which repository they are about to open. So the
 * *nearest distinguishing* ancestor goes in front, and only for the rows that
 * collide - every other row keeps its bare name (design D23).
 *
 * Rejected: rendering the full path on every row, which is unreadable in a
 * sidebar and spends the width the commit subject needs.
 *
 * Keyed by `pathKey`, so the same repository arriving in two spellings - the
 * editor's index and a settings entry disagree about slashes and, on Windows,
 * about case - is one entry rather than two.
 */
export function nameQualifiers(
  repositories: readonly DiscoveredRepository[],
): Map<string, string> {
  const qualifiers = new Map<string, string>();
  const byName = new Map<string, DiscoveredRepository[]>();
  for (const repository of repositories) {
    const name = repositoryName(repository).toLowerCase();
    const group = byName.get(name);
    if (group) {
      group.push(repository);
    } else {
      byName.set(name, [repository]);
    }
  }

  for (const group of byName.values()) {
    if (group.length < 2) {
      continue;
    }
    const segments = group.map((repository) => normalizePath(repository.path).split(/[\\/]+/));
    for (let depth = 1; depth <= MAX_QUALIFIER_DEPTH; depth += 1) {
      const suffixes = segments.map((parts) => tailOf(parts, depth + 1).join('/').toLowerCase());
      const distinct = new Set(suffixes).size === suffixes.length;
      if (!distinct && depth < MAX_QUALIFIER_DEPTH) {
        continue;
      }
      group.forEach((repository, index) => {
        const parts = segments[index] ?? [];
        const ancestors = tailOf(parts, depth + 1).slice(0, -1);
        if (ancestors.length > 0) {
          qualifiers.set(pathKey(repository.path), ancestors.join('/'));
        }
      });
      break;
    }
  }
  return qualifiers;
}

function tailOf(parts: readonly string[], count: number): string[] {
  return parts.slice(Math.max(0, parts.length - count));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface RowOptions {
  /** Which forge this repository points at, so the count is labelled PR or MR. */
  forge?: ForgeKind;
  /**
   * The instant the row is rendered at, in milliseconds since the epoch.
   *
   * Passed in rather than read from the clock so that every string this module
   * returns is a function of its inputs, and so the page can recompute the
   * relative dates on its own timer without a git process running (design D25).
   */
  readonly now: number;
  /** The dimmed ancestor segment, from `nameQualifiers`, when this name collides. */
  readonly qualifier?: string;
}

/**
 * One row, every field decided.
 *
 * Takes the qualifier from its caller rather than computing it, because
 * whether a name collides is a fact about the whole board and this function
 * knows about one repository. `buildRows` puts the two together; `buildRow`
 * stays callable on its own so a single arriving answer can be re-rendered
 * without touching any other row (design D22).
 */
export function buildRow(row: RepositoryRow, options: RowOptions): RenderedRow {
  const repository = row.repository;
  const divergence = divergenceText(row.divergence);
  const dirty = dirtyText(row.workingTree);
  const freshness = freshnessText(row.fetch, options.now);
  const kind = kindMarker(repository);
  const review = reviewText(row.review, options.forge);

  // Each optional field is spread in only when it exists, rather than assigned
  // as `undefined`. An absent key then means in the rendered row exactly what it
  // means in the model - nobody established this - and a test comparing two rows
  // cannot pass by matching one silence against another.
  return {
    path: repository.path,
    state: rowStateOf(row),
    name: repositoryName(repository),
    ...(options.qualifier ? { qualifier: options.qualifier } : {}),
    ...(divergence !== undefined ? { divergence } : {}),
    divergenceDimmed: divergenceIsWord(row.divergence),
    ...(dirty !== undefined ? { dirty } : {}),
    ...(freshness !== undefined ? { freshness } : {}),
    ...(row.lastCommit ? { age: relativeAge(row.lastCommit.committedAt, options.now) } : {}),
    subject: subjectFor(row),
    headState: headStateText(row.head, row.operation),
    ...(kind ? { kind } : {}),
    ...(review !== undefined ? { review } : {}),
    tooltip: tooltipFor(row, options.now),
    ...(row.failure ? { unreadableReason: unreadableText(row.failure) } : {}),
  };
}

/** Every row, with colliding names disambiguated against each other. */
export function buildRows(rows: readonly RepositoryRow[], now: number): RenderedRow[] {
  const qualifiers = nameQualifiers(rows.map((row) => row.repository));
  return rows.map((row) => {
    const qualifier = qualifiers.get(pathKey(row.repository.path));
    const forge = forgeOf(row);
    return buildRow(row, {
      now,
      ...(qualifier ? { qualifier } : {}),
      ...(forge ? { forge } : {}),
    });
  });
}

/**
 * Which forge a row's remote points at, for the PR/MR label alone.
 *
 * Re-derived here rather than carried on the row: the row already holds the
 * review count, and threading the forge kind alongside it would put the same
 * fact in two places that could disagree. The parse is a string split and runs
 * once per rendered row.
 */
function forgeOf(row: RepositoryRow): ForgeKind | undefined {
  const url = row.remoteUrl;
  if (url === undefined) {
    return undefined;
  }
  const target = parseForgeTarget(url);
  return target ? forgeKindOf(target.host) : undefined;
}
