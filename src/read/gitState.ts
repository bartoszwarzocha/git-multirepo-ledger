/**
 * The state a git process would not tell us: what operation was left running,
 * and when the repository last reached for its remote.
 *
 * Both come off the filesystem at zero process cost, and both have to, for
 * different reasons. `git status --porcelain=v2` does not mention a merge, a
 * rebase, a cherry-pick, a revert or a bisect anywhere in its output - the
 * whole mid-operation dimension is absent from the format - so a row that
 * wanted it from a process would need a second one, and process count is the
 * budget the entire read is planned against. Fetch age has no porcelain at all:
 * `git fetch --dry-run` is not a probe, it downloads the whole payload, and the
 * only local record of an attempt is a file's modification time.
 *
 * Nothing here imports `vscode`, and nothing here writes.
 *
 * **These paths are not in `gitrepository-layout`.** `MERGE_HEAD`,
 * `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_START`, `rebase-merge/` and
 * `rebase-apply/` are git's implementation detail: stable for many years and
 * read the same way by every prompt script in existence, but not a published
 * interface, and free to change in a release this extension will never be
 * rebuilt for. So every read below degrades in one direction only - a missing
 * or unreadable file means "nothing is known", never an exception and never a
 * substituted value. The worst a future git can do to this module is make it
 * quiet.
 *
 * The same rule sets the shape of the details: the operation is reported the
 * moment its directory exists, and the step, total and branch are added only
 * when their files parse. "Rebasing" with no step count is true and useful;
 * "rebasing 1/1" invented from a missing file is neither.
 *
 * What is deliberately *not* here is shallowness. It is the same kind of fact -
 * one file, no process - but `read/classify.ts` already establishes it while it
 * is resolving the git directory, and a fact with two owners is a fact that can
 * be reported two ways in the same pass.
 */

import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

import { shortSha } from '../model/keys.ts';
import type { FetchEvidence, Operation, OperationKind } from '../model/types.ts';
import { readTextSafe, statSafe } from '../util/fsx.ts';
import { parseRemotes, primaryRemote } from '../forge/remote.ts';

/** What one repository's git directory says about itself, with no git run. */
export interface GitState {
  /** The primary remote's URL, when `.git/config` names one. */
  readonly remoteUrl?: string;
  /** Absent when nothing was left running, which is the ordinary case. */
  readonly operation?: Operation;
  readonly fetch: FetchEvidence;
}

/**
 * Marker files that name an operation on their own.
 *
 * The order is the precedence, and only the first two lines of it are
 * interesting: an unfinished rebase can leave `MERGE_HEAD` behind as well,
 * because the merge backend replays a conflicting `merge` command exactly the
 * way `git merge` does. Reporting that as a merge would point the reader at the
 * wrong exit - the way out is `git rebase --continue`, not `git commit` - so
 * the enclosing operation is checked first and wins.
 *
 * Below that the cases are mutually exclusive in practice, and the order simply
 * matches what `git status` itself checks.
 */
const MARKER_FILES: ReadonlyArray<readonly [string, OperationKind]> = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_START', 'bisect'],
];

/**
 * A cap on the detail files, not a buffer size.
 *
 * These files hold one short line each, so anything larger is a corrupt or
 * hostile git directory rather than a rebase - and this extension reads
 * directories nobody vouched for, including vendored checkouts and mirrors the
 * user never opened. Reading whole files would let one of them decide how much
 * memory the extension host allocates.
 */
const DETAIL_MAX_BYTES = 4096;

/**
 * Everything this module knows about one repository.
 *
 * `gitDir` is the *per-worktree* git directory - the one a `.git` file pointed
 * at, for a linked worktree or a submodule. That is the right directory for
 * both answers here, which was checked rather than assumed: a linked worktree
 * gets its own `FETCH_HEAD` and its own `rebase-merge/`, and the main
 * repository's copies say nothing about it.
 */
