import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  formatRelativeAge,
  readFetchEvidence,
  readGitState,
  readOperation,
} from './gitState.ts';

/*
 * Every state below is driven into existence with real git commands rather than
 * by writing the marker files by hand. The module's whole claim is that it
 * reads what git leaves behind, so a fixture that lays out what this file
 * *believes* git leaves behind would agree with the module and with nothing
 * else: both would be wrong together the day a backend changes a filename, and
 * the suite would stay green. A conflicted merge that git itself refused to
 * finish cannot be wrong about where `MERGE_HEAD` goes.
 *
 * The exceptions are stated where they occur - one fabricated directory for a
 * precedence rule that takes a rebase todo with a merge command to produce
 * naturally, and one set of deletions for the case where git has recorded an
 * operation and none of its details.
 */

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let gitPresent: boolean | undefined;

function hasGit(): boolean {
  if (gitPresent === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      gitPresent = true;
    } catch {
      gitPresent = false;
    }
  }
  return gitPresent;
}

/** Skips rather than fails where git is not installed, as CI images vary. */
function gitTest(name: string, run: (dir: string) => Promise<void>): void {
  test(name, async (t) => {
    if (!hasGit()) {
      t.skip('git is not on PATH');
      return;
    }
    const dir = await makeTempDir();
    try {
      await run(dir);
    } finally {
      await removeTempDir(dir);
    }
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Runs a command that is expected to stop with a conflict.
 *
 * The failure is the fixture: `git rebase` exiting non-zero with the work half
 * done is exactly the state under test, so a throw here is swallowed and the
 * assertions decide whether the right thing was left on disk.
 */
function gitExpectingFailure(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    // The command was meant to fail. What it left behind is what is asserted.
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-ledger-gitstate-'));
  // git reports the resolved path, and the temp directory is a link on macOS.
  return fs.realpath(dir);
}

async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A locked object file under .git is not worth failing a passing test over.
  }
}

async function write(dir: string, relative: string, contents: string): Promise<void> {
  const target = path.join(dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.name', 'Ledger Test']);
  git(dir, ['config', 'user.email', 'ledger@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // Without this a checkout rewrites line endings on Windows and every fixture
  // commit reports a modified working tree it did not modify.
  git(dir, ['config', 'core.autocrlf', 'false']);
}

async function commitFile(dir: string, contents: string, message: string): Promise<void> {
  await write(dir, 'f.txt', contents);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function gitDirOf(worktree: string): string {
  return path.join(worktree, '.git');
}

/**
 * A repository whose `topic` branch conflicts with `main`, which is the shape
 * every stopped-operation fixture below is built from.
 */
async function makeConflictingBranches(dir: string, topicCommits: number): Promise<void> {
  initRepo(dir);
  await commitFile(dir, 'base\n', 'base');
  git(dir, ['checkout', '-q', '-b', 'topic']);
  for (let i = 1; i <= topicCommits; i += 1) {
    await commitFile(dir, `topic ${i}\n`, `topic commit ${i}`);
  }
  git(dir, ['checkout', '-q', 'main']);
  await commitFile(dir, 'mainline\n', 'main change');
}

// ---------------------------------------------------------------------------
// Nothing running
// ---------------------------------------------------------------------------

gitTest('a repository with nothing in flight reports no operation', async (dir) => {
  initRepo(dir);
  await commitFile(dir, 'one\n', 'first');

  assert.equal(await readOperation(gitDirOf(dir)), undefined);
});

gitTest('a git directory that cannot be listed says nothing rather than guessing', async (dir) => {
  const missing = path.join(dir, 'not-a-repository', '.git');

  assert.equal(await readOperation(missing), undefined);
  assert.deepEqual(await readFetchEvidence(missing), { kind: 'no-record' });
  assert.deepEqual(await readGitState(missing), { fetch: { kind: 'no-record' } });
});

// ---------------------------------------------------------------------------
// The single-file markers
// ---------------------------------------------------------------------------

gitTest('a conflicted merge is reported as a merge', async (dir) => {
  await makeConflictingBranches(dir, 1);
  gitExpectingFailure(dir, ['merge', 'topic']);

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'merge' });
});

gitTest('a cherry-pick that stopped is reported as a cherry-pick', async (dir) => {
  await makeConflictingBranches(dir, 1);
  gitExpectingFailure(dir, ['cherry-pick', 'topic']);

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'cherry-pick' });
});

gitTest('a revert that stopped is reported as a revert', async (dir) => {
  initRepo(dir);
  await commitFile(dir, 'one\n', 'first');
  await commitFile(dir, 'two\n', 'second');
  await commitFile(dir, 'three\n', 'third');
  gitExpectingFailure(dir, ['revert', '--no-edit', 'HEAD~1']);

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'revert' });
});

