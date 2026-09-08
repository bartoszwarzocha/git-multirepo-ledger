import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import type { GitResult } from '../util/git.ts';
import { runGit } from '../util/git.ts';
import {
  canReadWorkingTree,
  interpretStatusResult,
  parseStatus,
  readWorkingTree,
  statusArgs,
} from './status.ts';

/*
 * Every fixture below is real output, captured from git 2.52.0.windows.1 in a
 * scratch repository driven into that exact state, and pasted unedited. Hand-
 * written fixtures were considered and rejected: the whole risk in this module
 * is a wrong belief about the format - how a rename encodes its two paths, what
 * happens to a name with a space or an accent in it, whether `branch.ab` is
 * absent or holds a question mark - and a fixture written from the same wrong
 * belief as the parser tests nothing at all. The integration tests at the
 * bottom then re-derive the same states through a live git, so a future git
 * that changes the format fails here rather than in a user's sidebar.
 */

// ---------------------------------------------------------------------------
// Captured output
// ---------------------------------------------------------------------------

/**
 * A worktree carrying one file staged and then edited again, one edited but not
 * staged, one newly added, one renamed, and three untracked - two of which have
 * a space in the name and one of which is `zażółć-gęślą.txt`.
 *
 * The backslashes in the last line are doubled here and nowhere else: a
 * template literal rejects an octal escape, so `\305` has to be written `\\305`
 * to produce the two characters git actually printed. The point of keeping the
 * line at all is that it proves what git does with a non-ASCII path - it quotes
 * it, byte by byte, in C-style octal - so the parser must not assume a path is
 * a plain word, and a count must not depend on decoding one.
 */
const RICH = `# branch.oid 4c81f9292b219e67c523a235d05b78dff63e67dc
# branch.head main
1 MM N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 c7847ad61953798d1622536bb1374c1c9e78c23c a.txt
1 .M N... 100644 100644 100644 f719efd430d52bcfc8566a43b2eb655688d38871 f719efd430d52bcfc8566a43b2eb655688d38871 b.txt
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 587be6b4c3f93f93c489c0111bba5596147a26cb dir with space/tracked me.txt
2 R. N... 100644 100644 100644 0ec1772728d194cd451203c28b1d4184aa1575cc 0ec1772728d194cd451203c28b1d4184aa1575cc R100 renamed.txt\ttorename.txt
? untracked with space.txt
? untracked.txt
? "za\\305\\274\\303\\263\\305\\202\\304\\207-g\\304\\231\\305\\233l\\304\\205.txt"
`;

/** The same repository after the renamed file was edited: `R` staged, `M` not. */
const RENAMED_THEN_EDITED = `# branch.oid 4c81f9292b219e67c523a235d05b78dff63e67dc
# branch.head main
2 RM N... 100644 100644 100644 0ec1772728d194cd451203c28b1d4184aa1575cc 0ec1772728d194cd451203c28b1d4184aa1575cc R100 renamed.txt\ttorename.txt
`;

/** A merge left conflicted. One of the two paths has a space in it. */
const CONFLICTED = `# branch.oid 097687773f527489cd0c1195b6e2da9a3e4d0bec
# branch.head main
u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 cbb9aa30a6518a54df04c4d7b62e5c5e2864eafc a7453f07505c42ea8d6fdda75fa91710c81c53d6 f.txt
u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 cbb9aa30a6518a54df04c4d7b62e5c5e2864eafc a7453f07505c42ea8d6fdda75fa91710c81c53d6 sp ace.txt
`;

const IN_SYNC = `# branch.oid 6c3be79eaa6bc1ceec026d0cc5cd4c460eedebcf
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
`;

const AHEAD_AND_BEHIND = `# branch.oid 4af5856e448a523bfbe6afbae379b3907f52438e
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
`;

