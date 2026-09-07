import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import type { DiscoveredRepository, RepositoryRow } from '../model/types.ts';
import type { GitResult } from '../util/git.ts';
import { classifyRepository } from './classify.ts';
import {
  CONCURRENCY_CEILING,
  CONCURRENCY_FLOOR,
  CONCURRENCY_MAX,
  classifyFailure,
  deriveConcurrency,
  fillDirtyState,
  forEachBounded,
  readDirtyState,
  readRow,
  readRows,
} from './reader.ts';

/*
 * Three halves, which is one more than the module has.
 *
 * The first is the arithmetic - concurrency and failure classification - tested
 * as pure functions, because arranging for a repository to hang, to be owned by
 * somebody else or to be corrupt is not something a test suite can do reliably
 * on three platforms, and those are exactly the paths that must not be wrong.
 *
 * The second is the pool, tested on its own with counted work rather than with
 * git, because "stops spawning when the signal aborts" is a claim about the pool
 * and is invisible from outside a pass that has already dropped its rows.
 *
 * The third builds real repositories under the system temporary directory and
 * reads them with the real command. Nothing here reads anything the user keeps
 * work in, and nothing here writes to a repository it did not create.
 */

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('a machine reporting one usable CPU still reads several repositories at once', () => {
  // The failure this prevents: a row costs a process spawn and a wait, not
  // arithmetic, so a container with a one-CPU quota reading two hundred
  // repositories one after another would spend the whole pass idle.
  assert.equal(deriveConcurrency({ cpuCount: 1 }), CONCURRENCY_FLOOR);
  assert.equal(deriveConcurrency({ cpuCount: 2 }), CONCURRENCY_FLOOR);
});

test('a machine with more cores than the ceiling is capped, not obeyed', () => {
  // Every unit in flight is a child process holding handles, and on a network
  // share an outstanding request as well; the operating system's own limiter is
  // exhaustion.
  assert.equal(deriveConcurrency({ cpuCount: 128 }), CONCURRENCY_CEILING);
});

test('between the two guards the runtime decides, so no number is baked in', () => {
  const middle = Math.floor((CONCURRENCY_FLOOR + CONCURRENCY_CEILING) / 2);
  assert.equal(deriveConcurrency({ cpuCount: middle }), middle);
});

test('the setting replaces the derivation rather than being clamped into it', () => {
  // Below the floor and above what this machine reports, both honoured: the
  // person with the network share knows what it can take, and a derivation that
  // overrode them would be a guess arguing with a measurement.
  assert.equal(deriveConcurrency({ configured: 1, cpuCount: 32 }), 1);
  assert.equal(deriveConcurrency({ configured: 24, cpuCount: 2 }), 24);
});

test('zero, a negative and nonsense all mean "derive it", which is what the default is', () => {
  for (const configured of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      deriveConcurrency({ configured, cpuCount: 8 }),
      8,
      `a configured value of ${String(configured)} should have fallen back to the derivation`,
    );
  }
  assert.equal(deriveConcurrency({ cpuCount: 8 }), 8);
});

test('a setting past the absolute maximum is honoured up to it and no further', () => {
  // Past this point the setting has stopped being a preference: the extension
  // host is shared with every other extension in the window.
  assert.equal(deriveConcurrency({ configured: 5000, cpuCount: 8 }), CONCURRENCY_MAX);
});

test('the derivation reads the runtime when nothing is injected', () => {
  const derived = deriveConcurrency();
  assert.ok(
    derived >= CONCURRENCY_FLOOR && derived <= CONCURRENCY_CEILING,
    `${derived} is outside the two guards`,
  );
});

// ---------------------------------------------------------------------------
// What went wrong
// ---------------------------------------------------------------------------

function result(overrides: Partial<GitResult> = {}): GitResult {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    command: 'git --no-optional-locks for-each-ref --include-root-refs --format=... refs/heads/ HEAD',
    ...overrides,
  };
}

test('a read that exited zero is not a failure', () => {
  assert.equal(classifyFailure(result(), 10_000), undefined);
});

