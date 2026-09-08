import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

import { normalizePath } from '../model/keys.ts';
import {
  classifyRepository,
  kindFromGitDirPath,
  labelFor,
  parseGitFile,
  type RepositoryCandidate,
} from './classify.ts';

/*
 * These tests build real repositories with real git and then read them back,
 * rather than writing the `.git` files this module parses by hand.
 *
 * That is the point of them. Everything `classify.ts` knows is a claim about
 * git's on-disk layout - that a linked worktree's `.git` is a file, that a
 * submodule's `gitdir:` is *relative*, that the `shallow` marker lives in the
 * common directory and not in the worktree's own git directory. Each of those
 * is git's implementation detail, not its published interface, so a fixture
 * written from memory would test that this file agrees with itself and would go
 * on passing on the day a git release moved one of them. Only a fixture git
 * built can fail that way.
 *
 * The hand-written fixtures below are the ones git will not produce on demand:
 * a `.git` file pointing at a directory that has been deleted, and one that is
 * not a `.git` file at all.
 */

/** Set once the temporary tree exists, so every git call sees the same config. */
let gitEnv: NodeJS.ProcessEnv = process.env;
let root = '';

/**
 * git may not be installed, and a suite that fails for that reason is reporting
 * the wrong thing: nothing about this module is broken on a machine without git.
 * It reports a skip instead, which is the same answer the extension gives for a
 * repository it cannot read.
 */
const gitMissing = spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0;
const skip = gitMissing ? 'git is not on PATH' : false;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} exited ${result.status}: ${result.stderr || result.error?.message}`,
    );
  }
}

/** A candidate as the walk would hand it over: `.git` is a directory. */
function dirCandidate(worktreePath: string): RepositoryCandidate {
  return {
    worktreePath,
    gitPath: path.join(worktreePath, '.git'),
    gitIsFile: false,
    source: 'settings',
  };
}

/** A candidate whose `.git` is a file - a worktree, a submodule, a separate git dir. */
function fileCandidate(worktreePath: string): RepositoryCandidate {
  return {
    worktreePath,
    gitPath: path.join(worktreePath, '.git'),
    gitIsFile: true,
    source: 'settings',
  };
}

/** A candidate with no `.git` entry at all - the only way a bare repository arrives. */
function bareCandidate(worktreePath: string): RepositoryCandidate {
  return { worktreePath, gitIsFile: false, source: 'settings' };
}

function at(...segments: string[]): string {
  return normalizePath(path.join(root, ...segments));
}

before(async () => {
  // `os.tmpdir()` rather than a path fixed on the machine this was written on:
  // the suite runs in CI and on whatever machine clones the repository, and a
  // hard-coded directory would make the tests a fact about one disk. `realpath`
  // because macOS hands out `/var/...` for a directory git will report back as
  // `/private/var/...`, which would fail every path comparison below.
  root = normalizePath(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'multirepo-ledger-'))));

  // The fixtures git will not make on request: a pointer to a directory that is
  // gone, a `.git` file that is not one, an empty `.git` directory, and a
  // directory that is not a repository at all. None of them needs git, so they
  // are built before the guard below and their tests run everywhere.
  await fs.mkdir(at('dangling'), { recursive: true });
  await fs.writeFile(
    path.join(at('dangling'), '.git'),
    'gitdir: ../plain/.git/worktrees/removed\n',
    'utf8',
  );
  await fs.mkdir(at('dangling-shapeless'), { recursive: true });
  await fs.writeFile(path.join(at('dangling-shapeless'), '.git'), 'gitdir: ../nowhere\n', 'utf8');
  await fs.mkdir(at('garbage'), { recursive: true });
  await fs.writeFile(path.join(at('garbage'), '.git'), 'this is not a git file\n', 'utf8');
  await fs.mkdir(at('empty-gitdir', '.git'), { recursive: true });
  await fs.mkdir(at('not-a-repository'), { recursive: true });

  if (gitMissing) {
    return;
  }

  // The suite must not depend on - or be affected by - the config of whoever is
  // running it. Both config files are pointed at the temporary tree, so an
  // absent `user.email` or an unusual `init.defaultBranch` cannot change what
  // these fixtures look like. `protocol.file.allow` is needed because git 2.38
  // refuses `file://` for submodules by default, and a network clone is out of
  // the question in a unit test.
  const configPath = path.join(root, 'gitconfig');
  await fs.writeFile(
    configPath,
    '[user]\n\tname = Multirepo Ledger Test\n\temail = test@example.invalid\n' +
      '[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n',
    'utf8',
  );
  await fs.writeFile(path.join(root, 'gitconfig-system'), '', 'utf8');
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: path.join(root, 'gitconfig-system'),
    GIT_TERMINAL_PROMPT: '0',
  };

  // A plain repository with one commit, which everything else is built from.
  await fs.mkdir(at('plain'), { recursive: true });
  git(at('plain'), 'init', '-q');
  await fs.writeFile(path.join(at('plain'), 'a.txt'), 'hello\n', 'utf8');
  git(at('plain'), 'add', 'a.txt');
  git(at('plain'), 'commit', '-q', '-m', 'first commit');

  git(at('plain'), 'worktree', 'add', '-q', at('linked'), '-b', 'side');
  git(root, 'init', '-q', '--bare', 'bare.git');
  git(root, 'clone', '-q', '--depth', '1', `file://${at('plain').split(path.sep).join('/')}`, 'shallow');
  git(at('shallow'), 'worktree', 'add', '-q', at('shallow-linked'), '--detach', 'HEAD');

  await fs.mkdir(at('host'), { recursive: true });
  git(at('host'), 'init', '-q');
  await fs.writeFile(path.join(at('host'), 'r.txt'), 'root\n', 'utf8');
  git(at('host'), 'add', 'r.txt');
  git(at('host'), 'commit', '-q', '-m', 'host');
  git(at('host'), 'submodule', 'add', '-q', at('plain'), 'sub');
  git(at('host'), 'commit', '-q', '-m', 'add submodule');
  git(at('host', 'sub'), 'worktree', 'add', '-q', at('submodule-linked'), '-b', 'subside');

  // A hand-written `.git` file with a relative pointer at a git directory that
  // is real, which is what `git init --separate-git-dir` writes. It needs the
  // repository above to exist, so it is built here rather than with the others.
  await fs.mkdir(at('relative'), { recursive: true });
  await fs.writeFile(path.join(at('relative'), '.git'), 'gitdir: ../plain/.git\n', 'utf8');
});