gitTest('a bisect in progress is reported as a bisect', async (dir) => {
  initRepo(dir);
  for (let i = 1; i <= 5; i += 1) {
    await commitFile(dir, `${i}\n`, `commit ${i}`);
  }
  git(dir, ['bisect', 'start']);
  git(dir, ['bisect', 'bad']);
  git(dir, ['bisect', 'good', 'HEAD~4']);

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'bisect' });
});

// ---------------------------------------------------------------------------
// Rebase, both backends
// ---------------------------------------------------------------------------

gitTest('a stopped rebase carries its step, its total and the branch', async (dir) => {
  await makeConflictingBranches(dir, 3);
  const onto = git(dir, ['rev-parse', '--short', 'main']).trim();
  git(dir, ['checkout', '-q', 'topic']);
  gitExpectingFailure(dir, ['rebase', 'main']);

  const operation = await readOperation(gitDirOf(dir));

  assert.equal(operation?.kind, 'rebase');
  assert.equal(operation?.step, 1, 'stopped on the first of the three replayed commits');
  assert.equal(operation?.total, 3);
  // `head-name` holds `refs/heads/topic`, and the row has no room for the ref.
  assert.equal(operation?.branch, 'topic');
  // git records the object id it is replaying onto and never the name the user
  // typed, so this is the same abbreviation `git status` prints.
  assert.equal(operation?.onto, onto);
});

gitTest('the apply backend is read from its own counters', async (dir) => {
  await makeConflictingBranches(dir, 2);
  git(dir, ['checkout', '-q', 'topic']);
  gitExpectingFailure(dir, ['rebase', '--apply', 'main']);

  const operation = await readOperation(gitDirOf(dir));

  assert.equal(operation?.kind, 'rebase');
  assert.equal(operation?.step, 1);
  assert.equal(operation?.total, 2);
  assert.equal(operation?.branch, 'topic');
});

gitTest('a stopped `git am` is a rebase with no branch to name', async (dir) => {
  await makeConflictingBranches(dir, 2);
  git(dir, ['checkout', '-q', 'topic']);
  const outDir = path.join(dir, 'patches');
  git(dir, ['format-patch', '-q', '-o', outDir, 'main..topic']);
  const patches = (await fs.readdir(outDir)).sort().map((name) => path.join(outDir, name));
  assert.equal(patches.length, 2, 'the fixture needs two patches to have a total to report');
  git(dir, ['checkout', '-q', 'main']);
  gitExpectingFailure(dir, ['am', ...patches]);

  const operation = await readOperation(gitDirOf(dir));

  assert.equal(operation?.kind, 'rebase');
  assert.equal(operation?.step, 1);
  assert.equal(operation?.total, 2);
  // `git am` writes no `head-name`: it is applying patches, not moving a
  // branch, so there is no branch to report and none is invented.
  assert.equal(operation?.branch, undefined);
  assert.equal(operation?.onto, undefined);
});