test('a timeout says how long it waited, and carries the command that was waiting', () => {
  const failure = classifyFailure(result({ code: -1, timedOut: true }), 10_000);
  assert.equal(failure?.summary, 'did not answer in 10 s');
  // The command is the whole point of `ReadFailure`: the extension's claim is
  // that everything it runs is a read, and retyping the command is how a reader
  // checks that claim against a row they do not believe.
  assert.match(failure?.command ?? '', /for-each-ref/);
});

test('the timeout is recognised before the exit code of the process that was killed', () => {
  // A killed process reports a nonsensical code as well as `timedOut`. Reading
  // the code first would report a repository on a sleeping share as one git
  // refused, and send the reader looking for a permission problem.
  const failure = classifyFailure(result({ code: 128, timedOut: true, stderr: 'x' }), 250);
  assert.equal(failure?.summary, 'did not answer in 250 ms');
});

test('a sub-second and a fractional budget are both said in words a person would use', () => {
  assert.equal(classifyFailure(result({ timedOut: true }), 1)?.summary, 'did not answer in 1 ms');
  assert.equal(
    classifyFailure(result({ timedOut: true }), 1500)?.summary,
    'did not answer in 1.5 s',
  );
});

test('git refusing the ownership of a directory is reported in the words the row prints', () => {
  const failure = classifyFailure(
    result({
      code: 128,
      stderr:
        "fatal: detected dubious ownership in repository at 'D:/shared/thing'\n" +
        "To add an exception for this directory, call:\n\n" +
        "\tgit config --global --add safe.directory D:/shared/thing\n",
    }),
    10_000,
  );
  assert.equal(failure?.summary, 'git refused: dubious ownership');
  // git's own sentence travels with the row, including the path and the remedy,
  // because the remedy is a command for the user to run in their own shell. This
  // extension never runs it and never passes `-c safe.directory=`.
  assert.match(failure?.stderr ?? '', /safe\.directory/);
});

test('a refusal in a language this code does not read is still recognised, by the config key', () => {
  // The sentence is marked for translation and the config key is not, so the key
  // is the only token in the message that can be relied on.
  const failure = classifyFailure(
    result({
      code: 128,
      stderr:
        "fatal: unsichere Eigentümerschaft im Repository unter 'D:/geteilt'\n" +
        '\tgit config --global --add safe.directory D:/geteilt\n',
    }),
    10_000,
  );
  assert.equal(failure?.summary, 'git refused: dubious ownership');
});

test('a directory that is not a repository says so, rather than reporting an exit code', () => {
  const failure = classifyFailure(
    result({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }),
    10_000,
  );
  assert.equal(failure?.summary, 'not a git repository');
});

