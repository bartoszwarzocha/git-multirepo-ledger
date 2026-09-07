import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import type {
  DirtyCounts,
  DiscoveredRepository,
  ReadFailure,
  RepositoryRow,
  WorkingTree,
} from '../model/types.ts';
import { filterRows, sortRows, tallyOf } from './order.ts';

const windows = process.platform === 'win32';

function abs(...segments: string[]): string {
  return windows ? path.join('C:\\', ...segments) : path.join('/', ...segments);
}

function repoAt(...segments: string[]): DiscoveredRepository {
  const target = abs(...segments);
  return {
    path: target,
    gitDir: path.join(target, '.git'),
    label: segments[segments.length - 1] ?? target,
    kind: 'plain',
    shallow: false,
    source: 'workspace',
  };
}

function rowFor(name: string, overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    repository: repoAt('work', name),
    head: { kind: 'branch', name: 'main' },
    divergence: { kind: 'in-sync', upstream: 'origin/main' },
    workingTree: { kind: 'not-read' },
    fetch: { kind: 'no-record' },
    ...overrides,
  };
}

function committedAt(at: number): Pick<RepositoryRow, 'lastCommit'> {
  return { lastCommit: { shortSha: 'abc1234', committedAt: at, subject: 'work', author: 'Ada' } };
}

function counted(counts: Partial<DirtyCounts>): WorkingTree {
  return {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...counts },
  };
}

const refused: ReadFailure = {
  command: 'git for-each-ref --include-root-refs --format=... refs/heads/ HEAD',
  stderr: 'fatal: detected dubious ownership',
  summary: 'git refused: dubious ownership',
};

const names = (rows: readonly RepositoryRow[]): string[] =>
  rows.map((row) => path.basename(row.repository.path));

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('the default order is the newest commit first', () => {
  // The whole differentiator: nothing else sorts a set of repositories by the
  // last commit in each.
  const rows = [
    rowFor('old', committedAt(1_000)),
    rowFor('newest', committedAt(9_000)),
    rowFor('middle', committedAt(5_000)),
  ];
  assert.deepEqual(names(sortRows(rows, 'recent')), ['newest', 'middle', 'old']);
});

test('a repository with no commits sorts after every dated one, and never as the epoch', () => {
  // Sorting it to the top of "most recently committed" would be a lie about
  // which repository moved last; slipping it in among the dated ones as
  // timestamp zero would hide it at the bottom with nothing to explain it.
  const rows = [
    rowFor('unborn', { head: { kind: 'unborn', name: 'main' }, divergence: { kind: 'unknown' } }),
    rowFor('old', committedAt(1_000)),
    rowFor('new', committedAt(9_000)),
  ];
  assert.deepEqual(names(sortRows(rows, 'recent')), ['new', 'old', 'unborn']);
});

test('a repository nobody has read yet waits in the group with no key', () => {
  const rows = [
    rowFor('pending', { head: { kind: 'unknown' }, divergence: { kind: 'unknown' } }),
    rowFor('answered', committedAt(5_000)),
  ];
  assert.deepEqual(names(sortRows(rows, 'recent')), ['answered', 'pending']);
});

test('unreadable repositories come last under every mode', () => {
  // Burying them is only acceptable because the header carries their count with
  // one click to reach them.
  const rows = [
    rowFor('refused', { failure: refused }),
    rowFor('quiet', committedAt(1_000)),
    rowFor('busy', committedAt(9_000)),
  ];
  for (const mode of ['recent', 'name', 'divergence', 'dirty'] as const) {
    assert.equal(names(sortRows(rows, mode)).at(-1), 'refused', `mode ${mode}`);
  }
});

test('an unreadable repository sorts below one that merely has no key', () => {
  const rows = [
    rowFor('refused', { failure: refused }),
    rowFor('unborn', { head: { kind: 'unborn', name: 'main' } }),
    rowFor('dated', committedAt(9_000)),
  ];
  assert.deepEqual(names(sortRows(rows, 'recent')), ['dated', 'unborn', 'refused']);
});