export async function readGitState(gitDir: string): Promise<GitState> {
  const [operation, fetch, remoteUrl] = await Promise.all([
    readOperation(gitDir),
    readFetchEvidence(gitDir),
    readRemoteUrl(gitDir),
  ]);
  return {
    fetch,
    ...(operation ? { operation } : {}),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}

/**
 * What git was in the middle of when it last stopped, or `undefined` when it
 * was in the middle of nothing.
 *
 * One directory listing decides it, rather than a stat per marker: the answer
 * is almost always "nothing", and the listing costs the same whether it rules
 * out one marker or six. An unreadable git directory returns `undefined` for
 * the same reason a missing marker does - the row read is about to run a real
 * git command in the same directory and will report the refusal in git's own
 * words, and a second, quieter failure invented here would only compete with
 * it.
 */
export async function readOperation(gitDir: string): Promise<Operation | undefined> {
  const names = await listNames(gitDir);
  if (!names) {
    return undefined;
  }
  // The two rebase backends keep the same facts under different names. The
  // merge backend (`rebase-merge/`) is the default and counts in `msgnum` and
  // `end`; the apply backend (`rebase-apply/`, still reached by `git rebase
  // --apply` and by `git am`) counts in `next` and `last`.
  if (names.has('rebase-merge')) {
    return readRebase(path.join(gitDir, 'rebase-merge'), 'msgnum', 'end');
  }
  if (names.has('rebase-apply')) {
    return readRebase(path.join(gitDir, 'rebase-apply'), 'next', 'last');
  }
  for (const [file, kind] of MARKER_FILES) {
    if (names.has(file)) {
      return { kind };
    }
  }
  return undefined;
}

/**
 * When this repository last *attempted* a fetch.
 *
 * "Attempted" is the whole of what `FETCH_HEAD` proves, and the row is built on
 * that word: git touches the file when a fetch returns nothing new, truncates
 * it to zero bytes but still touches it when the fetch fails, never writes it
 * at all during a clone, and skips it entirely under `--no-write-fetch-head`.
 * So its mtime is evidence that somebody asked the remote a question, and is
 * not evidence that the answer arrived.
 *
 * Absence therefore has to mean "no record", never "up to date". Every
 * divergence figure the extension shows is computed against a remote-tracking
 * ref that is exactly as old as the last successful fetch, and a freshly cloned
 * repository - which has no `FETCH_HEAD` at all, verified - is the case where
 * a confident "in sync" would be most believable and least founded.
 *
 * An unreadable git directory lands in `no-record` too. The distinction between
 * "no file" and "could not look" is real, but both must render as silence, and
 * `FetchEvidence` deliberately has no third case to say the difference in.
 */
export async function readFetchEvidence(gitDir: string): Promise<FetchEvidence> {
  const stats = await statSafe(path.join(gitDir, 'FETCH_HEAD'));
  if (!stats) {
    return { kind: 'no-record' };
  }
  // Whole seconds, matching `%(committerdate:unix)`, so that everything the row
  // dates is dated in one unit and nothing has to remember which.
  return { kind: 'attempted', at: Math.floor(stats.mtimeMs / 1000) };
}

/**
 * A rebase, with whatever the backend recorded about where it had got to.
 *
 * The operation is returned even when every detail file is missing, because the
 * directory's existence is the fact that matters to the reader: this checkout
 * is mid-flight and the next command they run in it will not do what they
 * expect. The step, total and branch are decoration on that.
 */
async function readRebase(
  directory: string,
  stepFile: string,
  totalFile: string,
): Promise<Operation> {
  const [step, total, headName, onto] = await Promise.all([
    readCount(path.join(directory, stepFile)),
    readCount(path.join(directory, totalFile)),
    readDetail(path.join(directory, 'head-name')),
    readDetail(path.join(directory, 'onto')),
  ]);

  // Built as a mutable draft and returned as the readonly type, because the
  // alternative - a literal with four conditional spreads - hides which fields
  // are optional behind punctuation.
  const operation: {
    kind: OperationKind;
    step?: number;
    total?: number;
    branch?: string;
    onto?: string;
  } = { kind: 'rebase' };

  if (step !== undefined) {
    operation.step = step;
  }
  if (total !== undefined) {
    operation.total = total;
  }
  const branch = branchFromHeadName(headName);
  if (branch !== undefined) {
    operation.branch = branch;
  }
  // `onto` holds a full object id and no name: git records the commit it is
  // replaying onto, not how the user spelled it, so `git rebase main` and `git
  // rebase 86770e7` leave the same file behind. Abbreviating it is therefore
  // not a fallback for a name that was there - there is no name anywhere in the
  // directory - and it matches what git itself prints, "You are currently
  // rebasing branch 'topic' on '86770e7'".
  if (onto !== undefined && /^[0-9a-f]{4,64}$/.test(onto)) {
    operation.onto = shortSha(onto);
  }
  return operation;
}

/**
 * The branch being rebased, from a `head-name` that holds a full ref.
 *
 * Anything that is not a `refs/heads/` ref yields nothing. That is not
 * defensive coding: rebasing a detached HEAD writes the literal string
 * `detached HEAD` into this file, verified, and a row reading "rebasing
 * detached HEAD" would be a phrase git never says about a branch that does not
 * exist.
 */
function branchFromHeadName(headName: string | undefined): string | undefined {
  const prefix = 'refs/heads/';
  if (headName === undefined || !headName.startsWith(prefix)) {
    return undefined;
  }
  const name = headName.slice(prefix.length);
  return name.length > 0 ? name : undefined;
}

/**
 * A step counter, or nothing.
 *
 * Both backends count from one, so a zero is not a rebase that has not started:
 * it is a file that does not hold what this module thinks it holds. Reporting
 * "rebasing" without a step is the honest reading of that, and "rebasing 0/3"
 * is not.
 */
async function readCount(file: string): Promise<number | undefined> {
  const text = await readDetail(file);
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The first line of a small file, capped, or `undefined` for anything that did
 * not read as one.
 *
 * The cap is why this opens a handle instead of calling `readFile`: the point
 * is to never hold more than `DETAIL_MAX_BYTES` of a file this extension did
 * not write, and reading it all and then slicing would have allocated it first.
 */
async function readDetail(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(DETAIL_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, DETAIL_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const firstLine = text.split('\n', 1)[0] ?? '';
    const trimmed = firstLine.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The entries of a directory as a set, or `undefined` when it could not be listed. */
async function listNames(directory: string): Promise<Set<string> | undefined> {
  try {
    return new Set(await fsp.readdir(directory));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ages
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Days per month and per year, used for nothing finer than choosing a word.
 *
 * Calendar arithmetic is deliberately not done here. It would make the answer
 * depend on the reader's time zone and on which months the interval crossed,
 * for a caption whose entire job is to say "a while ago" - and it would make
 * this function untestable without freezing a zone as well as a clock.
 */
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365;

/**
 * How long ago a moment was, in English, for the row.
 *
 * This exists because git's own `%(committerdate:relative)` is localised: on a
 * machine whose git speaks German the row would read `vor 2 Stunden` in the
 * middle of an English-only interface, and the extension cannot tell from the
 * output that it happened. Taking `%(committerdate:unix)` and formatting it
 * here also means the same words date a commit and a fetch, which are two
 * different git formats otherwise.
 *
 * Both arguments are whole seconds since the epoch, the unit
 * `%(committerdate:unix)` and `FetchEvidence.at` both use. `now` is an argument
 * rather than a call to `Date.now()` inside, so that the boundaries are
 * testable at all: a function that reads the clock can only be tested by
 * arranging for the clock to say something, which is how relative-date code
 * ends up with tests that pass in one time zone.
 *
 * The units get shorter as they get commoner: minutes, hours and days are the
 * ages a watched repository actually has, they appear on every row, and `3d`
 * costs a third of the width of `3 days` in a sidebar that is already fighting
 * for it. Weeks, months and years are rare enough that the space is affordable
 * and `6w` would be a small puzzle where `6 weeks` is not.
 *
 * **Two of the results are complete phrases, not durations**: `just now` and
 * `in the future`. A caller composing a caption cannot blindly append "ago" -
 * `checked just now ago` - and must either use the value as it stands or
 * special-case those two. That trade was taken deliberately: the alternative is
 * a bare duration for a commit dated after the clock, and there is no honest
 * one.
 */
export function formatRelativeAge(at: number, now: number): string {
  const elapsed = now - at;

  // A commit or a fetch dated slightly ahead of the clock is ordinary - an
  // unsynchronised machine, a repository cloned from one, a commit date carried
  // over by a rebase - and reading a minute of that as "the future" would be
  // alarming about nothing. Beyond a minute it is said plainly rather than
  // clamped to zero, because a repository whose newest commit is dated next
  // week is something the reader wants to know about.
  if (elapsed < -MINUTE) {
    return 'in the future';
  }
  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }

  const days = Math.floor(elapsed / DAY);
  if (days < 7) {
    return `${days}d`;
  }
  // Weeks run to a full month rather than handing over at 28 days, so that no
  // interval falls through to "0 months".
  if (days <= 30) {
    return plural(Math.floor(days / 7), 'week');
  }
  if (days < DAYS_PER_YEAR) {
    return plural(Math.floor(days / DAYS_PER_MONTH), 'month');
  }
  return plural(Math.floor(days / DAYS_PER_YEAR), 'year');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * The clock, in the unit everything else here is in.
 *
 * Exported so that no caller has to remember that `Date.now()` is milliseconds
 * and every date in this model is seconds; a single missing division puts a row
 * fifty-five thousand years in the future.
 */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Where the repository publishes
// ---------------------------------------------------------------------------

/**
 * The primary remote's URL, read from `.git/config`.
 *
 * Zero processes, for the same reason everything else in this file is: asking
 * git costs a spawn per repository, and spawn count is the budget of the whole
 * board. The file is small and its `[remote "..."] url` lines are the only part
 * that is read.
 *
 * Absent when there is no remote, which is a state rather than a failure - a
 * repository nobody publishes has no review question to answer - and absent
 * again when the file cannot be read, because a remote guessed at would send a
 * forge query to the wrong owner.
 */
export async function readRemoteUrl(gitDir: string): Promise<string | undefined> {
  const text = await readTextSafe(path.join(gitDir, 'config'));
  if (text === undefined) {
    return undefined;
  }
  return primaryRemote(parseRemotes(text))?.url;
}
