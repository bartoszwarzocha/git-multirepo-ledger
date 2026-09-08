import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { normalizePath } from '../model/keys.ts';
import type { DiscoveredRepository } from '../model/types.ts';
import {
  discoverRepositories,
  resolveConfiguredPath,
  type DiscoveryInput,
} from './repositories.ts';
import type { RepositoryCandidate } from './search.ts';

/*
 * The fixtures below are directory trees rather than mocks, because everything
 * this module decides is decided from paths on disk: whether one candidate is
 * inside another, which open folder holds a repository, whether a configured
 * root exists. A mocked filesystem would let those tests pass while the
 * separator handling, the case folding and the ancestor test that do the actual
 * work went untested.
 *
 * No git process is spawned by any test here, because no git process is spawned
 * by the module: discovery is filesystem work end to end (design.md D8).
 */

async function withFixture(run: (base: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-repos-'));
  // The temporary directory is reached through a link on some platforms, and
  // the walk resolves the roots it is given, so the fixture is resolved once
  // here and every expected path is built from the resolved form.
  const base = await fs.realpath(dir);
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

/** An ordinary repository: `.git` is a directory holding a `HEAD`. */
async function makeRepo(base: string, relative: string): Promise<string> {
  const worktree = path.join(base, relative);
  const gitDir = path.join(worktree, '.git');
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(gitDir, 'config'), '[core]\n\tbare = false\n');
  await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
  await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'a working tree file\n');
  return worktree;
}

/** `git init --bare`: the layout with no `.git` and no working tree. */
async function makeBareRepo(base: string, relative: string): Promise<string> {
  const repo = path.join(base, relative);
  await writeFile(path.join(repo, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, 'config'), '[core]\n\tbare = true\n');
  await fs.mkdir(path.join(repo, 'objects', 'ab'), { recursive: true });
  await fs.mkdir(path.join(repo, 'refs', 'heads'), { recursive: true });
  return repo;
}

/**
 * The editor's index, standing in for `vscodeSearch.ts`.
 *
 * It returns exactly what that module returns - a candidate per working tree,
 * mapped back from the `.git` entry the glob matched - so a test can put a
 * candidate in front of the merge that the walk would never propose, which is
 * the whole reason the two sources have to be reconciled at all.
 */
function fakeIndex(...worktrees: readonly string[]) {
  return async (): Promise<RepositoryCandidate[]> =>
    worktrees.map((worktreePath) => ({
      worktreePath,
      gitPath: path.join(worktreePath, '.git'),
      gitIsFile: false,
    }));
}

function paths(found: readonly DiscoveredRepository[]): string[] {
  return found.map((repository) => repository.path);
}

function labels(found: readonly DiscoveredRepository[]): string[] {
  return found.map((repository) => repository.label);
}

async function discover(input: DiscoveryInput): Promise<DiscoveredRepository[]> {
  return discoverRepositories(input);
}

// ---------------------------------------------------------------------------
// The two sources, and what each of them contributes
// ---------------------------------------------------------------------------

test('an additional root outside every workspace folder is included', async () => {
  await withFixture(async (workspace) => {
    await withFixture(async (elsewhere) => {
      const inside = await makeRepo(workspace, 'admin-ui');
      const outside = await makeRepo(elsewhere, 'data-service');

      const found = await discover({
        workspaceFolders: [workspace],
        additionalRoots: [elsewhere],
      });

      assert.deepEqual(paths(found).sort(), [inside, outside].sort());
      const settings = found.find((repository) => repository.path === outside);
      assert.equal(settings?.source, 'settings');
      assert.equal(settings?.workspaceFolder, undefined);
      assert.equal(settings?.label, 'data-service');
    });
  });
});

test('a repository beneath an open folder is found without the editor index', async () => {
  // The walk covers the open folders as well as the configured roots, so a
  // window whose index search fails, or a test with no extension host, still
  // gets the same list rather than an empty one.
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'service-api');

    const found = await discover({ workspaceFolders: [base], additionalRoots: [] });

    assert.deepEqual(paths(found), [worktree]);
    assert.equal(found[0]?.source, 'workspace');
    assert.equal(found[0]?.workspaceFolder, base);
  });
});

test('a bare repository is invisible to the index and is still labelled by its folder', async () => {
  await withFixture(async (base) => {
    const bare = await makeBareRepo(base, path.join('mirrors', 'app.git'));

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: fakeIndex(),
    });

    assert.deepEqual(paths(found), [bare]);
    assert.equal(found[0]?.kind, 'bare');
    // Decided from containment rather than from which search produced the
    // candidate: only the walk can see this one, and it is still in the folder.
    assert.equal(found[0]?.source, 'workspace');
    assert.equal(found[0]?.label, 'mirrors/app.git');
  });
});