test('ordering is stable while answers are still arriving', () => {
  // A row lands, and every other pair of rows must compare exactly as it did
  // before - otherwise a background read moves a row under the pointer and the
  // reader's click goes somewhere they did not choose.
  const before = [
    rowFor('alpha', committedAt(9_000)),
    rowFor('bravo'),
    rowFor('charlie', committedAt(1_000)),
    rowFor('delta'),
  ];
  const after = before.map((row) =>
    path.basename(row.repository.path) === 'bravo' ? { ...row, ...committedAt(5_000) } : row,
  );

  const sortedBefore = names(sortRows(before, 'recent'));
  const sortedAfter = names(sortRows(after, 'recent'));
  assert.deepEqual(sortedBefore, ['alpha', 'charlie', 'bravo', 'delta']);
  assert.deepEqual(sortedAfter, ['alpha', 'bravo', 'charlie', 'delta']);

  // The one row that gained a key moved; nothing else changed place relative to
  // anything else.
  const without = (list: string[]): string[] => list.filter((name) => name !== 'bravo');
  assert.deepEqual(without(sortedAfter), without(sortedBefore));
});

test('two passes over identical data produce identical order', () => {
  // Two repositories can share a base name, so the tie-break is the case-folded
  // path: a tie that is not broken lets them swap places for no visible reason.
  const rows = [
    rowFor('api', { repository: repoAt('server', 'api'), ...committedAt(5_000) }),
    rowFor('api', { repository: repoAt('client', 'api'), ...committedAt(5_000) }),
  ];
  const once = sortRows(rows, 'recent').map((row) => row.repository.path);
  const twice = sortRows([...rows].reverse(), 'recent').map((row) => row.repository.path);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [abs('client', 'api'), abs('server', 'api')]);
});

test('the name mode reads alphabetically and every readable row has a key', () => {
  const rows = [rowFor('zebra'), rowFor('apple'), rowFor('mango', { head: { kind: 'unknown' } })];
  assert.deepEqual(names(sortRows(rows, 'name')), ['apple', 'mango', 'zebra']);
});

test('the divergence mode ranks by the sum, then by what exists only here', () => {
  const diverged = (ahead: number, behind: number): Partial<RepositoryRow> => ({
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead, behind },
  });
  const rows = [
    rowFor('level'),
    rowFor('three-behind', diverged(0, 3)),
    rowFor('three-ahead', diverged(3, 0)),
    rowFor('five', diverged(2, 3)),
  ];
  assert.deepEqual(names(sortRows(rows, 'divergence')), [
    'five',
    'three-ahead',
    'three-behind',
    'level',
  ]);
});

test('a repository with no upstream is not ordered as though it were level with one', () => {
  // `in-sync` is an established zero and keeps its key; `no-upstream` is the
  // absence of the question and drops to the group that has none.
  const rows = [
    rowFor('untracked', { divergence: { kind: 'no-upstream' } }),
    rowFor('level'),
    rowFor('ahead', {
      divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 1, behind: 0 },
    }),
  ];
  assert.deepEqual(names(sortRows(rows, 'divergence')), ['ahead', 'level', 'untracked']);
});

test('a tree nobody counted has no key for the dirty mode', () => {
  const rows = [
    rowFor('unread'),
    rowFor('clean', { workingTree: counted({}) }),
    rowFor('messy', { workingTree: counted({ unstaged: 4 }) }),
  ];
  assert.deepEqual(names(sortRows(rows, 'dirty')), ['messy', 'clean', 'unread']);
});