/**
 * A branch whose upstream was deleted on the remote and pruned locally.
 *
 * `# branch.upstream` is still printed - the configuration is still there - and
 * `# branch.ab` is simply absent. This is the fixture the `gone` case rests on.
 */
const UPSTREAM_GONE = `# branch.oid 4af5856e448a523bfbe6afbae379b3907f52438e
# branch.head orphanish
# branch.upstream origin/orphanish
? .gitignore
`;

/**
 * What `--no-ahead-behind` prints. `statusArgs` never passes it, but the token
 * exists, and reading `+?` as a number would silently produce the zero this
 * whole model is built to avoid.
 */
const AHEAD_BEHIND_UNCOMPUTED = `# branch.oid 4af5856e448a523bfbe6afbae379b3907f52438e
# branch.head main
# branch.upstream origin/main
# branch.ab +? -?
`;

const DETACHED = `# branch.oid 5f1b6b771abc888afba952751a8ae7a64987fc68
# branch.head (detached)
? .gitignore
`;

/** `git init`, one file staged, one untracked, and no commit yet. */
const UNBORN = `# branch.oid (initial)
# branch.head main
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 new.txt
? untr.txt
`;

/** Captured under `--ignored`, which `statusArgs` does not pass. */
const WITH_IGNORED = `# branch.oid 4af5856e448a523bfbe6afbae379b3907f52438e
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
? .gitignore
! noise.log
`;

/**
 * A submodule with a modified file and an untracked file inside it. The `S.MU`
 * field is the reason the parser matches on that four-character position rather
 * than on the literal `N...` everything else prints.
 */
const DIRTY_SUBMODULE = `# branch.oid b4cdc9db3b1c839742df3a6af6978140f8b799d1
# branch.head main
1 .M S.MU 160000 160000 160000 2aefc50693e5ca7f00ee6e06195b312e08cd6043 2aefc50693e5ca7f00ee6e06195b312e08cd6043 sub
`;

/** Captured under `--show-stash`, which `statusArgs` does not pass either. */
const WITH_STASH = `# branch.oid 4af5856e448a523bfbe6afbae379b3907f52438e
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
# stash 1
`;

/** git's answer in a bare repository, verified: exit 128 and this one line. */
const BARE_STDERR = 'fatal: this operation must be run in a work tree\n';

/**
 * git's answer when `--no-optional-locks` is put after the subcommand, verified:
 * exit 129, and then thirty lines of usage text.
 */
const WRONG_ORDER_STDERR = `error: unknown option \`no-optional-locks'
usage: git status [<options>] [--] [<pathspec>...]

    -v, --[no-]verbose    be verbose
`;

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('--no-optional-locks precedes the subcommand, which is the only order git accepts', () => {
  // Asserted as an exact array rather than with `includes`, because the bug
  // this guards against is not a missing flag but a flag in the wrong place:
  // `git status --porcelain=v2 --no-optional-locks` exits 129 and every row
  // would report an unreadable working tree while the index went on being
  // rewritten. A membership test would pass on the broken order.
  assert.deepEqual(statusArgs(), [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
  ]);
});

test('the argument array is a fresh one each call, so a caller cannot edit the next read', () => {
  const first = statusArgs();
  first.push('--ignored');
  assert.deepEqual(statusArgs(), [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
  ]);
});

test('a bare repository is not asked, because it has no working tree to have counted', () => {
  assert.equal(canReadWorkingTree('bare'), false);
  assert.equal(canReadWorkingTree('plain'), true);
  assert.equal(canReadWorkingTree('worktree'), true);
  assert.equal(canReadWorkingTree('submodule'), true);
  // An unclassified repository is still asked. It may turn out to be bare, in
  // which case git says so and the row reports that reason - which is a better
  // answer than skipping a repository that was probably readable.
  assert.equal(canReadWorkingTree('unknown'), true);
});

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

