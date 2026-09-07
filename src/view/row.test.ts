import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { pathKey } from '../model/keys.ts';
import type {
  DirtyCounts,
  DiscoveredRepository,
  ReadFailure,
  RepositoryRow,
  WorkingTree,
} from '../model/types.ts';
import {
  absoluteTime,
  buildRow,
  buildRows,
  dirtyText,
  divergenceText,
  freshnessText,
  headStateText,
  kindMarker,
  nameQualifiers,
  relativeAge,
  rowStateOf,
  unreadableText,
} from './row.ts';

const windows = process.platform === 'win32';

/** An absolute path for whichever platform the suite is running on. */
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

function rowFor(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    repository: repoAt('src', 'app'),
    head: { kind: 'branch', name: 'main' },
    divergence: { kind: 'in-sync', upstream: 'origin/main' },
    workingTree: { kind: 'not-read' },
    fetch: { kind: 'no-record' },
    ...overrides,
  };
}

function counted(counts: Partial<DirtyCounts>): WorkingTree {
  return {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...counts },
  };
}

const refused: ReadFailure = {
  command: 'git for-each-ref --include-root-refs --format=... refs/heads/ HEAD',
  stderr: "fatal: detected dubious ownership in repository at 'C:/work/api'",
  summary: 'git refused: dubious ownership',
};

/** 2026-09-07 12:00 local. Every relative date in this file is measured from here. */
const NOW = new Date(2026, 8, 7, 12, 0, 0).getTime();
const SECONDS = Math.floor(NOW / 1000);

// ---------------------------------------------------------------------------
// rowStateOf - the precedence, in the order it resolves
// ---------------------------------------------------------------------------

test('unreadable beats every other state a row could also be in', () => {
  // A refused repository is dirty, detached and mid-rebase on paper here; none
  // of it was established, because the command that would have established it
  // is the one that failed.
  const row = rowFor({
    failure: refused,
    head: { kind: 'detached', sha: '7c86ebf' },
    operation: { kind: 'rebase' },
    workingTree: counted({ unstaged: 3 }),
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 },
  });
  assert.equal(rowStateOf(row), 'unreadable');
});

test('a repository nobody has read yet is unknown, and is never clean', () => {
  // The whole point of the state: a board that files its unanswered rows under
  // "fine" is most flattering exactly while the scan the reader is watching runs.
  assert.equal(rowStateOf(rowFor({ head: { kind: 'unknown' } })), 'unknown');
});

test('a read that answered for HEAD but not for the upstream is unknown, not clean', () => {
  const row = rowFor({ divergence: { kind: 'unknown' } });
  assert.equal(rowStateOf(row), 'unknown');
});

test('an unborn repository is not clean', () => {
  // `git init` and nothing since has nothing to do about it, but "clean" reads
  // as "nothing to do", which is a different sentence.
  assert.equal(rowStateOf(rowFor({ head: { kind: 'unborn', name: 'main' } })), 'unborn');
});

test('a running operation outranks dirtiness', () => {
  // A stopped rebase leaves a dirty tree by construction, so `dirty` would name
  // the symptom and hide the cause.
  const row = rowFor({
    operation: { kind: 'rebase', branch: 'main', step: 1, total: 3 },
    head: { kind: 'detached', sha: '7c86ebf' },
    workingTree: counted({ unstaged: 4, conflicted: 1 }),
  });
  assert.equal(rowStateOf(row), 'operation');
});

test('a detached HEAD outranks the dirt and the divergence beneath it', () => {
  const row = rowFor({
    head: { kind: 'detached', sha: '7c86ebf' },
    workingTree: counted({ unstaged: 2 }),
  });
  assert.equal(rowStateOf(row), 'detached');
});

