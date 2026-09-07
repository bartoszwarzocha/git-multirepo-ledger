/**
 * What order the board is in, what it is narrowed to, and what the header counts.
 *
 * Three questions rather than one file's worth of coincidence: the ordering is
 * the extension's whole differentiator - nothing else sorts a set of
 * repositories by the last commit in each - and the filters and the tally are
 * the same set of facts asked in the other direction, so a chip that says three
 * repositories hold unpushed work and a click that leaves three rows on screen
 * cannot disagree.
 *
 * Every judgement here reads the *facts* on a `RepositoryRow`, not the single
 * word `rowStateOf` files the row under. That is deliberate and it is the
 * reason the two live in different modules. A repository is routinely dirty and
 * behind and detached at once; the row's accent has to choose one of those, but
 * the `unpushed` chip must still find a repository whose row is painted `dirty`,
 * or the header would be counting one thing and the filter showing another.
 *
 * No `vscode` import, and no clock: nothing here depends on when it runs.
 */

import { pathKey } from '../model/keys.ts';
import type {
  FilterMode,
  RepositoryRow,
  SortMode,
  Tally,
} from '../model/types.ts';
import { divergenceFigures, dirtyCount, repositoryName, rowStateOf } from './row.ts';

// ---------------------------------------------------------------------------
// The facts the filters and the tally both ask about
// ---------------------------------------------------------------------------

/** Commits that exist only on this machine. */
export function isUnpushed(row: RepositoryRow): boolean {
  const figures = divergenceFigures(row.divergence);
  return figures !== undefined && figures.ahead > 0;
}

/** The upstream, as it stood at the last fetch, holds commits this checkout does not. */
export function isBehind(row: RepositoryRow): boolean {
  const figures = divergenceFigures(row.divergence);
  return figures !== undefined && figures.behind > 0;
}

/**
 * Uncommitted work, established by a read that ran.
 *
 * A tree nobody counted is not dirty and is not clean, and this returning
 * `false` for it is not a claim that it is clean - it is the absence of a claim.
 * The header states the difference once, for the whole board, because while the
 * second-tier read is off it is true of every row at once (design D27).
 */
export function isDirty(row: RepositoryRow): boolean {
  const count = dirtyCount(row.workingTree);
  return count !== undefined && count > 0;
}

/**
 * The states that need a person to decide something.
 *
 * Detached, mid-operation, unborn, and no upstream to push to. None of them is
 * an error and none of them is progress; each is a repository waiting on a
 * choice nobody has made. An unreadable repository is excluded because it is
 * counted, and reachable, under its own heading - a repository git refused
 * needs a different response from a repository stopped mid-rebase.
 */
export function needsAttention(row: RepositoryRow): boolean {
  if (row.failure) {
    return false;
  }
  return (
    row.operation !== undefined ||
    row.head.kind === 'detached' ||
    row.head.kind === 'unborn' ||
    row.divergence.kind === 'no-upstream' ||
    row.divergence.kind === 'gone'
  );
}