test('a file staged and then edited again counts once as staged and once as unstaged', () => {
  const { counts } = parseStatus(RICH);
  // `1 MM ... a.txt` is the file in question. The other staged entries are the
  // added file and the rename; the other unstaged one is `b.txt`.
  assert.deepEqual(counts, { staged: 3, unstaged: 2, untracked: 3, conflicted: 0 });
});

test('a rename edited after it was staged is one staged change and one unstaged change', () => {
  const { counts } = parseStatus(RENAMED_THEN_EDITED);
  assert.deepEqual(counts, { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
});

test('an unmerged path is counted as conflicted and nowhere else', () => {
  const { counts } = parseStatus(CONFLICTED);
  // `UU` is a pair of conflict codes, not a staged/unstaged pair. Counting it
  // as both would show one conflicted file three times across the four numbers.
  assert.deepEqual(counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 });
});

test('a path with a space is one entry, not two', () => {
  // `dir with space/tracked me.txt`, `untracked with space.txt` and, in the
  // conflicted fixture, `sp ace.txt`. Nothing in the parser may split on
  // whitespace past the fixed fields.
  assert.equal(parseStatus(RICH).counts.untracked, 3);
  assert.equal(parseStatus(CONFLICTED).counts.conflicted, 2);
});

test('a non-ASCII path arrives quoted and is still exactly one untracked entry', () => {
  const line = RICH.split('\n').find((l) => l.startsWith('? "'));
  assert.ok(line, 'the fixture must still contain the quoted path this test is about');
  assert.equal(parseStatus(`${line}\n`).counts.untracked, 1);
});

test('an ignored entry is counted nowhere', () => {
  const { counts } = parseStatus(WITH_IGNORED);
  // A build directory is not uncommitted work, and adding it to any of the four
  // numbers would make every repository that has one look dirty.
  assert.deepEqual(counts, { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 });
});

test('a dirty submodule is an ordinary unstaged change, S-field and all', () => {
  const parsed = parseStatus(DIRTY_SUBMODULE);
  assert.deepEqual(parsed.counts, { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
  assert.equal(parsed.unrecognized, 0);
});

test('a repository with no commits still counts what is staged', () => {
  const parsed = parseStatus(UNBORN);
  assert.deepEqual(parsed.counts, { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 });
});

test('a clean repository counts zero, and that zero is an answer rather than a silence', () => {
  const parsed = parseStatus(IN_SYNC);
  assert.deepEqual(parsed.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  assert.equal(parsed.unrecognized, 0);
  // The distinction is not made here - `parseStatus` only ever describes output
  // that arrived - but by `interpretStatusResult`, which is what decides whether
  // these zeros are allowed to become a `counted` working tree.
  assert.equal(interpretStatusResult(ok(IN_SYNC)).workingTree.kind, 'counted');
});

// ---------------------------------------------------------------------------
// The headers
// ---------------------------------------------------------------------------

test('a branch with an upstream that agrees is in sync, not zero-diverged', () => {
  assert.deepEqual(parseStatus(IN_SYNC).branch, {
    head: { kind: 'branch', name: 'main' },
    divergence: { kind: 'in-sync', upstream: 'origin/main' },
  });
});

test('ahead and behind are read as the two numbers they are', () => {
  assert.deepEqual(parseStatus(AHEAD_AND_BEHIND).branch.divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  });
});

test('an upstream with no branch.ab line is gone, not in sync', () => {
  // The claim rests on having eliminated the other way the header can go
  // missing: `status.aheadBehind=false` was verified not to suppress it in
  // porcelain output, and `--no-ahead-behind` prints `+? -?` rather than
  // dropping the line. So an absent line means git could not resolve the ref.
  assert.deepEqual(parseStatus(UPSTREAM_GONE).branch.divergence, {
    kind: 'gone',
    upstream: 'origin/orphanish',
  });
});

test('an ahead/behind git declined to compute is unknown, and never a zero', () => {
  assert.deepEqual(parseStatus(AHEAD_BEHIND_UNCOMPUTED).branch.divergence, { kind: 'unknown' });
});

test('a branch that tracks nothing has no upstream, which is not the same as unknown', () => {
  assert.deepEqual(parseStatus(RICH).branch, {
    head: { kind: 'branch', name: 'main' },
    divergence: { kind: 'no-upstream' },
  });
});

test('a detached HEAD keeps the full object id and says nothing about divergence', () => {
  assert.deepEqual(parseStatus(DETACHED).branch, {
    // The full id, not an abbreviation: `shortSha` in model/keys.ts is
    // idempotent on an already-short value, so the view can shorten this at
    // render time, whereas a value shortened here could never be lengthened.
    head: { kind: 'detached', sha: '5f1b6b771abc888afba952751a8ae7a64987fc68' },
    // Silence rather than "no upstream", which would be a true answer to a
    // question nobody asked of a row that already says `detached at 5f1b6b7`.
    divergence: { kind: 'unknown' },
  });
});

test('a repository with no commits reports an unborn branch by name', () => {
  assert.deepEqual(parseStatus(UNBORN).branch, {
    head: { kind: 'unborn', name: 'main' },
    divergence: { kind: 'unknown' },
  });
});

test('output with no branch headers at all establishes nothing about the branch', () => {
  // A caller that dropped `--branch`, or a read cut off before the headers.
  // An empty object is what says "not established"; a branch called `''` would
  // render as an answered repository whose fields happened to be blank.
  assert.deepEqual(parseStatus('? a.txt\n').branch, {});
  assert.deepEqual(parseStatus('').branch, {});
});

test('a header this module did not ask for is skipped without spoiling the read', () => {
  const parsed = parseStatus(WITH_STASH);
  // `# stash 1` only appears under `--show-stash`. It cannot make a count
  // wrong, so it must not mark the read incomplete.
  assert.equal(parsed.unrecognized, 0);
  assert.deepEqual(parsed.branch.divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
  });
});

// ---------------------------------------------------------------------------
// Refusing to guess
// ---------------------------------------------------------------------------

test('a line in a shape the parser does not know is reported rather than dropped', () => {
  const output = `${IN_SYNC}9 something entirely new\n`;
  assert.equal(parseStatus(output).unrecognized, 1);
  // The counts that did arrive are still returned by the parser; it is
  // `interpretStatusResult` that decides they may no longer be published as a
  // complete answer. A git that grows a record type this code has never seen
  // therefore makes rows say "I could not finish reading", which is noisier
  // than ignoring the line and is the direction that cannot mislead: ignoring
  // it would undercount, and an undercount reads as a quieter repository.
  const read = interpretStatusResult(ok(output));
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.equal(read.failure?.summary, 'unrecognised output');
});

test('an entry line missing its submodule field is not counted as a change', () => {
  // This is the shape a path that got onto its own line would have to fake. It
  // is rejected, counted as unrecognised, and so turns the read into an
  // `incomplete` rather than into a silently wrong number.
  const parsed = parseStatus('1 MM a.txt\n');
  assert.deepEqual(parsed.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  assert.equal(parsed.unrecognized, 1);
});

test('the parser never throws, whatever it is handed', () => {
  const inputs = [
    '',
    '\n\n\n',
    '#',
    '# ',
    '# branch.ab',
    '# branch.head',
    '1',
    '1 ',
    '? ',
    '! ',
    'u',
    '\u0000\u0001\u0002',
    '# branch.oid',
    '# branch.ab +1',
    '# branch.ab -1 +1',
    '# branch.ab +99999999999999999999 -0',
    RICH.slice(0, 200),
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseStatus(input), `parseStatus threw on ${JSON.stringify(input)}`);
  }
});

test('a read cut off part way through is incomplete, never clean', () => {
  const truncated: GitResult = { ...ok(RICH.slice(0, 180)), truncated: true };
  const read = interpretStatusResult(truncated);
  assert.equal(read.workingTree.kind, 'incomplete');
  // The headers arrive before any entry, so what the read did establish about
  // the branch survives. Discarding it with the counts would blank a field that
  // was never in doubt.
  assert.deepEqual(read.branch.head, { kind: 'branch', name: 'main' });
  assert.equal(read.failure?.command, 'git --no-optional-locks status --porcelain=v2 --branch');
});

test('a timeout is reported as a timeout, before the exit code of the process that was killed', () => {
  const read = interpretStatusResult({
    ...ok(''),
    code: -1,
    timedOut: true,
  });
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.equal(read.failure?.summary, 'timed out');
});

test('git refusing the directory reports its own words, not a paraphrase', () => {
  const read = interpretStatusResult({
    ...ok(''),
    code: 128,
    stderr:
      "fatal: detected dubious ownership in repository at 'D:/shared/thing'\n" +
      "To add an exception for this directory, call:\n",
  });
  assert.equal(read.failure?.summary, 'git refused this directory');
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.match(
    read.workingTree.kind === 'incomplete' ? read.workingTree.reason : '',
    /dubious ownership/,
  );
});

test('a bare repository asked anyway reports that it has no working tree', () => {
  const read = interpretStatusResult({ ...ok(''), code: 128, stderr: BARE_STDERR });
  assert.equal(read.failure?.summary, 'no working tree');
});

test('the wrong flag order would have been reported, not silently mistaken for a clean tree', () => {
  // Belt and braces around the one mistake this module exists to stop being
  // made twice: even if `statusArgs` were rewritten wrongly, exit 129 lands in
  // the incomplete path with git's own complaint attached, rather than being
  // read as a repository with nothing to report.
  const read = interpretStatusResult({ ...ok(''), code: 129, stderr: WRONG_ORDER_STDERR });
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.equal(read.failure?.summary, 'git exited 129');
  assert.match(
    read.workingTree.kind === 'incomplete' ? read.workingTree.reason : '',
    /unknown option `no-optional-locks'/,
  );
});

test('a failure with nothing on stderr still says what exited and what was run', () => {
  const read = interpretStatusResult({ ...ok(''), code: 5, stderr: '   \n  ' });
  assert.equal(read.failure?.summary, 'git exited 5');
  assert.equal(
    read.workingTree.kind === 'incomplete' ? read.workingTree.reason : '',
    'git exited 5 without saying why.',
  );
});

test('carriage returns do not turn every line into an unrecognised one', () => {
  const parsed = parseStatus(RICH.replace(/\n/g, '\r\n'));
  assert.equal(parsed.unrecognized, 0);
  assert.deepEqual(parsed.counts, { staged: 3, unstaged: 2, untracked: 3, conflicted: 0 });
});

function ok(stdout: string): GitResult {
  return {
    code: 0,
    stdout,
    stderr: '',
    timedOut: false,
    truncated: false,
    command: 'git --no-optional-locks status --porcelain=v2 --branch',
  };
}

// ---------------------------------------------------------------------------
// Against a live git
// ---------------------------------------------------------------------------

/*
 * The fixtures above prove the parser reads what git printed on one day. These
 * prove git still prints it. They are the half that catches a format change, a
 * git built with different defaults, and a platform where a path or a line
 * ending behaves differently from the machine the fixtures came from.
 *
 * Repositories are built under the system temporary directory and never
 * anywhere the user keeps work. Global and system git configuration is replaced
 * with files this suite writes, because a developer whose own config sets
 * `status.showUntrackedFiles = no` or `core.autocrlf = input` would otherwise
 * see these tests fail for a reason that has nothing to do with the code.
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
    // `realpathSync` because the temporary directory is a symlink on macOS and
    // a short path on Windows, and git reports the resolved one.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multirepo-ledger-status-')));
    const global = path.join(root, 'gitconfig');
    const system = path.join(root, 'gitconfig-system');
    fs.writeFileSync(
      global,
      '[user]\n\tname = Multirepo Ledger Test\n\temail = test@example.invalid\n' +
        '[init]\n\tdefaultBranch = main\n' +
        '[commit]\n\tgpgsign = false\n' +
        '[core]\n\tautocrlf = false\n',
    );
    fs.writeFileSync(system, '');
    // Set on this process rather than passed per command, because the read
    // under test spawns git itself and inherits the environment.
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.GIT_CONFIG_SYSTEM = system;
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

/** A fresh repository with one commit in it, unless `bare`. */
function makeRepo(name: string, options: { bare?: boolean; commit?: boolean } = {}): string {
  serial += 1;
  const dir = path.join(labRoot(), `${name}-${serial}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, options.bare ? ['init', '-q', '--bare', '.'] : ['init', '-q', '.']);
  if (options.commit !== false && !options.bare) {
    write(dir, 'kept.txt', 'kept\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'initial']);
  }
  return dir;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(dir: string, relative: string, content: string): void {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

gitTest('a clean repository is counted, and its zeros are established zeros', async () => {
  const dir = makeRepo('clean');
  const read = await readWorkingTree({ cwd: dir });
  assert.deepEqual(read.workingTree, {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  });
  assert.deepEqual(read.branch.head, { kind: 'branch', name: 'main' });
  assert.deepEqual(read.branch.divergence, { kind: 'no-upstream' });
  assert.equal(read.failure, undefined);
});

gitTest('every kind of dirt a live repository can carry lands in its own bucket', async () => {
  const dir = makeRepo('dirty');
  write(dir, 'staged-then-edited.txt', 'one\n');
  write(dir, 'unstaged.txt', 'one\n');
  write(dir, 'to-rename.txt', 'r1\nr2\nr3\nr4\nr5\n');
  write(dir, 'dir with space/tracked me.txt', 'one\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'second']);

  write(dir, 'staged-then-edited.txt', 'one\ntwo\n');
  git(dir, ['add', 'staged-then-edited.txt']);
  write(dir, 'staged-then-edited.txt', 'one\ntwo\nthree\n');
  write(dir, 'unstaged.txt', 'one\ntwo\n');
  write(dir, 'dir with space/tracked me.txt', 'one\ntwo\n');
  git(dir, ['mv', 'to-rename.txt', 'renamed.txt']);
  write(dir, 'untracked.txt', 'new\n');
  write(dir, 'untracked with space.txt', 'new\n');
  write(dir, 'zażółć-gęślą.txt', 'new\n');

  const read = await readWorkingTree({ cwd: dir });
  assert.deepEqual(read.workingTree, {
    kind: 'counted',
    counts: {
      // The rename and the file that was staged before it was edited again.
      staged: 2,
      // That same file a second time, plus `unstaged.txt` and the tracked file
      // whose directory has a space in its name.
      unstaged: 3,
      untracked: 3,
      conflicted: 0,
    },
  });
});

gitTest('a real conflict counts as conflicted and leaves the other buckets alone', async () => {
  const dir = makeRepo('conflict');
  write(dir, 'f.txt', 'base\n');
  write(dir, 'sp ace.txt', 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  write(dir, 'f.txt', 'feature\n');
  write(dir, 'sp ace.txt', 'feature\n');
  git(dir, ['commit', '-q', '-am', 'feature']);
  git(dir, ['checkout', '-q', 'main']);
  write(dir, 'f.txt', 'mainline\n');
  write(dir, 'sp ace.txt', 'mainline\n');
  git(dir, ['commit', '-q', '-am', 'mainline']);
  try {
    git(dir, ['merge', 'feature']);
    assert.fail('the merge was supposed to conflict');
  } catch {
    // Expected: a conflicting merge exits non-zero. The state it leaves behind
    // is the point of the test.
  }

  const read = await readWorkingTree({ cwd: dir });
  assert.deepEqual(read.workingTree, {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 2 },
  });
});

gitTest('a repository with no commits reports an unborn branch and still counts', async () => {
  const dir = makeRepo('unborn', { commit: false });
  write(dir, 'new.txt', 'hi\n');
  git(dir, ['add', 'new.txt']);
  write(dir, 'untracked.txt', 'hi\n');

  const read = await readWorkingTree({ cwd: dir });
  assert.deepEqual(read.branch.head, { kind: 'unborn', name: 'main' });
  assert.deepEqual(read.branch.divergence, { kind: 'unknown' });
  assert.deepEqual(read.workingTree, {
    kind: 'counted',
    counts: { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 },
  });
});

gitTest('a detached HEAD is reported by object id, with no divergence claimed', async () => {
  const dir = makeRepo('detached');
  write(dir, 'second.txt', 'two\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'second']);
  const head = git(dir, ['rev-parse', 'HEAD~1']).trim();
  git(dir, ['checkout', '-q', '--detach', 'HEAD~1']);

  const read = await readWorkingTree({ cwd: dir });
  assert.deepEqual(read.branch.head, { kind: 'detached', sha: head });
  assert.deepEqual(read.branch.divergence, { kind: 'unknown' });
});

gitTest('a bare repository is not spawned against, and does not report a clean tree', async () => {
  const dir = makeRepo('bare', { bare: true });

  // What the caller gets: nothing was attempted, so nothing is claimed.
  const read = await readWorkingTree({ cwd: dir, kind: 'bare' });
  assert.deepEqual(read.workingTree, { kind: 'not-read' });
  assert.deepEqual(read.branch, {});

  // And why it is worth not asking: git refuses outright. Asserted here so the
  // reason in `canReadWorkingTree` is checkable rather than remembered.
  const refused = await runGit(statusArgs(), { cwd: dir });
  assert.equal(refused.code, 128);
  assert.match(refused.stderr, /must be run in a work tree/);
  assert.equal(interpretStatusResult(refused).failure?.summary, 'no working tree');
});

gitTest('the flag after the subcommand really does exit 129, on this git too', async () => {
  const dir = makeRepo('flag-order');
  const wrong = await runGit(['status', '--porcelain=v2', '--no-optional-locks'], { cwd: dir });
  assert.equal(wrong.code, 129);
  assert.match(wrong.stderr, /unknown option `no-optional-locks'/);

  const right = await runGit(statusArgs(), { cwd: dir });
  assert.equal(right.code, 0);
});

gitTest('the read leaves .git/index byte for byte as it found it', async () => {
  // The extension's one promise, tested rather than asserted. Comparing the
  // whole file rather than its mtime because a refresh rewrites the stat data
  // recorded for every entry, so the bytes differ even where a filesystem's
  // timestamp resolution would not show it.
  const dir = makeRepo('index');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    write(dir, name, `${name}\n`);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'files']);
  const indexPath = path.join(dir, '.git', 'index');

  const stale = (): void => {
    // An mtime a minute in the past does not match what the index recorded, so
    // git considers every entry worth restatting - which is exactly the
    // condition under which a plain `status` would rewrite the file.
    const when = new Date(Date.now() - 60_000);
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      fs.utimesSync(path.join(dir, name), when, when);
    }
  };

  // The control: without the flag, git does rewrite the index. Without this
  // half the test below could pass because the index was never stale.
  stale();
  const beforePlain = fs.readFileSync(indexPath);
  await runGit(['status', '--porcelain=v2', '--branch'], { cwd: dir });
  assert.notDeepEqual(
    fs.readFileSync(indexPath),
    beforePlain,
    'a plain git status was expected to refresh and rewrite the index',
  );

  stale();
  const before = fs.readFileSync(indexPath);
  const read = await readWorkingTree({ cwd: dir });
  assert.equal(read.workingTree.kind, 'counted');
  assert.deepEqual(
    fs.readFileSync(indexPath),
    before,
    'the read under test wrote to .git/index, which the extension promises never to do',
  );
});

gitTest('an upstream that agrees, one that has moved, and one that is gone', async () => {
  const origin = makeRepo('origin', { bare: true });
  const seed = makeRepo('seed');
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);

  const dir = path.join(labRoot(), `clone-${(serial += 1)}`);
  git(labRoot(), ['clone', '-q', origin, dir]);

  const inSync = await readWorkingTree({ cwd: dir });
  assert.deepEqual(inSync.branch.divergence, { kind: 'in-sync', upstream: 'origin/main' });

  write(seed, 'remote-side.txt', 'theirs\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'theirs']);
  git(seed, ['push', '-q']);
  git(dir, ['fetch', '-q']);
  write(dir, 'local-side.txt', 'mine\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'mine']);

  const diverged = await readWorkingTree({ cwd: dir });
  assert.deepEqual(diverged.branch.divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 1,
    behind: 1,
  });

  // And the case the `gone` branch of the parser exists for: a tracked ref that
  // was deleted on the remote and pruned here.
  git(dir, ['checkout', '-q', '-b', 'doomed']);
  git(dir, ['push', '-q', '-u', 'origin', 'doomed']);
  git(dir, ['push', '-q', 'origin', '--delete', 'doomed']);
  git(dir, ['fetch', '-q', '--prune']);

  const gone = await readWorkingTree({ cwd: dir });
  assert.deepEqual(gone.branch.divergence, { kind: 'gone', upstream: 'origin/doomed' });
});

gitTest('a linked worktree is read like any other working tree', async () => {
  const dir = makeRepo('with-worktree');
  const linked = path.join(labRoot(), `linked-${(serial += 1)}`);
  git(dir, ['worktree', 'add', '-q', linked, '-b', 'side']);
  write(linked, 'only-here.txt', 'x\n');

  const read = await readWorkingTree({ cwd: linked, kind: 'worktree' });
  assert.deepEqual(read.branch.head, { kind: 'branch', name: 'side' });
  assert.deepEqual(read.workingTree, {
    kind: 'counted',
    counts: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
  });
});

gitTest('a byte cap reached mid-listing is incomplete rather than a short count', async () => {
  const dir = makeRepo('truncated');
  // Deliberately far more output than the cap, and not because the cap is
  // 256 bytes here: `runGit` compares its running total against the cap
  // between chunks, so output that arrives in a single read is kept whole
  // however small the cap is. Getting the truncation path to fire at all
  // therefore needs a listing longer than one read of the pipe, which is why
  // this writes a hundred and fifty kilobytes of names rather than a handful
  // of files. Lowering the cap here rather than in the module keeps the
  // production value a guard against the pathological case instead of a
  // number picked to make a test pass.
  const pad = 'n'.repeat(120);
  for (let i = 0; i < 1200; i += 1) {
    write(dir, `untracked-${pad}-${i}.txt`, 'x\n');
  }
  const read = await readWorkingTree({ cwd: dir, maxBytes: 256 });
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.match(
    read.workingTree.kind === 'incomplete' ? read.workingTree.reason : '',
    /size limit/,
  );
  // What did arrive is still trustworthy, and is kept.
  assert.deepEqual(read.branch.head, { kind: 'branch', name: 'main' });
});

gitTest('a directory that is not a repository reports that, and not an empty tree', async () => {
  const dir = path.join(labRoot(), `plain-directory-${(serial += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  const read = await readWorkingTree({ cwd: dir });
  assert.equal(read.workingTree.kind, 'incomplete');
  assert.equal(read.failure?.summary, 'not a git repository');
  assert.equal(read.failure?.command, 'git --no-optional-locks status --porcelain=v2 --branch');
});