test('a repository both sources found appears once', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'shared');

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [base],
      searchWorkspace: fakeIndex(worktree),
    });

    assert.deepEqual(paths(found), [worktree]);
  });
});

test('a candidate the index spelled differently is still the same repository', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'shared');
    // A trailing separator and forward slashes are how the same directory
    // arrives from three different places; comparing the raw strings would
    // show one repository as two rows.
    const respelled = `${worktree.split(path.sep).join('/')}/`;

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: fakeIndex(respelled),
    });

    assert.deepEqual(paths(found), [worktree]);
  });
});

test('an index hit inside an excluded directory name is dropped', async () => {
  await withFixture(async (base) => {
    const real = await makeRepo(base, 'app');
    const vendored = await makeRepo(base, path.join('node_modules', 'some-package'));

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      // The index query carries no excludes, so it genuinely returns this.
      searchWorkspace: fakeIndex(real, vendored),
    });

    assert.deepEqual(paths(found), [real]);
  });
});

test('a repository under a root the user named is kept even when the name is on the list', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, path.join('build', 'staged'));

    const found = await discover({
      workspaceFolders: [],
      additionalRoots: [path.join(base, 'build')],
    });

    assert.deepEqual(paths(found), [worktree]);
  });
});

// ---------------------------------------------------------------------------
// A repository inside another repository
// ---------------------------------------------------------------------------

test('a candidate inside a known working tree gets no row, whoever found it', async () => {
  await withFixture(async (base) => {
    const outer = await makeRepo(base, 'outer');
    // What an initialised submodule and a vendored clone both look like to the
    // index's second pass. The walk stops at `outer` and never proposes them.
    const submodule = await makeRepo(outer, 'sub');
    const vendored = await makeRepo(outer, path.join('vendor', 'other-project'));

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: fakeIndex(outer, submodule, vendored),
    });

    assert.deepEqual(paths(found), [outer]);
  });
});

test('naming the inner repository, or its parent, is what gives it a row', async () => {
  await withFixture(async (base) => {
    const outer = await makeRepo(base, 'outer');
    const inner = await makeRepo(outer, path.join('vendor', 'other-project'));

    const named = await discover({
      workspaceFolders: [base],
      additionalRoots: [inner],
      searchWorkspace: fakeIndex(outer, inner),
    });
    const parentNamed = await discover({
      workspaceFolders: [base],
      additionalRoots: [path.join(outer, 'vendor')],
      searchWorkspace: fakeIndex(outer, inner),
    });

    assert.deepEqual(paths(named).sort(), [inner, outer].sort());
    assert.deepEqual(paths(parentNamed).sort(), [inner, outer].sort());
  });
});

test('naming the enclosing repository does not resurrect what is inside it', async () => {
  await withFixture(async (base) => {
    const outer = await makeRepo(base, 'outer');
    const inner = await makeRepo(outer, 'sub');

    const found = await discover({
      workspaceFolders: [],
      additionalRoots: [outer],
      searchWorkspace: fakeIndex(outer, inner),
    });

    assert.deepEqual(paths(found), [outer]);
  });
});

// ---------------------------------------------------------------------------
// multirepoLedger.exclude
// ---------------------------------------------------------------------------

test('an excluded repository is absent', async () => {
  await withFixture(async (base) => {
    const kept = await makeRepo(base, 'kept');
    const dropped = await makeRepo(base, 'dropped');

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      exclude: [dropped],
      searchWorkspace: fakeIndex(kept, dropped),
    });

    assert.deepEqual(paths(found), [kept]);
  });
});

test('excluding a directory excludes the repositories beneath it', async () => {
  await withFixture(async (base) => {
    const kept = await makeRepo(base, 'app');
    await makeRepo(base, path.join('mirrors', 'one'));
    await makeRepo(base, path.join('mirrors', 'two'));

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      exclude: [path.join(base, 'mirrors')],
    });

    assert.deepEqual(paths(found), [kept]);
  });
});

test('an exclusion that names nothing on disk is not reported as a missing root', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'app');
    const reported: string[] = [];

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      exclude: [path.join(base, 'deleted-last-week'), '   '],
      onMissingRoot: (target) => reported.push(target),
    });

    assert.deepEqual(paths(found), [worktree]);
    assert.deepEqual(reported, []);
  });
});

// ---------------------------------------------------------------------------
// Configured paths that are not there, and paths that need resolving
// ---------------------------------------------------------------------------