test('sorting returns a new array and leaves the caller\u2019s alone', () => {
  const rows = [rowFor('b', committedAt(1_000)), rowFor('a', committedAt(9_000))];
  const sorted = sortRows(rows, 'recent');
  assert.notEqual(sorted, rows);
  assert.deepEqual(names(rows), ['b', 'a']);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('a filter asks the facts, not the single word the row is painted with', () => {
  // This row's accent is `dirty`, because uncommitted work outranks the
  // divergence figures - and the unpushed chip must still find it, or the
  // header would be counting one thing and the filter showing another.
  const row = rowFor('api', {
    workingTree: counted({ unstaged: 2 }),
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 3, behind: 0 },
  });
  assert.deepEqual(names(filterRows([row], 'unpushed')), ['api']);
  assert.deepEqual(names(filterRows([row], 'dirty')), ['api']);
  assert.deepEqual(names(filterRows([row], 'behind')), []);
});

test('a tree nobody counted is not dirty, which is not a claim that it is clean', () => {
  const rows = [rowFor('unread'), rowFor('clean', { workingTree: counted({}) })];
  assert.deepEqual(names(filterRows(rows, 'dirty')), []);
});

test('the attention filter collects the states waiting on a decision', () => {
  const rows = [
    rowFor('detached', { head: { kind: 'detached', sha: '7c86ebf' } }),
    rowFor('rebasing', { operation: { kind: 'rebase', branch: 'main' } }),
    rowFor('unborn', { head: { kind: 'unborn', name: 'main' } }),
    rowFor('untracked', { divergence: { kind: 'no-upstream' } }),
    rowFor('gone', { divergence: { kind: 'gone', upstream: 'origin/x' } }),
    rowFor('ordinary'),
    rowFor('refused', { failure: refused }),
  ];
  assert.deepEqual(names(filterRows(rows, 'attention')), [
    'detached',
    'rebasing',
    'unborn',
    'untracked',
    'gone',
  ]);
});

test('a repository git refused answers only to its own filter', () => {
  const rows = [rowFor('refused', { failure: refused }), rowFor('ordinary')];
  assert.deepEqual(names(filterRows(rows, 'unreadable')), ['refused']);
  assert.deepEqual(names(filterRows(rows, 'all')), ['refused', 'ordinary']);
});

test('filtering preserves the order it was handed', () => {
  const rows = sortRows(
    [rowFor('old', committedAt(1_000)), rowFor('new', committedAt(9_000))],
    'recent',
  );
  assert.deepEqual(names(filterRows(rows, 'all')), ['new', 'old']);
});

// ---------------------------------------------------------------------------
// The tally
// ---------------------------------------------------------------------------

test('a repository nobody has read is counted as unknown, never as clean', () => {
  const tally = tallyOf([
    rowFor('pending', { head: { kind: 'unknown' }, divergence: { kind: 'unknown' } }),
    rowFor('level'),
  ]);
  assert.equal(tally.total, 2);
  assert.equal(tally.unknown, 1);
  assert.equal(tally.clean, 1);
});

test('a working tree nobody counted raises neither the dirty count nor the clean one down', () => {
  // The header states once, for the whole board, that uncommitted changes are
  // not being read; what a visible control resolves globally is not resolved
  // again row by row.
  const tally = tallyOf([rowFor('level')]);
  assert.equal(tally.dirty, 0);
  assert.equal(tally.clean, 1);
  assert.equal(tally.unknown, 0);
});

test('the counts overlap on purpose and do not add up to the total', () => {
  const tally = tallyOf([
    rowFor('busy', {
      workingTree: counted({ unstaged: 1 }),
      divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 },
    }),
  ]);
  assert.equal(tally.total, 1);
  assert.equal(tally.dirty, 1);
  assert.equal(tally.unpushed, 1);
  assert.equal(tally.behind, 1);
  assert.equal(tally.clean, 0);
});

test('every count is over the rows it was handed, and matches its own filter', () => {
  const rows = [
    rowFor('level'),
    rowFor('ahead', {
      divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 0 },
    }),
    rowFor('behind', {
      divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 0, behind: 4 },
    }),
    rowFor('messy', { workingTree: counted({ staged: 1 }) }),
    rowFor('detached', { head: { kind: 'detached', sha: '7c86ebf' } }),
    rowFor('refused', { failure: refused }),
    rowFor('pending', { head: { kind: 'unknown' }, divergence: { kind: 'unknown' } }),
  ];
  const tally = tallyOf(rows);
  assert.deepEqual(tally, {
    total: 7,
    // Only `level` is clean: `messy` was counted and is not, and `pending` was
    // never read and must not be flattered into the count.
    clean: 1,
    dirty: 1,
    unpushed: 1,
    behind: 1,
    attention: 1,
    unreadable: 1,
    unknown: 1,
  });
  // The chip and the click it performs are the same question asked twice.
  assert.equal(filterRows(rows, 'unpushed').length, tally.unpushed);
  assert.equal(filterRows(rows, 'behind').length, tally.behind);
  assert.equal(filterRows(rows, 'dirty').length, tally.dirty);
  assert.equal(filterRows(rows, 'attention').length, tally.attention);
  assert.equal(filterRows(rows, 'unreadable').length, tally.unreadable);
});

test('an empty board tallies to zeros without inventing a state', () => {
  assert.deepEqual(tallyOf([]), {
    total: 0,
    clean: 0,
    dirty: 0,
    unpushed: 0,
    behind: 0,
    attention: 0,
    unreadable: 0,
    unknown: 0,
  });
});