test('diverged outranks ahead-only and behind-only', () => {
  const both = rowFor({
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 },
  });
  const ahead = rowFor({
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 0 },
  });
  const behind = rowFor({
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 0, behind: 1 },
  });
  assert.equal(rowStateOf(both), 'diverged');
  assert.equal(rowStateOf(ahead), 'unpushed');
  assert.equal(rowStateOf(behind), 'behind');
});

test('uncommitted work outranks the divergence figures', () => {
  // Committed history is safe wherever it already is; an uncommitted change
  // exists on this disk and nowhere else.
  const row = rowFor({
    workingTree: counted({ unstaged: 1 }),
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 },
  });
  assert.equal(rowStateOf(row), 'dirty');
});

test('a counted but empty working tree does not make a row dirty', () => {
  assert.equal(rowStateOf(rowFor({ workingTree: counted({}) })), 'clean');
});

test('a gone upstream files under no-upstream, and the row still says which', () => {
  const row = rowFor({ divergence: { kind: 'gone', upstream: 'origin/feature' } });
  assert.equal(rowStateOf(row), 'no-upstream');
  assert.equal(divergenceText(row.divergence), 'gone');
});

test('an in-sync branch whose tree was never read is still clean', () => {
  // The exception, and the reason for it: the second-tier read ships off, so
  // requiring it would file a whole default board under `unknown`. The header
  // states once, for every row at a time, that uncommitted changes are not
  // being read - what a visible control resolves globally is not re-resolved
  // per row. A row nobody read *at all* is a different case and is `unknown`.
  assert.equal(rowStateOf(rowFor()), 'clean');
});

// ---------------------------------------------------------------------------
// divergenceText
// ---------------------------------------------------------------------------

test('divergence renders both arrows, one arrow, or nothing - never a pair of zeros', () => {
  const of = (ahead: number, behind: number): string | undefined =>
    divergenceText({ kind: 'diverged', upstream: 'origin/main', ahead, behind });
  assert.equal(of(2, 1), '↑2 ↓1');
  assert.equal(of(2, 0), '↑2');
  assert.equal(of(0, 1), '↓1');
  assert.equal(of(0, 0), '');
  assert.equal(divergenceText({ kind: 'in-sync', upstream: 'origin/main' }), '');
});

test('ahead leads, because the header leads on unpushed work', () => {
  const text = divergenceText({ kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 });
  assert.equal(text, '↑2 ↓1');
  assert.ok(text !== undefined && text.indexOf('↑') < text.indexOf('↓'));
});

test('no upstream and gone are words, and an unestablished divergence is silence', () => {
  assert.equal(divergenceText({ kind: 'no-upstream' }), 'no upstream');
  assert.equal(divergenceText({ kind: 'gone', upstream: 'origin/x' }), 'gone');
  assert.equal(divergenceText({ kind: 'unknown' }), undefined);
});

test('level with the upstream and not established are different answers', () => {
  // Both draw as nothing on the row. They differ in the tooltip, and folding
  // them together is how a board starts reporting rows it never read as fine.
  assert.notEqual(
    divergenceText({ kind: 'in-sync', upstream: 'origin/main' }),
    divergenceText({ kind: 'unknown' }),
  );
});

// ---------------------------------------------------------------------------
// headStateText
// ---------------------------------------------------------------------------

test('a branch renders as its own name', () => {
  assert.equal(headStateText({ kind: 'branch', name: 'main' }), 'main');
});

test('a detached HEAD names the commit, abbreviated as git abbreviated it', () => {
  assert.equal(headStateText({ kind: 'detached', sha: '7c86ebf' }), 'detached at 7c86ebf');
});

test('an unborn repository keeps the branch name its first commit will land on', () => {
  assert.equal(headStateText({ kind: 'unborn', name: 'main' }), 'main · no commits yet');
  assert.equal(headStateText({ kind: 'unborn', name: '' }), 'no commits yet');
});

test('a row nobody has read says nothing on line 3', () => {
  // Line 2 already says `reading...` where the reader is looking.
  assert.equal(headStateText({ kind: 'unknown' }), '');
});

