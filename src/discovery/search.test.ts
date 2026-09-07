import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { setLogSink } from '../util/log.ts';
import { DEFAULT_EXCLUDED_DIRS, searchFilesystem, type RepositoryCandidate } from './search.ts';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-search-'));
  // The temp directory is reached through a symlink on some platforms, and the
  // walk resolves the roots it is given.
  return fs.realpath(dir);
}

async function withFixture(run: (base: string) => Promise<void>): Promise<void> {
  const base = await makeFixture();
  try {
    await run(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function writeFile(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

/**
 * An ordinary repository, whose `.git` directory carries the same four entries
 * a bare repository does. That is not decoration: it is the canary for the walk
 * ever descending into a `.git`, which would report the git directory itself as
 * a second, bare repository.
 */
async function makeRepo(base: string, relative: string): Promise<string> {
  const worktree = path.join(base, relative);
  const gitDir = path.join(worktree, '.git');
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(gitDir, 'config'), '[core]\n\tbare = false\n');
  await fs.mkdir(path.join(gitDir, 'objects', 'pack'), { recursive: true });
  await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'a working tree file\n');
  return worktree;
}

/** A linked worktree or a submodule: `.git` is a file holding a `gitdir:` line. */
async function makeGitFileRepo(base: string, relative: string, target: string): Promise<string> {
  const worktree = path.join(base, relative);
  await writeFile(path.join(worktree, '.git'), `gitdir: ${target}\n`);
  return worktree;
}

/** `git init --bare`: the repository layout with no `.git` and no working tree. */
async function makeBareRepo(base: string, relative: string): Promise<string> {
  const repo = path.join(base, relative);
  await writeFile(path.join(repo, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, 'config'), '[core]\n\tbare = true\n');
  // The 256-way fan-out is the reason a bare repository has to end the walk:
  // entering it would read a directory per prefix to learn nothing.
  await fs.mkdir(path.join(repo, 'objects', 'ab'), { recursive: true });
  await fs.mkdir(path.join(repo, 'objects', 'cd'), { recursive: true });
  await fs.mkdir(path.join(repo, 'refs', 'heads'), { recursive: true });
  return repo;
}

/**
 * A directory link, made the way each platform allows without privileges: a
 * junction on Windows, a symbolic link elsewhere. Returns false when the
 * platform refused, so a test can say so rather than fail for the wrong reason.
 */
async function linkDirectory(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a directory link without going through it.
 *
 * Done explicitly rather than left to the fixture's `fs.rm`, because one of
 * these links points at its own ancestor: a recursive delete that followed it
 * instead of unlinking it would either loop or take the fixture's parent with
 * it, and neither belongs in a test suite.
 */
async function removeLink(linkPath: string): Promise<void> {
  try {
    await fs.unlink(linkPath);
  } catch {
    try {
      await fs.rmdir(linkPath);
    } catch {
      // Never created, or already gone.
    }
  }
}

function worktrees(found: readonly RepositoryCandidate[]): string[] {
  return found.map((candidate) => candidate.worktreePath);
}

async function collectWarnings(run: () => Promise<void>): Promise<string[]> {
  // Lines logged while no sink was attached are queued and replayed into the
  // next one, so an earlier test's stop would otherwise arrive in this test's
  // list. Draining into a sink that discards them is what keeps each assertion
  // about the walk it actually ran.
  setLogSink(() => {});
  const lines: string[] = [];
  setLogSink((level, line) => {
    if (level === 'warn') {
      lines.push(line);
    }
  });
  try {
    await run();
  } finally {
    setLogSink(undefined);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Finding repositories
// ---------------------------------------------------------------------------

test('three repositories in a flat directory are all found', async () => {
  await withFixture(async (base) => {
    const expected = [
      await makeRepo(base, 'admin-ui'),
      await makeRepo(base, 'data-service'),
      await makeRepo(base, 'indexer'),
    ];

    const found = await searchFilesystem([base]);

    assert.deepEqual(worktrees(found), expected);
    assert.ok(found.every((candidate) => !candidate.gitIsFile));
  });
});

test('the candidate is the working tree, not the .git directory', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'service-api');

    const found = await searchFilesystem([base]);

    assert.deepEqual(found, [
      { worktreePath: worktree, gitPath: path.join(worktree, '.git'), gitIsFile: false },
    ]);
  });
});

test('a repository nested four levels deep is found', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, path.join('work', 'team-a', 'services', 'api'));

    assert.deepEqual(worktrees(await searchFilesystem([base])), [worktree]);
  });
});

test('a root that is itself a repository yields that root and nothing below it', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'solo');
    await makeRepo(worktree, path.join('vendor', 'other-project'));

    assert.deepEqual(worktrees(await searchFilesystem([worktree])), [worktree]);
  });
});

// ---------------------------------------------------------------------------
// A repository is a leaf
// ---------------------------------------------------------------------------

test('a repository inside a repository is not returned, because the outer .git ends the walk', async () => {
  await withFixture(async (base) => {
    const outer = await makeRepo(base, 'outer');
    await makeRepo(outer, path.join('vendor', 'other-project'));
    await makeRepo(outer, path.join('node_modules', 'some-package'));

    assert.deepEqual(worktrees(await searchFilesystem([base])), [outer]);
  });
});