after(async () => {
  if (root === '') {
    return;
  }
  try {
    // git leaves object files read-only, which Windows will refuse to unlink on
    // the first attempt. A temporary directory left behind is not a test
    // failure, so a cleanup that loses is swallowed rather than reported.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Nothing to do about it, and nothing worth failing the suite over.
  }
});

// ---------------------------------------------------------------------------
// Kinds, read off repositories git actually built
// ---------------------------------------------------------------------------

test('a repository with a .git directory is plain, and that directory is its git dir', { skip }, async () => {
  const repository = await classifyRepository(dirCandidate(at('plain')));
  assert.equal(repository.kind, 'plain');
  assert.equal(repository.gitDir, at('plain', '.git'));
  assert.equal(repository.shallow, false);
  assert.equal(repository.problem, undefined);
});

test('a linked worktree is a worktree, resolved to the admin dir inside its repository', { skip }, async () => {
  const repository = await classifyRepository(fileCandidate(at('linked')));
  assert.equal(repository.kind, 'worktree');
  assert.equal(repository.gitDir, at('plain', '.git', 'worktrees', 'linked'));
  assert.equal(repository.problem, undefined);
});

test('a submodule is a submodule, and its gitdir: was relative', { skip }, async () => {
  // The relative pointer is the fact under test as much as the kind is: git
  // writes `gitdir: ../.git/modules/sub` here, so resolving against anything
  // but the directory holding the `.git` file lands somewhere else entirely.
  const raw = await fs.readFile(path.join(at('host', 'sub'), '.git'), 'utf8');
  assert.ok(!path.isAbsolute(parseGitFile(raw) ?? ''), `expected a relative gitdir, got ${raw}`);

  const repository = await classifyRepository(fileCandidate(at('host', 'sub')));
  assert.equal(repository.kind, 'submodule');
  assert.equal(repository.gitDir, at('host', '.git', 'modules', 'sub'));
  assert.equal(repository.problem, undefined);
});