test('anything else is the exit code with git\u2019s own first line kept beside it', () => {
  const failure = classifyFailure(
    result({ code: 129, stderr: "error: unknown option `include-root-refs'\nusage: git for-each-ref\n" }),
    10_000,
  );
  // Vaguer than a named case and never wrong, which is the right direction: a
  // reason invented for a message this code does not recognise would be a guess
  // printed in the one place the reader goes to stop guessing.
  assert.equal(failure?.summary, 'git exited 129');
  assert.match(failure?.stderr ?? '', /unknown option `include-root-refs'/);
});

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

test('every item is taken, and never more than the limit at once', async () => {
  const items = Array.from({ length: 40 }, (_, index) => index);
  const taken: number[] = [];
  let inFlight = 0;
  let peak = 0;

  const completed = await forEachBounded(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    taken.push(item);
    inFlight -= 1;
  });

  assert.equal(completed, true);
  assert.equal(taken.length, items.length);
  assert.deepEqual([...taken].sort((a, b) => a - b), items);
  assert.equal(peak, 4);
});

test('a signal that is already aborted takes nothing at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let taken = 0;
  const completed = await forEachBounded(
    [1, 2, 3],
    4,
    async () => {
      taken += 1;
    },
    controller.signal,
  );
  // Nothing was taken, which for the real pass means nothing was spawned: the
  // check is before the item is claimed, not after the work returns.
  assert.equal(taken, 0);
  assert.equal(completed, false);
});

test('an abort part way through stops the pool taking anything further', async () => {
  const controller = new AbortController();
  const items = Array.from({ length: 20 }, (_, index) => index);
  const taken: number[] = [];

  const completed = await forEachBounded(
    items,
    1,
    async (item) => {
      taken.push(item);
      if (item === 2) {
        controller.abort();
      }
    },
    controller.signal,
  );

  assert.deepEqual(taken, [0, 1, 2]);
  assert.equal(completed, false);
});

test('work is handed out one item at a time, so a slow item does not hold back the pool', async () => {
  // The failure this shape prevents: slicing the list into batches of `limit`
  // and awaiting each batch, where one repository on a sleeping share holds back
  // the fifteen beside it and the board fills in visible steps.
  const order: string[] = [];
  await forEachBounded(
    ['slow', 'fast-1', 'fast-2', 'fast-3'],
    2,
    async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item === 'slow' ? 40 : 1));
      order.push(item);
    },
  );
  assert.equal(order[order.length - 1], 'slow');
  assert.deepEqual(order.slice(0, 3), ['fast-1', 'fast-2', 'fast-3']);
});

// ---------------------------------------------------------------------------
// Against a live git
// ---------------------------------------------------------------------------

/*
 * Repositories are built under the system temporary directory and never
 * anywhere the user keeps work. Global and system git configuration is replaced
 * with files this suite writes, because a developer whose own config sets
 * `init.defaultBranch = master` or `core.autocrlf = input` would otherwise see
 * these tests fail for a reason that has nothing to do with the code.
 */

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

/** Skips rather than fails where git is not installed. */
function gitTest(name: string, run: () => Promise<void>): void {
  test(name, async (t) => {
    if (!hasGit()) {
      t.skip('git is not on PATH');
      return;
    }
    await run();
  });
}

let root: string | undefined;

function labRoot(): string {
  if (root === undefined) {
    // `realpathSync` because the temporary directory is a symlink on macOS and a
    // short path on Windows, and git reports the resolved one.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ledger-reader-')));
    const global = path.join(root, 'gitconfig');
    const system = path.join(root, 'gitconfig-system');
    fs.writeFileSync(
      global,
      '[user]\n\tname = Repo Ledger Test\n\temail = test@example.invalid\n' +
        '[init]\n\tdefaultBranch = main\n' +
        '[commit]\n\tgpgsign = false\n' +
        '[core]\n\tautocrlf = false\n',
    );
    fs.writeFileSync(system, '');
    // Set on this process rather than passed per command, because the read under
    // test spawns git itself and inherits the environment.
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_SYSTEM = system;
    // So that the "not a repository" fixture is one on every machine. Without
    // it, a checkout of this project living under a temporary directory that is
    // itself inside a repository would make git answer for a directory this test
    // needs it to refuse.
    process.env.GIT_CEILING_DIRECTORIES = root;
  }
  return root;
}

after(() => {
  if (root === undefined) {
    return;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A packfile Windows still has open is not worth failing a green suite for.
  }
});

let serial = 0;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(dir: string, relative: string, content: string): void {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A fresh repository, with one commit unless told otherwise. */
function makeRepo(
  name: string,
  options: { bare?: boolean; commit?: boolean; subject?: string } = {},
): string {
  serial += 1;
  const dir = path.join(labRoot(), `${name}-${serial}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, options.bare === true ? ['init', '-q', '--bare', '.'] : ['init', '-q', '.']);
  if (options.commit !== false && options.bare !== true) {
    write(dir, 'kept.txt', 'kept\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', options.subject ?? 'initial']);
  }
  return dir;
}