test('naming the inner repository is what makes it appear', async () => {
  await withFixture(async (base) => {
    const outer = await makeRepo(base, 'outer');
    const inner = await makeRepo(outer, path.join('vendor', 'other-project'));

    const found = await searchFilesystem([base, path.join(outer, 'vendor')]);

    assert.deepEqual(worktrees(found).sort(), [inner, outer].sort());
  });
});

test('the git directory is never entered, so its internals are never repositories', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'repo');
    // What git itself puts inside a git directory. Both have the layout the
    // walk reads as a repository, so only pruning at `.git` keeps them out.
    await makeRepo(path.join(worktree, '.git', 'modules'), 'sub');
    await writeFile(path.join(worktree, '.git', 'worktrees', 'wt-feature', 'HEAD'), 'ref: x\n');

    assert.deepEqual(worktrees(await searchFilesystem([base])), [worktree]);
  });
});

// ---------------------------------------------------------------------------
// The shapes `.git` takes
// ---------------------------------------------------------------------------

test('a .git file is a repository, and is reported as a file', async () => {
  await withFixture(async (base) => {
    const main = await makeRepo(base, 'main');
    const worktree = await makeGitFileRepo(
      base,
      'wt-feature',
      path.join(main, '.git', 'worktrees', 'wt-feature'),
    );

    const found = await searchFilesystem([base]);

    assert.deepEqual(found, [
      { worktreePath: main, gitPath: path.join(main, '.git'), gitIsFile: false },
      { worktreePath: worktree, gitPath: path.join(worktree, '.git'), gitIsFile: true },
    ]);
  });
});

test('a .git that is a link to a directory is not reported as a file', async () => {
  await withFixture(async (base) => {
    const gitDir = path.join(base, 'store', 'repo.git');
    await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    const worktree = path.join(base, 'tree');
    await fs.mkdir(worktree, { recursive: true });
    const link = path.join(worktree, '.git');
    if (!(await linkDirectory(gitDir, link))) {
      return;
    }
    try {
      const found = await searchFilesystem([worktree]);

      assert.deepEqual(found, [{ worktreePath: worktree, gitPath: link, gitIsFile: false }]);
    } finally {
      await removeLink(link);
    }
  });
});

test('a bare repository is found by its layout and is not walked into', async () => {
  await withFixture(async (base) => {
    const bare = await makeBareRepo(base, 'mirror.git');
    const plain = await makeRepo(base, 'app');

    const found = await searchFilesystem([base]);

    // A missing `gitPath` is how the walk says "bare"; nothing under the object
    // fan-out may appear.
    assert.deepEqual(found, [
      { worktreePath: plain, gitPath: path.join(plain, '.git'), gitIsFile: false },
      { worktreePath: bare, gitIsFile: false },
    ]);
  });
});

test('a directory with only part of the bare layout is not a repository', async () => {
  await withFixture(async (base) => {
    const nearly = path.join(base, 'not-a-repo');
    await writeFile(path.join(nearly, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(path.join(nearly, 'objects'), { recursive: true });
    await fs.mkdir(path.join(nearly, 'refs'), { recursive: true });

    assert.deepEqual(await searchFilesystem([base]), []);
  });
});

// ---------------------------------------------------------------------------
// The exclusion list
// ---------------------------------------------------------------------------

test('.git is not on the exclusion list, because the walk exists to find it', () => {
  assert.ok(!DEFAULT_EXCLUDED_DIRS.some((name) => name.toLowerCase() === '.git'));
});

test('node_modules is never traversed', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, path.join('node_modules', 'some-package'));
    const real = await makeRepo(base, 'app');

    assert.deepEqual(worktrees(await searchFilesystem([base])), [real]);
  });
});

test('every default excluded directory is skipped', async () => {
  await withFixture(async (base) => {
    for (const dir of DEFAULT_EXCLUDED_DIRS) {
      await makeRepo(base, path.join(dir, 'vendored-thing'));
    }

    assert.deepEqual(await searchFilesystem([base]), []);
  });
});

test('excludedDirs replaces the default list rather than extending it', async () => {
  await withFixture(async (base) => {
    const inModules = await makeRepo(base, path.join('node_modules', 'some-package'));
    await makeRepo(base, 'skipme');

    const found = await searchFilesystem([base], { excludedDirs: ['skipme'] });

    assert.deepEqual(worktrees(found), [inModules]);
  });
});

test('a directory the user pointed at is searched even when its name is excluded', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, path.join('build', 'staged'));

    const found = await searchFilesystem([path.join(base, 'build')]);

    assert.deepEqual(worktrees(found), [worktree]);
  });
});

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

test('maxDepth bounds the walk', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, path.join('one', 'two', 'three'));

    assert.deepEqual(await searchFilesystem([base], { maxDepth: 2 }), []);
    assert.equal((await searchFilesystem([base], { maxDepth: 3 })).length, 1);
  });
});