test('a worktree of a submodule is a worktree, not a submodule', { skip }, async () => {
  // Its git directory is `<host>/.git/modules/sub/worktrees/<name>`, so both
  // marker segments are in the path and only the innermost one is true.
  const repository = await classifyRepository(fileCandidate(at('submodule-linked')));
  assert.equal(repository.kind, 'worktree');
  assert.equal(repository.gitDir, at('host', '.git', 'modules', 'sub', 'worktrees', 'submodule-linked'));
});

test('a bare repository is bare, and is its own git directory', { skip }, async () => {
  const repository = await classifyRepository(bareCandidate(at('bare.git')));
  assert.equal(repository.kind, 'bare');
  assert.equal(repository.gitDir, at('bare.git'));
  assert.equal(repository.path, at('bare.git'));
  assert.equal(repository.problem, undefined);
});

// ---------------------------------------------------------------------------
// Shallowness, which is not a kind
// ---------------------------------------------------------------------------

test('a shallow clone is a plain repository that reports a truncated history', { skip }, async () => {
  const repository = await classifyRepository(dirCandidate(at('shallow')));
  assert.equal(repository.kind, 'plain');
  assert.equal(repository.shallow, true);
});

test('a linked worktree of a shallow clone is shallow too, via the common directory', { skip }, async () => {
  // The case that makes `commondir` load-bearing: the `shallow` marker is in
  // the clone's git directory, not in the worktree's, so reading the worktree's
  // own directory would report a complete history for a truncated one.
  assert.equal(
    await exists(path.join(at('shallow', '.git', 'worktrees', 'shallow-linked'), 'shallow')),
    false,
    'the fixture is wrong: the marker is supposed to be absent from the per-worktree dir',
  );

  const repository = await classifyRepository(fileCandidate(at('shallow-linked')));
  assert.equal(repository.kind, 'worktree');
  assert.equal(repository.shallow, true);
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// What cannot be classified says so, and never says "plain"
// ---------------------------------------------------------------------------

test('a .git file whose target is gone keeps the kind its path proves and reports the problem', async () => {
  const repository = await classifyRepository(fileCandidate(at('dangling')));
  assert.equal(repository.kind, 'worktree');
  assert.notEqual(repository.problem, undefined);
  assert.match(repository.problem ?? '', /is not there/);
  // The path it could not reach is in the message, because that is the only
  // thing that tells the reader whether the repository moved or was deleted.
  assert.ok((repository.problem ?? '').includes('removed'));
});

test('a .git file pointing nowhere, with nothing in the path to go on, is unknown', async () => {
  const repository = await classifyRepository(fileCandidate(at('dangling-shapeless')));
  assert.equal(repository.kind, 'unknown');
  assert.notEqual(repository.problem, undefined);
});

test('a .git file that is not one is unknown, never plain', async () => {
  const repository = await classifyRepository(fileCandidate(at('garbage')));
  assert.equal(repository.kind, 'unknown');
  assert.match(repository.problem ?? '', /gitdir: /);
});

test('a .git directory with no HEAD is unknown, never plain', async () => {
  const repository = await classifyRepository(dirCandidate(at('empty-gitdir')));
  assert.equal(repository.kind, 'unknown');
  assert.match(repository.problem ?? '', /HEAD/);
});

test('a directory that is neither a repository nor holds one is unknown', async () => {
  const repository = await classifyRepository(bareCandidate(at('not-a-repository')));
  assert.equal(repository.kind, 'unknown');
  assert.notEqual(repository.problem, undefined);
});

// ---------------------------------------------------------------------------
// A relative gitdir: that resolves
// ---------------------------------------------------------------------------

test('a relative gitdir: is resolved against the directory holding the .git file', { skip }, async () => {
  // `../plain/.git` is a complete git directory with neither `commondir` nor a
  // `worktrees`/`modules` segment, which is what `--separate-git-dir` produces:
  // a plain repository whose administrative files live elsewhere.
  const repository = await classifyRepository(fileCandidate(at('relative')));
  assert.equal(repository.gitDir, at('plain', '.git'));
  assert.equal(repository.kind, 'plain');
  assert.equal(repository.problem, undefined);
});

// ---------------------------------------------------------------------------
// parseGitFile - the one-line format, without a filesystem
// ---------------------------------------------------------------------------

test('parseGitFile reads the path after the prefix and drops the newline', () => {
  assert.equal(parseGitFile('gitdir: ../.git/modules/sub\n'), '../.git/modules/sub');
});

test('parseGitFile survives a CRLF file, because git on Windows writes one', () => {
  assert.equal(parseGitFile('gitdir: C:/repos/a/.git/worktrees/b\r\n'), 'C:/repos/a/.git/worktrees/b');
});

test('parseGitFile rejects anything without the prefix', () => {
  assert.equal(parseGitFile('ref: refs/heads/main\n'), undefined);
  assert.equal(parseGitFile('gitdir:../no-space\n'), undefined);
  assert.equal(parseGitFile(''), undefined);
});

test('parseGitFile rejects a prefix with no path after it', () => {
  assert.equal(parseGitFile('gitdir: \n'), undefined);
});

test('parseGitFile keeps a leading space, which is a legal first character of a directory name', () => {
  // Trimming the start would point the read at a sibling directory rather than
  // at the one named, and the row would fail for a reason nothing could explain.
  assert.equal(parseGitFile('gitdir:  odd/.git\n'), ' odd/.git');
});

// ---------------------------------------------------------------------------
// kindFromGitDirPath - the path shape, without a filesystem
// ---------------------------------------------------------------------------

test('kindFromGitDirPath reads both separators, because a .git file may hold either', () => {
  assert.equal(kindFromGitDirPath('C:\\repos\\a\\.git\\worktrees\\b'), 'worktree');
  assert.equal(kindFromGitDirPath('C:/repos/a/.git/worktrees/b'), 'worktree');
  assert.equal(kindFromGitDirPath('/home/u/a/.git/modules/lib'), 'submodule');
});

test('kindFromGitDirPath lets the innermost marker win', () => {
  assert.equal(kindFromGitDirPath('/h/a/.git/modules/sub/worktrees/wt'), 'worktree');
  assert.equal(kindFromGitDirPath('/h/a/.git/worktrees/wt/modules/sub'), 'submodule');
});

test('kindFromGitDirPath says nothing about an ordinary git directory', () => {
  assert.equal(kindFromGitDirPath('/home/u/project/.git'), undefined);
});

test('kindFromGitDirPath compares whole segments, so a similar name is not a match', () => {
  assert.equal(kindFromGitDirPath('/home/u/modules-old/project/.git'), undefined);
  assert.equal(kindFromGitDirPath('/home/u/my-worktrees/project/.git'), undefined);
});

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

const windows = process.platform === 'win32';

function absolute(...segments: string[]): string {
  return windows ? path.join('C:\\', ...segments) : path.join('/', ...segments);
}

test('a repository inside a workspace folder is labelled by its path within it', () => {
  assert.equal(
    labelFor(absolute('work', 'services', 'billing'), absolute('work')),
    'services/billing',
  );
});

test('a nested label uses forward slashes on every platform', () => {
  const label = labelFor(absolute('work', 'a', 'b'), absolute('work'));
  assert.equal(label, 'a/b');
  assert.ok(!label.includes('\\'));
});

test('a repository at the top of its workspace folder is labelled with the folder name', () => {
  assert.equal(labelFor(absolute('work', 'project'), absolute('work', 'project')), 'project');
});

test('a repository with no workspace folder is labelled with its own directory name', () => {
  assert.equal(labelFor(absolute('elsewhere', 'ledger'), undefined), 'ledger');
});

test('a repository outside the folder it was given is labelled by its own name, not by ..', () => {
  // A label of `../../elsewhere/ledger` would be a path to somewhere the reader
  // cannot see from, and says less than the repository's own name.
  assert.equal(labelFor(absolute('elsewhere', 'ledger'), absolute('work')), 'ledger');
});

test('a sibling whose name starts with the folder name is not treated as inside it', () => {
  assert.equal(labelFor(absolute('work-old', 'ledger'), absolute('work')), 'ledger');
});

test('a repository at a filesystem root keeps a label rather than an empty string', () => {
  const root = windows ? 'C:\\' : '/';
  assert.equal(labelFor(root, undefined), normalizePath(root));
});