test('the operation replaces the detached HEAD it causes', () => {
  // Without the marker files this row would read `detached at 7c86ebf` - true,
  // and useless at the one moment the reader needs to know what is going on.
  const head = { kind: 'detached', sha: '7c86ebf' } as const;
  assert.equal(
    headStateText(head, { kind: 'rebase', branch: 'main', step: 1, total: 3 }),
    'rebasing main 1/3',
  );
  assert.equal(headStateText(head, { kind: 'merge' }), 'merging');
  assert.equal(headStateText(head, { kind: 'cherry-pick' }), 'cherry-picking');
  assert.equal(headStateText(head, { kind: 'revert' }), 'reverting');
  assert.equal(headStateText(head, { kind: 'bisect' }), 'bisecting');
});

test('a rebase with no recovered step count still states the rebase', () => {
  // The marker files are git implementation detail, so a missing `msgnum` is
  // silence rather than an error - and "rebasing main" is true and useful.
  assert.equal(headStateText({ kind: 'branch', name: 'main' }, { kind: 'rebase' }), 'rebasing');
  assert.equal(
    headStateText({ kind: 'branch', name: 'main' }, { kind: 'rebase', branch: 'main' }),
    'rebasing main',
  );
  assert.equal(
    headStateText({ kind: 'branch', name: 'main' }, { kind: 'rebase', branch: 'main', step: 1 }),
    'rebasing main',
  );
});

// ---------------------------------------------------------------------------
// dirtyText
// ---------------------------------------------------------------------------

test('a tree nobody counted and a tree counted clean are different answers', () => {
  // This is the assertion the whole second tier rests on. Both draw as nothing;
  // one is a fact and the other is the absence of one.
  assert.equal(dirtyText({ kind: 'not-read' }), undefined);
  assert.equal(dirtyText(counted({})), '');
  assert.notEqual(dirtyText({ kind: 'not-read' }), dirtyText(counted({})));
});

test('a read that returned damaged claims nothing about the tree', () => {
  assert.equal(dirtyText({ kind: 'incomplete', reason: 'output stopped mid-record' }), undefined);
});

test('the glyphs are the ones the editor already shows, and never a number', () => {
  assert.equal(dirtyText(counted({ unstaged: 3 })), '*');
  assert.equal(dirtyText(counted({ untracked: 1 })), '*');
  assert.equal(dirtyText(counted({ staged: 2 })), '+');
  assert.equal(dirtyText(counted({ conflicted: 1 })), '!');
  assert.equal(dirtyText(counted({ unstaged: 3, staged: 2, conflicted: 1 })), '*+!');
  assert.ok(!/\d/.test(dirtyText(counted({ unstaged: 14, staged: 9 })) ?? ''));
});

// ---------------------------------------------------------------------------
// freshnessText
// ---------------------------------------------------------------------------

test('the caption says checked, and says nothing at all without a FETCH_HEAD', () => {
  assert.equal(freshnessText({ kind: 'attempted', at: SECONDS - 2 * 3600 }, NOW), 'checked 2h ago');
  assert.equal(freshnessText({ kind: 'no-record' }, NOW), undefined);
});