test('the walk logs the depth, the count and the first directory it did not search', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, path.join('one', 'two', 'three'));

    const stopped = await collectWarnings(async () => {
      await searchFilesystem([base], { maxDepth: 1 });
    });
    const finished = await collectWarnings(async () => {
      await searchFilesystem([base], { maxDepth: 32 });
    });

    assert.deepEqual(finished, [], 'a walk that finished should report nothing');
    const depth = stopped.filter((line) => line.includes('stopped at depth 1'));
    assert.equal(depth.length, 1);
    assert.ok(depth[0]?.includes('1 directory unsearched'), depth[0]);
    assert.ok(depth[0]?.includes(path.join(base, 'one', 'two')), depth[0]);
  });
});

test('the directory budget stops the walk and the log says what was left', async () => {
  await withFixture(async (base) => {
    for (const name of ['alpha', 'mango', 'zebra']) {
      await makeRepo(base, name);
    }

    let found: RepositoryCandidate[] = [];
    const stopped = await collectWarnings(async () => {
      // One directory is the root itself, so the walk stops before reading any
      // of the three below it.
      found = await searchFilesystem([base], { maxDirectories: 1 });
    });

    assert.deepEqual(found, []);
    const budget = stopped.filter((line) => line.includes('after reading 1 directory,'));
    assert.equal(budget.length, 1);
    assert.ok(budget[0]?.includes('3 directories unsearched'), budget[0]);
    assert.ok(budget[0]?.includes(path.join(base, 'alpha')), budget[0]);
  });
});

test('a repository found before the budget was reached is still returned', async () => {
  await withFixture(async (base) => {
    const shallow = await makeRepo(base, 'alpha');
    await makeRepo(base, path.join('zebra', 'nested', 'deep'));

    const found = await searchFilesystem([base], { maxDirectories: 4 });

    assert.deepEqual(worktrees(found), [shallow]);
  });
});

test('a link that points at its own ancestor does not make the walk run to its depth bound', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'repo');
    const loop = path.join(base, 'loop');
    if (!(await linkDirectory(base, loop))) {
      return;
    }
    try {
      let found: RepositoryCandidate[] = [];
      const stopped = await collectWarnings(async () => {
        found = await searchFilesystem([base]);
      });

      assert.deepEqual(worktrees(found), [worktree]);
      assert.deepEqual(stopped, [], 'the cycle should end by itself, not at a guard');
    } finally {
      await removeLink(loop);
    }
  });
});

test('a link inside a root is not entered', async () => {
  await withFixture(async (base) => {
    await withFixture(async (elsewhere) => {
      await makeRepo(elsewhere, 'hidden-away');
      const link = path.join(base, 'link');
      if (!(await linkDirectory(elsewhere, link))) {
        return;
      }
      try {
        assert.deepEqual(await searchFilesystem([base]), []);
      } finally {
        await removeLink(link);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Overlap, cancellation and directories that will not open
// ---------------------------------------------------------------------------

test('overlapping start directories report each repository once', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, path.join('outer', 'inner'));

    const found = await searchFilesystem([base, path.join(base, 'outer'), base]);

    assert.deepEqual(worktrees(found), [worktree]);
  });
});

test('an already aborted signal ends the walk without throwing', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, 'app');
    const controller = new AbortController();
    controller.abort();

    assert.deepEqual(await searchFilesystem([base], { signal: controller.signal }), []);
  });
});

test('a start directory that does not exist yields nothing and no error', async () => {
  await withFixture(async (base) => {
    assert.deepEqual(await searchFilesystem([path.join(base, 'nowhere')]), []);
  });
});

test('a file passed as a start directory is ignored', async () => {
  await withFixture(async (base) => {
    const file = path.join(base, 'notes.md');
    await writeFile(file, 'text\n');

    assert.deepEqual(await searchFilesystem([file]), []);
  });
});

test('a directory that will not open does not empty the result', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'app');
    const file = path.join(base, 'notes.md');
    await writeFile(file, 'text\n');

    const found = await searchFilesystem([path.join(base, 'nowhere'), file, base]);

    assert.deepEqual(worktrees(found), [worktree]);
  });
});

test(
  'a directory with no read permission does not empty the result',
  {
    skip:
      process.platform === 'win32'
        ? 'chmod does not remove read access on Windows'
        : process.getuid?.() === 0
          ? 'root reads a directory whatever its mode says'
          : false,
  },
  async () => {
    await withFixture(async (base) => {
      const worktree = await makeRepo(base, 'app');
      const walled = path.join(base, 'walled');
      await makeRepo(walled, 'unreachable');
      await fs.chmod(walled, 0o000);
      try {
        assert.deepEqual(worktrees(await searchFilesystem([base])), [worktree]);
      } finally {
        // Restored so the fixture can be removed.
        await fs.chmod(walled, 0o700);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

test('results are ordered by path so the caller sees a stable list', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, 'zebra');
    await makeRepo(base, 'alpha');
    await makeRepo(base, 'mango');

    const found = await searchFilesystem([base]);

    assert.deepEqual(
      found.map((candidate) => path.basename(candidate.worktreePath)),
      ['alpha', 'mango', 'zebra'],
    );
  });
});