export function isUnreadable(row: RepositoryRow): boolean {
  return row.failure !== undefined;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Which of the three ranks a row sorts into, ahead of any mode's key.
 *
 * 0. It has a key for this mode.
 * 1. It has none. A repository with no commits has no committer date; one with
 *    no upstream has no divergence figure. **Neither sorts as zero.** A
 *    repository with no commits at the top of "most recently committed" would
 *    be a lie about which repository moved last, and slipping it in among the
 *    dated ones by pretending its date is the epoch would hide it at the
 *    bottom with no explanation. It goes into a group of its own, whose rows
 *    say on line 2 why they are there.
 * 2. Unreadable, last. Burying them is only acceptable because the header
 *    carries their count with one click to reach them.
 */
const KEYED = 0;
const KEYLESS = 1;
const UNREADABLE = 2;

interface Entry {
  readonly row: RepositoryRow;
  readonly rank: number;
  /**
   * The ordering key, already negated where the mode reads descending, so the
   * comparator is a single subtraction and no mode can be sorted the wrong way
   * by a missing sign somewhere else.
   */
  readonly primary: number;
  /** Broken out of `primary` where a mode needs a second figure; 0 otherwise. */
  readonly secondary: number;
  /** The `name` mode's key. Compared with `localeCompare`, so it is not a number. */
  readonly name: string;
  /**
   * The final tie-break: the case-folded absolute path.
   *
   * Rejected: the repository's name, which two repositories can share - and a
   * tie that is not broken lets them swap places between two passes over
   * identical data, which is a row moving for no reason the reader can see.
   */
  readonly tie: string;
}

function entryFor(row: RepositoryRow, mode: SortMode): Entry {
  const base = {
    row,
    name: repositoryName(row.repository),
    tie: pathKey(row.repository.path),
  };
  if (isUnreadable(row)) {
    return { ...base, rank: UNREADABLE, primary: 0, secondary: 0 };
  }

  switch (mode) {
    case 'recent': {
      const at = row.lastCommit?.committedAt;
      return at === undefined
        ? { ...base, rank: KEYLESS, primary: 0, secondary: 0 }
        : { ...base, rank: KEYED, primary: -at, secondary: 0 };
    }
    case 'name':
      // Every readable repository has a name, so this mode has no keyless
      // group; the comparator falls straight through to `localeCompare`.
      return { ...base, rank: KEYED, primary: 0, secondary: 0 };
    case 'divergence': {
      const figures = divergenceFigures(row.divergence);
      return figures === undefined
        ? { ...base, rank: KEYLESS, primary: 0, secondary: 0 }
        : {
            ...base,
            rank: KEYED,
            primary: -(figures.ahead + figures.behind),
            // Ties broken by ahead, descending: work that exists only here is
            // more urgent than work that exists only there.
            secondary: -figures.ahead,
          };
    }
    case 'dirty': {
      const count = dirtyCount(row.workingTree);
      return count === undefined
        ? { ...base, rank: KEYLESS, primary: 0, secondary: 0 }
        : { ...base, rank: KEYED, primary: -count, secondary: 0 };
    }
  }
}

/**
 * The board, in order.
 *
 * The comparator is a **total order over each row's own data**, and that is what
 * makes the ordering safe while answers are still arriving. Rows land one at a
 * time over several seconds; if the order of two rows depended on anything but
 * those two rows - an index, an arrival number, the stability of the underlying
 * sort - then a third row answering could move them, and a row moving under the
 * pointer is a click that goes somewhere the reader did not choose.
 *
 * With this comparator an arriving answer can move at most the row it answered
 * for: every other pair still compares exactly as it did before. The page has
 * one more guard on top of that, holding the re-order while the pointer is
 * inside the list, but the guard would not be enough on its own and this is why.
 *
 * Rejected: relying on `Array.prototype.sort` being stable. It is, in every
 * engine this runs on - and a stable sort only preserves the order of rows the
 * comparator calls *equal*, which under a data-only comparator is no rows at
 * all. Leaning on it would hide the fact that the tie-break is doing the work.
 */
export function sortRows(rows: readonly RepositoryRow[], mode: SortMode): RepositoryRow[] {
  const entries = rows.map((row) => entryFor(row, mode));
  entries.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    // The two groups that have no key for this mode are ordered by path alone.
    if (a.rank === KEYED) {
      if (mode === 'name') {
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) {
          return byName;
        }
      } else {
        if (a.primary !== b.primary) {
          return a.primary - b.primary;
        }
        if (a.secondary !== b.secondary) {
          return a.secondary - b.secondary;
        }
      }
    }
    if (a.tie === b.tie) {
      return 0;
    }
    return a.tie < b.tie ? -1 : 1;
  });
  return entries.map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const FILTERS: Record<FilterMode, (row: RepositoryRow) => boolean> = {
  all: () => true,
  unpushed: isUnpushed,
  dirty: isDirty,
  behind: isBehind,
  attention: needsAttention,
  unreadable: isUnreadable,
};

/**
 * The rows one header chip leaves on screen.
 *
 * Order is preserved, so the caller decides whether to sort before or after
 * narrowing and gets the same list either way.
 *
 * The chips overlap on purpose and cannot partition the board: a repository
 * that is both dirty and behind answers to both, and a header that looked like
 * it partitioned would invite the reader to subtract one count from another.
 */
export function filterRows(
  rows: readonly RepositoryRow[],
  filter: FilterMode,
): RepositoryRow[] {
  // The fallback is not dead code: a filter can arrive from the page's stored
  // state, written by an older build that offered a mode this one does not.
  const matches = FILTERS[filter] ?? FILTERS.all;
  return rows.filter((row) => matches(row));
}

// ---------------------------------------------------------------------------
// The tally
// ---------------------------------------------------------------------------

/**
 * The counts the header renders, over the rows it is given.
 *
 * Counted over the rows passed in rather than over some larger model, so the
 * header always describes the list the reader is looking at.
 *
 * `clean` and `unknown` are the two that carry this module's rule. A row nobody
 * has read is counted under `unknown`, never under `clean`: a scan in progress
 * is the moment a reader is most likely to glance at the header, and a board
 * that reports its unanswered repositories as fine is telling them the one
 * thing it has no evidence for. Every other count is a fact established by a
 * read that returned, which is why a working tree nobody counted raises neither
 * `dirty` nor `clean`.
 *
 * The counts overlap, deliberately, and do not sum to `total`.
 */
export function tallyOf(rows: readonly RepositoryRow[]): Tally {
  let clean = 0;
  let unknown = 0;
  let dirty = 0;
  let unpushed = 0;
  let behind = 0;
  let attention = 0;
  let unreadable = 0;

  for (const row of rows) {
    const state = rowStateOf(row);
    if (state === 'clean') {
      clean += 1;
    } else if (state === 'unknown') {
      unknown += 1;
    }
    if (isDirty(row)) {
      dirty += 1;
    }
    if (isUnpushed(row)) {
      unpushed += 1;
    }
    if (isBehind(row)) {
      behind += 1;
    }
    if (needsAttention(row)) {
      attention += 1;
    }
    if (isUnreadable(row)) {
      unreadable += 1;
    }
  }

  return {
    total: rows.length,
    clean,
    dirty,
    unpushed,
    behind,
    attention,
    unreadable,
    unknown,
  };
}