gitTest('rebasing a detached HEAD reports the rebase and no branch', async (dir) => {
  await makeConflictingBranches(dir, 1);
  git(dir, ['checkout', '-q', '--detach', 'topic']);
  gitExpectingFailure(dir, ['rebase', 'main']);

  const operation = await readOperation(gitDirOf(dir));

  assert.equal(operation?.kind, 'rebase');
  // git writes the literal string `detached HEAD` into `head-name` here, and
  // repeating it on the row would name a branch that does not exist.
  assert.equal(operation?.branch, undefined);
});

gitTest('an operation with no readable details is still reported', async (dir) => {
  await makeConflictingBranches(dir, 3);
  git(dir, ['checkout', '-q', 'topic']);
  gitExpectingFailure(dir, ['rebase', 'main']);

  // Every detail file removed, which is what a future git renaming any of them
  // would look like from here. The directory - the operation itself - is left.
  const rebaseDir = path.join(gitDirOf(dir), 'rebase-merge');
  for (const name of ['msgnum', 'end', 'head-name', 'onto']) {
    await fs.rm(path.join(rebaseDir, name), { force: true });
  }

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'rebase' });
});

gitTest('a rebase outranks a merge marker left in the same directory', async (dir) => {
  await makeConflictingBranches(dir, 1);
  gitExpectingFailure(dir, ['merge', 'topic']);
  // Fabricated: producing both markers at once takes a rebase todo containing a
  // `merge` command that conflicts, which is a long fixture for a one-line
  // precedence rule. What is asserted is the rule - the way out of this state
  // is `git rebase --continue`, so the row must not say `merge`.
  await fs.mkdir(path.join(gitDirOf(dir), 'rebase-merge'), { recursive: true });

  assert.deepEqual(await readOperation(gitDirOf(dir)), { kind: 'rebase' });
});

// ---------------------------------------------------------------------------
// Linked worktrees
// ---------------------------------------------------------------------------

gitTest('an operation in a linked worktree belongs to that worktree', async (dir) => {
  const main = path.join(dir, 'main');
  await fs.mkdir(main, { recursive: true });
  await makeConflictingBranches(main, 1);
  const linked = path.join(dir, 'linked');
  git(main, ['worktree', 'add', '-q', '--detach', linked, 'topic']);
  gitExpectingFailure(linked, ['rebase', 'main']);

  const pointer = await fs.readFile(path.join(linked, '.git'), 'utf8');
  const linkedGitDir = pointer.replace(/^gitdir:\s*/, '').trim();

  assert.equal((await readOperation(linkedGitDir))?.kind, 'rebase');
  // The main checkout is not rebasing, and reading the main git directory for a
  // worktree's state would put the operation on every row of the repository.
  assert.equal(await readOperation(gitDirOf(main)), undefined);
});

// ---------------------------------------------------------------------------
// Fetch evidence
// ---------------------------------------------------------------------------

gitTest('a repository that has never fetched has no record, not a date', async (dir) => {
  initRepo(dir);
  await commitFile(dir, 'one\n', 'first');

  assert.deepEqual(await readFetchEvidence(gitDirOf(dir)), { kind: 'no-record' });
});

gitTest('a fresh clone has no fetch record either', async (dir) => {
  const origin = path.join(dir, 'origin');
  await fs.mkdir(origin, { recursive: true });
  initRepo(origin);
  await commitFile(origin, 'one\n', 'first');
  const clone = path.join(dir, 'clone');
  git(dir, ['clone', '-q', origin, clone]);

  // This is the case the union exists for: the clone is as current as a
  // repository can be, and git has written nothing that says so. A row that
  // read absence as freshness would be most confident exactly here.
  assert.deepEqual(await readFetchEvidence(gitDirOf(clone)), { kind: 'no-record' });
});