/** A plain directory that is not a repository and, thanks to the ceiling, is not inside one. */
function makeDirectory(name: string): string {
  serial += 1;
  const dir = path.join(labRoot(), `${name}-${serial}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The discovered repository the reader is handed.
 *
 * Built by the real classifier rather than by hand, so a change to how a `.git`
 * entry is resolved shows up here rather than being papered over by a fixture
 * that agreed with the old behaviour.
 */
async function discover(dir: string, bare = false): Promise<DiscoveredRepository> {
  return classifyRepository(
    bare
      ? { worktreePath: dir, gitIsFile: false, source: 'settings' }
      : { worktreePath: dir, gitPath: path.join(dir, '.git'), gitIsFile: false, source: 'settings' },
  );
}

// ---------------------------------------------------------------------------
// Tier one, one repository at a time
// ---------------------------------------------------------------------------

gitTest('an ordinary repository yields a complete row with its last commit on it', async () => {
  const dir = makeRepo('ordinary', { subject: 'Teach the parser about a|pipe' });
  const row = await readRow(await discover(dir));

  assert.equal(row.failure, undefined);
  assert.deepEqual(row.head, { kind: 'branch', name: 'main' });
  // No remote was added, so there is no question to answer - which is a
  // different fact from an answer of zero, and the model keeps them apart.
  assert.deepEqual(row.divergence, { kind: 'no-upstream' });
  assert.equal(row.lastCommit?.subject, 'Teach the parser about a|pipe');
  assert.ok((row.lastCommit?.committedAt ?? 0) > 0);
  // A fresh repository has no FETCH_HEAD, so nothing may be said about how
  // current any of this is. Never "up to date".
  assert.deepEqual(row.fetch, { kind: 'no-record' });
});

gitTest('dirtiness is absent from a tier-one row, and absent is not zero', async () => {
  const dir = makeRepo('untouched-by-tier-one');
  write(dir, 'untracked.txt', 'new\n');

  const row = await readRow(await discover(dir));
  // The whole point of the two tiers: this repository is dirty and the row says
  // nothing about it, because nobody asked. A `counted` tree of four zeros would
  // be the same shape and a completely different claim.
  assert.deepEqual(row.workingTree, { kind: 'not-read' });
});

gitTest('a repository with no commits says so, and says which branch it will land on', async () => {
  const dir = makeRepo('unborn', { commit: false });
  const row = await readRow(await discover(dir));

  // The name costs one extra process, and it is only ever spent on a repository
  // that turned out to be unborn - so it is rare in aggregate and it is the
  // difference between "no commits yet" and "no commits yet on gh-pages".
  assert.deepEqual(row.head, { kind: 'unborn', name: 'main' });
  assert.deepEqual(row.divergence, { kind: 'unknown' });
  assert.equal(row.lastCommit, undefined);
  assert.equal(row.failure, undefined);
});

gitTest('a detached HEAD is read from the same one process, with its commit', async () => {
  const dir = makeRepo('detached');
  write(dir, 'second.txt', 'two\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'second']);
  git(dir, ['checkout', '-q', '--detach', 'HEAD~1']);

  const row = await readRow(await discover(dir));
  assert.equal(row.head.kind, 'detached');
  assert.equal(row.lastCommit?.subject, 'initial');
});

gitTest('an operation left running reaches the row without a second process', async () => {
  const dir = makeRepo('conflicted');
  write(dir, 'f.txt', 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  write(dir, 'f.txt', 'feature\n');
  git(dir, ['commit', '-q', '-am', 'feature']);
  git(dir, ['checkout', '-q', 'main']);
  write(dir, 'f.txt', 'mainline\n');
  git(dir, ['commit', '-q', '-am', 'mainline']);
  try {
    git(dir, ['merge', 'feature']);
    assert.fail('the merge was supposed to conflict');
  } catch {
    // Expected. The state it leaves behind is the point.
  }

  const row = await readRow(await discover(dir));
  // `status --porcelain=v2` does not mention a merge anywhere in its output, so
  // this came off the filesystem beside the one process the row costs.
  assert.equal(row.operation?.kind, 'merge');
  assert.deepEqual(row.head, { kind: 'branch', name: 'main' });
});

gitTest('a bare repository is read like any other, from the directory itself', async () => {
  const dir = makeRepo('bare', { bare: true });
  const repository = await discover(dir, true);
  assert.equal(repository.kind, 'bare');

  const row = await readRow(repository);
  assert.equal(row.failure, undefined);
  // A bare repository built by `git init --bare` has no commits, so this is the
  // unborn row again - reached without a working tree anywhere in sight.
  assert.equal(row.head.kind, 'unborn');
});

gitTest('a directory git will not answer for yields a row carrying the command it ran', async () => {
  const dir = makeDirectory('not-a-repository');
  const row = await readRow(await discover(dir));

  assert.equal(row.failure?.summary, 'not a git repository');
  // Every one of these matters. The command is what makes the row falsifiable;
  // git's own words are what make it debuggable; and the row exists at all
  // rather than the repository quietly vanishing from the board, because a
  // missing row is indistinguishable from a repository that was never there.
  assert.match(row.failure?.command ?? '', /^git .*for-each-ref/);
  assert.match(row.failure?.stderr ?? '', /not a git repository/);
  assert.deepEqual(row.head, { kind: 'unknown' });
  assert.deepEqual(row.workingTree, { kind: 'not-read' });
});

gitTest('a repository that does not answer in time says so, and says how long it waited', async () => {
  const dir = makeRepo('slow');
  // One millisecond cannot outlast a process spawn on any platform, so the
  // timeout fires while git is still starting. The budget is per repository
  // rather than per process, which is what stops the fallback path for an old
  // git from holding one worker for three times this number.
  const row = await readRow(await discover(dir), { timeoutMs: 1 });

  assert.match(row.failure?.summary ?? '', /^did not answer in /);
  assert.match(row.failure?.command ?? '', /for-each-ref/);
});

gitTest('the tier-one read leaves the git directory byte for byte as it found it', async () => {
  // The one promise the extension makes. `for-each-ref` takes no opportunistic
  // lock, but the assertion is here rather than assumed, because the day this
  // read grows a second command is the day it stops being true silently.
  const dir = makeRepo('untouched');
  write(dir, 'a.txt', 'a\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'files']);

  const before = new Map<string, Buffer>();
  for (const name of ['index', 'HEAD', 'config']) {
    before.set(name, fs.readFileSync(path.join(dir, '.git', name)));
  }

  await readRow(await discover(dir));

  for (const [name, bytes] of before) {
    assert.deepEqual(
      fs.readFileSync(path.join(dir, '.git', name)),
      bytes,
      `the row read wrote to .git/${name}, which the extension promises never to do`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tier one, over a directory of them
// ---------------------------------------------------------------------------

let manyRepositories: DiscoveredRepository[] | undefined;

/** Eight repositories, built once and shared: each one costs three git processes to make. */
async function many(): Promise<DiscoveredRepository[]> {
  if (manyRepositories === undefined) {
    const dirs = Array.from({ length: 8 }, (_, index) =>
      makeRepo(`many-${index}`, { subject: `commit ${index}` }),
    );
    manyRepositories = await Promise.all(dirs.map((dir) => discover(dir)));
  }
  return manyRepositories;
}

gitTest('rows arrive one at a time while the pass is still running', async () => {
  const repositories = await many();
  const arrived: string[] = [];
  let finished = false;

  const pass = readRows({
    repositories,
    concurrency: 2,
    onRow: (row) => {
      // The contract this asserts is the one the module's return type enforces:
      // rows leave through the callback, and there is deliberately no way to
      // await a promise that resolves with all of them. A directory of two
      // hundred repositories must fill in progressively.
      assert.equal(finished, false, 'a row arrived only after the whole pass had finished');
      // And it arrives complete rather than as a placeholder to be filled in:
      // everything except the working-tree count is on it already.
      assert.ok(row.lastCommit, 'a row arrived without the commit that is the point of it');
      arrived.push(row.repository.path);
    },
  });
  void pass.then(() => {
    finished = true;
  });
  const outcome = await pass;

  assert.equal(arrived.length, repositories.length);
  assert.equal(outcome.emitted, repositories.length);
  assert.equal(outcome.unreadable, 0);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.concurrency, 2);
});

gitTest('a pass aborted before it starts spawns nothing and emits nothing', async () => {
  const repositories = await many();
  const controller = new AbortController();
  controller.abort();

  const outcome = await readRows({
    repositories,
    signal: controller.signal,
    onRow: () => {
      assert.fail('a superseded pass emitted a row');
    },
  });

  assert.equal(outcome.emitted, 0);
  assert.equal(outcome.aborted, true);
});

gitTest('a superseded pass stops reading, and the rows already in flight are dropped', async () => {
  const repositories = await many();
  const controller = new AbortController();
  let stopped = false;
  let emitted = 0;

  const outcome = await readRows({
    repositories,
    concurrency: 4,
    signal: controller.signal,
    onRow: () => {
      assert.equal(stopped, false, 'a row from a superseded pass was merged into the board');
      emitted += 1;
      controller.abort();
      stopped = true;
    },
  });

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.emitted, emitted);
  // Four reads were in flight when the abort landed and at most those four can
  // have finished before it; the remaining repositories were never taken. The
  // ones that did finish afterwards were discarded rather than published,
  // because a board mixing rows from two passes is a list nobody can explain.
  assert.ok(emitted <= 4, `${emitted} rows were emitted after an abort`);
  assert.ok(emitted < repositories.length);
});

gitTest('a repository git refuses is one unreadable row among the readable ones', async () => {
  const repositories = [...(await many()).slice(0, 2), await discover(makeDirectory('broken'))];
  const rows: RepositoryRow[] = [];

  const outcome = await readRows({ repositories, onRow: (row) => rows.push(row) });

  assert.equal(outcome.emitted, 3);
  assert.equal(outcome.unreadable, 1);
  assert.equal(rows.filter((row) => row.failure !== undefined).length, 1);
  // The point of counting them: two good rows are still on the board. One
  // repository that cannot be read must not decide what the other two show.
  assert.equal(rows.filter((row) => row.lastCommit !== undefined).length, 2);
});

// ---------------------------------------------------------------------------
// Tier two
// ---------------------------------------------------------------------------

gitTest('a clean tree is counted, and the zeros it reports are established zeros', async () => {
  const dir = makeRepo('clean-tier-two');
  const row = await readRow(await discover(dir));
  assert.deepEqual(row.workingTree, { kind: 'not-read' });

  const filled = await fillDirtyState(row);
  assert.deepEqual(filled?.workingTree, {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  });
  // Nothing else about the row moved: tier two fills one field in behind a row
  // that was already complete without it.
  assert.deepEqual(filled?.head, row.head);
  assert.deepEqual(filled?.lastCommit, row.lastCommit);
});

gitTest('a dirty tree is counted into its four buckets', async () => {
  const dir = makeRepo('dirty-tier-two');
  write(dir, 'kept.txt', 'kept\nand edited\n');
  write(dir, 'staged.txt', 'new\n');
  git(dir, ['add', 'staged.txt']);
  write(dir, 'untracked.txt', 'new\n');

  const filled = await fillDirtyState(await readRow(await discover(dir)));
  assert.deepEqual(filled?.workingTree, {
    kind: 'counted',
    counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
  });
});

gitTest('a bare repository is not asked, and its row is not re-emitted', async () => {
  const dir = makeRepo('bare-tier-two', { bare: true });
  const row = await readRow(await discover(dir, true));

  // Asking a bare repository what is uncommitted is asking a question that does
  // not exist - git exits 128 - so no process is spawned and the row keeps the
  // `not-read` it already had. It is emphatically not counted as clean.
  assert.equal(await fillDirtyState(row), undefined);
});

gitTest('a row git already refused is not asked a second time', async () => {
  const row = await readRow(await discover(makeDirectory('refused-tier-two')));
  assert.ok(row.failure);
  // The refusal is a fact about this generation: a second process would buy the
  // same answer, and the row has nothing for the count to attach to anyway.
  assert.equal(await fillDirtyState(row), undefined);
});

gitTest('the second-tier pass reports only the rows that gained something', async () => {
  const clean = await readRow(await discover(makeRepo('pass-clean')));
  const bare = await readRow(await discover(makeRepo('pass-bare', { bare: true }), true));
  const dirtyDir = makeRepo('pass-dirty');
  write(dirtyDir, 'untracked.txt', 'x\n');
  const dirty = await readRow(await discover(dirtyDir));

  const filled: RepositoryRow[] = [];
  const outcome = await readDirtyState({
    rows: [clean, bare, dirty],
    onRow: (row) => filled.push(row),
  });

  assert.equal(outcome.emitted, 2);
  assert.equal(filled.length, 2);
  assert.deepEqual(
    filled.map((row) => row.workingTree.kind).sort(),
    ['counted', 'counted'],
  );
  // And the row nobody asked about still says nobody asked.
  assert.deepEqual(bare.workingTree, { kind: 'not-read' });
});

gitTest('a superseded second-tier pass drops its answers too', async () => {
  const rows = await Promise.all(
    (await many()).map(async (repository) => readRow(repository)),
  );
  const controller = new AbortController();
  controller.abort();

  const outcome = await readDirtyState({
    rows,
    signal: controller.signal,
    onRow: () => {
      assert.fail('a superseded second-tier pass emitted a row');
    },
  });

  assert.equal(outcome.emitted, 0);
  assert.equal(outcome.aborted, true);
});