test('a configured path that does not exist is reported once and stops nothing', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'app');
    const missing = path.join(base, 'nowhere');
    const reported: string[] = [];

    const found = await discover({
      workspaceFolders: [],
      // The same directory twice, spelled two ways, plus one that is there.
      additionalRoots: [missing, `${missing}${path.sep}`, base],
      onMissingRoot: (target) => reported.push(target),
    });

    assert.deepEqual(reported, [missing]);
    assert.deepEqual(paths(found), [worktree]);
  });
});

test('a configured path that is a file is reported rather than walked', async () => {
  await withFixture(async (base) => {
    const notes = path.join(base, 'notes.md');
    await writeFile(notes, 'text\n');
    const reported: string[] = [];

    const found = await discover({
      workspaceFolders: [],
      additionalRoots: [notes],
      onMissingRoot: (target) => reported.push(target),
    });

    assert.deepEqual(reported, [notes]);
    assert.deepEqual(found, []);
  });
});

test('a tilde is expanded against the home directory', () => {
  assert.equal(
    resolveConfiguredPath('~/code/work', []),
    normalizePath(path.join(os.homedir(), 'code', 'work')),
  );
  assert.equal(resolveConfiguredPath('~', []), normalizePath(os.homedir()));
});

test('a tilde is expanded before the path is looked for on disk', async () => {
  // Reported through the callback rather than asserted against a fixture,
  // because the one thing this must prove is that the expansion happens before
  // the directory is looked for - and proving it by creating a directory would
  // mean writing into the user's home directory to test a string operation.
  const relative = `multirepo-ledger-nothing-here-${process.pid}`;
  const reported: string[] = [];

  const found = await discover({
    workspaceFolders: [],
    additionalRoots: [`~/${relative}`],
    onMissingRoot: (target) => reported.push(target),
  });

  assert.deepEqual(reported, [normalizePath(path.join(os.homedir(), relative))]);
  assert.deepEqual(found, []);
});

test('a relative configured path is read against the first open folder, and needs one', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, path.join('clones', 'app'));

    const withFolder = await discover({
      workspaceFolders: [path.join(base, 'clones')],
      additionalRoots: ['.'],
    });
    const reported: string[] = [];
    const withoutFolder = await discover({
      workspaceFolders: [],
      additionalRoots: ['clones'],
      onMissingRoot: (target) => reported.push(target),
    });

    assert.deepEqual(paths(withFolder), [worktree]);
    assert.deepEqual(withoutFolder, []);
    assert.deepEqual(reported, ['clones']);
  });
});

// ---------------------------------------------------------------------------
// Nothing to scan, and nothing found
// ---------------------------------------------------------------------------

test('no workspace folder and no additional root is an empty list, not a failure', async () => {
  const found = await discover({ workspaceFolders: [], additionalRoots: [] });

  assert.deepEqual(found, []);
});

test('a root holding no repository yields an empty list', async () => {
  await withFixture(async (base) => {
    await fs.mkdir(path.join(base, 'just-a-directory'), { recursive: true });

    assert.deepEqual(await discover({ workspaceFolders: [base], additionalRoots: [] }), []);
  });
});

test('an index search that throws does not empty the list', async () => {
  await withFixture(async (base) => {
    const worktree = await makeRepo(base, 'app');

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: () => Promise.reject(new Error('the index is not answering')),
    });

    assert.deepEqual(paths(found), [worktree]);
  });
});

test('an already aborted pass returns nothing rather than a partial list', async () => {
  await withFixture(async (base) => {
    await makeRepo(base, 'app');
    const controller = new AbortController();
    controller.abort();

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      signal: controller.signal,
    });

    assert.deepEqual(found, []);
  });
});

// ---------------------------------------------------------------------------
// Order and labels
// ---------------------------------------------------------------------------

test('the list comes back in a stable order that does not depend on the source', async () => {
  await withFixture(async (base) => {
    const zebra = await makeRepo(base, 'zebra');
    const alpha = await makeRepo(base, path.join('team-a', 'alpha'));
    const mango = await makeRepo(base, 'mango');

    const found = await discover({
      workspaceFolders: [base],
      additionalRoots: [],
      searchWorkspace: fakeIndex(zebra, mango, alpha),
    });

    assert.deepEqual(labels(found), ['mango', 'team-a/alpha', 'zebra']);
    assert.deepEqual(paths(found), [mango, alpha, zebra]);
  });
});

test('the deeper of two overlapping workspace folders decides the label', async () => {
  await withFixture(async (base) => {
    const inner = path.join(base, 'team-a');
    const worktree = await makeRepo(inner, 'api');

    const found = await discover({
      workspaceFolders: [base, inner],
      additionalRoots: [],
    });

    assert.deepEqual(paths(found), [worktree]);
    assert.deepEqual(labels(found), ['api']);
    assert.equal(found[0]?.workspaceFolder, inner);
  });
});