test('the caption never claims a fetch succeeded', () => {
  const text = freshnessText({ kind: 'attempted', at: SECONDS - 60 }, NOW) ?? '';
  for (const forbidden of ['up to date', 'in sync', 'fetched', 'never checked']) {
    assert.ok(!text.includes(forbidden), `caption must not say "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------------
// kindMarker
// ---------------------------------------------------------------------------

test('an ordinary repository carries no marker, so a marker is itself the signal', () => {
  assert.equal(kindMarker(repoAt('src', 'app')), undefined);
});

test('each kind names itself, and shallowness fills the slot only when nothing else does', () => {
  assert.equal(kindMarker({ ...repoAt('src', 'app'), kind: 'worktree' }), 'worktree');
  assert.equal(kindMarker({ ...repoAt('src', 'app'), kind: 'submodule' }), 'submodule');
  assert.equal(kindMarker({ ...repoAt('src', 'app'), kind: 'bare' }), 'bare');
  assert.equal(kindMarker({ ...repoAt('src', 'app'), shallow: true }), 'shallow');
});

test('the kind wins over shallowness, because it is what explains the row existing', () => {
  const marker = kindMarker({ ...repoAt('src', 'app'), kind: 'submodule', shallow: true });
  assert.equal(marker, 'submodule');
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('relative dates are English and step through the units', () => {
  const ago = (seconds: number): string => relativeAge(SECONDS - seconds, NOW);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59), 'just now');
  assert.equal(ago(60), '1m ago');
  assert.equal(ago(12 * 60), '12m ago');
  assert.equal(ago(3 * 3600), '3h ago');
  assert.equal(ago(2 * 86400), '2d ago');
  assert.equal(ago(35 * 86400), '1mo ago');
  assert.equal(ago(3 * 365 * 86400), '3y ago');
});

test('a week is reached only after seven days, and a month only after thirty', () => {
  const ago = (days: number): string => relativeAge(SECONDS - days * 86400, NOW);
  assert.equal(ago(6), '6d ago');
  assert.equal(ago(7), '1w ago');
  assert.equal(ago(29), '4w ago');
  assert.equal(ago(30), '1mo ago');
});

test('a commit dated in the future reads as just now, never as a countdown', () => {
  // It is very nearly always a bug in somebody's clock, and a row reading
  // "in 3 days" is read as a bug in the extension.
  assert.equal(relativeAge(SECONDS + 3 * 86400, NOW), 'just now');
});

test('the absolute time in the tooltip is ordered largest unit first', () => {
  // Rejected: toLocaleString, which reverses day and month depending on the
  // machine - in the one field a reader goes to in order to settle exactly when.
  const at = Math.floor(new Date(2026, 8, 7, 14, 32, 0).getTime() / 1000);
  assert.equal(absoluteTime(at), '2026-09-07 14:32');
});

// ---------------------------------------------------------------------------
// unreadableText
// ---------------------------------------------------------------------------

test('the unreadable reason carries the exact failing command', () => {
  // The extension's claim is that everything it runs is a read. Retyping the
  // command is how a reader checks that claim, so a reason without one is
  // unfalsifiable.
  const text = unreadableText(refused);
  assert.ok(text.includes(refused.command));
  assert.ok(text.startsWith('not readable — git refused: dubious ownership'));
  assert.ok(text.includes('dubious ownership in repository'));
});

test('git with nothing to say leaves the reason to the command alone', () => {
  const text = unreadableText({ command: 'git status', stderr: '   \n', summary: 'timed out' });
  assert.equal(text, 'not readable — timed out\nThe command was: git status');
});

// ---------------------------------------------------------------------------
// buildRow
// ---------------------------------------------------------------------------

test('an ordinary row carries a name, a date, a subject and a branch', () => {
  const rendered = buildRow(
    rowFor({
      repository: repoAt('work', 'api'),
      divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 0 },
      lastCommit: {
        shortSha: '7c86ebf',
        committedAt: SECONDS - 3 * 3600,
        subject: 'fix: correct the offset in the parser',
        author: 'Ada',
      },
      fetch: { kind: 'attempted', at: SECONDS - 3600 },
    }),
    { now: NOW },
  );
  assert.equal(rendered.name, 'api');
  assert.equal(rendered.divergence, '↑2');
  assert.equal(rendered.divergenceDimmed, false);
  assert.equal(rendered.age, '3h ago');
  assert.equal(rendered.subject, 'fix: correct the offset in the parser');
  assert.equal(rendered.headState, 'main');
  assert.equal(rendered.freshness, 'checked 1h ago');
  assert.equal(rendered.state, 'unpushed');
  assert.equal('kind' in rendered, false);
});

test('the subject reaches the row whole, because the width that shortens it is the page\u2019s', () => {
  const subject = `feat: ${'a very long clause '.repeat(20)}end`;
  const rendered = buildRow(
    rowFor({
      lastCommit: { shortSha: 'abc1234', committedAt: SECONDS - 60, subject, author: 'Ada' },
    }),
    { now: NOW },
  );
  assert.equal(rendered.subject, subject);
  assert.ok(rendered.tooltip.includes(subject));
});

test('a row still being read says so on line 2 and claims nothing anywhere else', () => {
  const rendered = buildRow(rowFor({ head: { kind: 'unknown' }, divergence: { kind: 'unknown' } }), {
    now: NOW,
  });
  assert.equal(rendered.state, 'unknown');
  assert.equal(rendered.subject, 'reading…');
  assert.equal(rendered.headState, '');
  assert.equal('divergence' in rendered, false);
  assert.equal('dirty' in rendered, false);
  assert.equal('age' in rendered, false);
});

test('an in-sync row carries an empty divergence, not an absent one', () => {
  const rendered = buildRow(rowFor(), { now: NOW });
  assert.equal('divergence' in rendered, true);
  assert.equal(rendered.divergence, '');
});

test('no upstream and gone render dimmed, and a figure does not', () => {
  const none = buildRow(rowFor({ divergence: { kind: 'no-upstream' } }), { now: NOW });
  assert.equal(none.divergence, 'no upstream');
  assert.equal(none.divergenceDimmed, true);

  const figure = buildRow(
    rowFor({ divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 1, behind: 1 } }),
    { now: NOW },
  );
  assert.equal(figure.divergenceDimmed, false);
});

test('a repository with no commits states that instead of carrying a date', () => {
  const rendered = buildRow(
    rowFor({ head: { kind: 'unborn', name: 'main' }, divergence: { kind: 'unknown' } }),
    { now: NOW },
  );
  assert.equal(rendered.subject, 'no commits yet');
  assert.equal(rendered.headState, 'main · no commits yet');
  assert.equal('age' in rendered, false);
  assert.equal(rendered.state, 'unborn');
});

test('a row that answered without a commit states the shortfall rather than going blank', () => {
  // A blank line 2 is indistinguishable from a row that is still loading.
  assert.equal(buildRow(rowFor(), { now: NOW }).subject, 'no commit was read');
  assert.equal(
    buildRow(rowFor({ incomplete: 'output stopped mid-record' }), { now: NOW }).subject,
    'read did not finish: output stopped mid-record',
  );
});

test('an unreadable row keeps its name and hands the reader the command that failed', () => {
  const rendered = buildRow(rowFor({ repository: repoAt('work', 'api'), failure: refused }), {
    now: NOW,
  });
  assert.equal(rendered.name, 'api');
  assert.equal(rendered.state, 'unreadable');
  assert.equal(rendered.subject, 'not readable — git refused: dubious ownership');
  assert.ok(rendered.unreadableReason?.includes(refused.command));
  assert.ok(rendered.tooltip.includes(refused.command));
  assert.ok(rendered.tooltip.includes(refused.stderr));
});

test('the tooltip spells out both divergence figures and names the upstream', () => {
  // The arrows are never the only channel, so a high-contrast theme that
  // flattens colour loses nothing.
  const rendered = buildRow(
    rowFor({ divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 1 } }),
    { now: NOW },
  );
  assert.ok(rendered.tooltip.includes('2 commits here are not on origin/main'));
  assert.ok(rendered.tooltip.includes('1 commit on origin/main is not here'));
});

test('the tooltip carries the absolute commit time, because two relative dates do not compare', () => {
  const at = Math.floor(new Date(2026, 8, 5, 9, 15, 0).getTime() / 1000);
  const rendered = buildRow(
    rowFor({ lastCommit: { shortSha: 'abc1234', committedAt: at, subject: 'x', author: 'Ada' } }),
    { now: NOW },
  );
  assert.ok(rendered.tooltip.includes('2026-09-05 09:15'));
  assert.ok(rendered.tooltip.includes('Ada'));
});

test('a repository with no fetch record says why it is silent, and never that it is current', () => {
  const rendered = buildRow(rowFor(), { now: NOW });
  assert.equal('freshness' in rendered, false);
  assert.ok(rendered.tooltip.includes('no FETCH_HEAD'));
  for (const forbidden of ['up to date', 'never checked']) {
    assert.ok(!rendered.tooltip.includes(forbidden));
  }
});

test('the tooltip names the categories of dirt and counts none of them', () => {
  const rendered = buildRow(rowFor({ workingTree: counted({ unstaged: 14, staged: 9 }) }), {
    now: NOW,
  });
  assert.ok(rendered.tooltip.includes('changes not staged'));
  assert.ok(rendered.tooltip.includes('staged changes'));
  assert.ok(!rendered.tooltip.includes('14'));
});

test('a bare repository explains the empty dirty slot rather than leaving it ambiguous', () => {
  const rendered = buildRow(
    rowFor({ repository: { ...repoAt('mirrors', 'api.git'), kind: 'bare' } }),
    { now: NOW },
  );
  assert.equal(rendered.kind, 'bare');
  assert.ok(rendered.tooltip.includes('no working tree'));
});

test('a shallow clone says what shallowness does to the figures above it', () => {
  const rendered = buildRow(rowFor({ repository: { ...repoAt('src', 'app'), shallow: true } }), {
    now: NOW,
  });
  assert.equal(rendered.kind, 'shallow');
  assert.ok(rendered.tooltip.includes('incomplete graph'));
});

test('a rebase names in the tooltip the object id it actually read, and resolves nothing', () => {
  const rendered = buildRow(
    rowFor({ operation: { kind: 'rebase', branch: 'main', step: 1, total: 3, onto: '7c86ebf' } }),
    { now: NOW },
  );
  assert.equal(rendered.headState, 'rebasing main 1/3');
  assert.ok(rendered.tooltip.includes('onto 7c86ebf'));
});

// ---------------------------------------------------------------------------
// Names that collide
// ---------------------------------------------------------------------------

test('two repositories sharing a base name each gain the segment that tells them apart', () => {
  // Two rows that read identically are worse than one row that reads long: the
  // reader cannot tell which repository they are about to open.
  const qualifiers = nameQualifiers([
    repoAt('work', 'client', 'api'),
    repoAt('work', 'server', 'api'),
  ]);
  assert.equal(qualifiers.size, 2);
  assert.equal(qualifiers.get(pathKey(abs('work', 'client', 'api'))), 'client');
  assert.equal(qualifiers.get(pathKey(abs('work', 'server', 'api'))), 'server');
});

test('a name nobody else uses is left alone', () => {
  const qualifiers = nameQualifiers([
    repoAt('work', 'client', 'api'),
    repoAt('work', 'server', 'api'),
    repoAt('work', 'tools'),
  ]);
  const rows = buildRows(
    [
      rowFor({ repository: repoAt('work', 'client', 'api') }),
      rowFor({ repository: repoAt('work', 'server', 'api') }),
      rowFor({ repository: repoAt('work', 'tools') }),
    ],
    NOW,
  );
  assert.equal(qualifiers.size, 2);
  assert.deepEqual(
    rows.map((row) => [row.name, row.qualifier]),
    [
      ['api', 'client'],
      ['api', 'server'],
      ['tools', undefined],
    ],
  );
});

test('the walk climbs until the segments differ, and no further', () => {
  const rows = buildRows(
    [
      rowFor({ repository: repoAt('a', 'shared', 'api') }),
      rowFor({ repository: repoAt('b', 'shared', 'api') }),
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.qualifier),
    ['a/shared', 'b/shared'],
  );
});