gitTest('a fetch leaves a record, dated by the file git touched', async (dir) => {
  const origin = path.join(dir, 'origin');
  await fs.mkdir(origin, { recursive: true });
  initRepo(origin);
  await commitFile(origin, 'one\n', 'first');
  const clone = path.join(dir, 'clone');
  git(dir, ['clone', '-q', origin, clone]);
  git(clone, ['fetch', '-q', 'origin']);

  const evidence = await readFetchEvidence(gitDirOf(clone));
  const stats = await fs.stat(path.join(gitDirOf(clone), 'FETCH_HEAD'));

  assert.equal(evidence.kind, 'attempted');
  assert.equal(
    evidence.kind === 'attempted' ? evidence.at : undefined,
    Math.floor(stats.mtimeMs / 1000),
    'the date is the file mtime in whole seconds and is not computed any other way',
  );
});

gitTest('a fetch that brought back nothing still counts as an attempt', async (dir) => {
  const origin = path.join(dir, 'origin');
  await fs.mkdir(origin, { recursive: true });
  initRepo(origin);
  await commitFile(origin, 'one\n', 'first');
  const clone = path.join(dir, 'clone');
  git(dir, ['clone', '-q', origin, clone]);
  git(clone, ['fetch', '-q', 'origin']);
  // Nothing has moved on the remote, so this fetch transfers nothing at all -
  // and git touches FETCH_HEAD anyway. That is the whole reason the type says
  // `attempted` and the row may not say the branch is up to date.
  git(clone, ['fetch', '-q', 'origin']);

  assert.equal((await readFetchEvidence(gitDirOf(clone))).kind, 'attempted');
});

gitTest('readGitState answers both halves in one call', async (dir) => {
  await makeConflictingBranches(dir, 1);
  gitExpectingFailure(dir, ['merge', 'topic']);

  const state = await readGitState(gitDirOf(dir));

  assert.deepEqual(state.operation, { kind: 'merge' });
  assert.deepEqual(state.fetch, { kind: 'no-record' });
});

// ---------------------------------------------------------------------------
// The relative age
// ---------------------------------------------------------------------------

/*
 * `now` is fixed here rather than taken from the clock, which is the point of
 * the argument: these assertions are on exact strings at exact boundaries, and
 * a formatter that read `Date.now()` could only be tested a second either side
 * of each one.
 */
const NOW = 1_757_000_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function age(secondsAgo: number): string {
  return formatRelativeAge(NOW - secondsAgo, NOW);
}

test('under a minute is not rounded up to one', () => {
  assert.equal(age(0), 'just now');
  assert.equal(age(1), 'just now');
  assert.equal(age(MINUTE - 1), 'just now');
});

test('minutes and hours are compact, because they are on every row', () => {
  assert.equal(age(MINUTE), '1m');
  assert.equal(age(HOUR - 1), '59m');
  assert.equal(age(HOUR), '1h');
  assert.equal(age(2 * HOUR), '2h');
  assert.equal(age(DAY - 1), '23h');
});

test('a day is a day, not twenty-four hours', () => {
  assert.equal(age(DAY), '1d');
  assert.equal(age(6 * DAY), '6d');
});

test('a week is spelled out, and the last day of the week is not', () => {
  assert.equal(age(7 * DAY - 1), '6d');
  assert.equal(age(7 * DAY), '1 week');
  assert.equal(age(13 * DAY), '1 week');
  assert.equal(age(14 * DAY), '2 weeks');
});

test('weeks run to a full month so that nothing falls through to zero months', () => {
  assert.equal(age(30 * DAY), '4 weeks');
  assert.equal(age(31 * DAY), '1 month');
  assert.equal(age(364 * DAY), '11 months');
});

test('a year is a year, and the day before it is still months', () => {
  assert.equal(age(365 * DAY), '1 year');
  assert.equal(age(2 * 365 * DAY), '2 years');
});

test('a timestamp in the future is said, not clamped to zero', () => {
  // Under a minute ahead is clock skew and reads as the present.
  assert.equal(formatRelativeAge(NOW + 30, NOW), 'just now');
  assert.equal(formatRelativeAge(NOW + MINUTE + 1, NOW), 'in the future');
  assert.equal(formatRelativeAge(NOW + 7 * DAY, NOW), 'in the future');
});
