/**
 * Repository discovery through the editor's own file index (design.md D4).
 *
 * `vscode.workspace.findFiles` runs against an index the editor already
 * maintains, in another process, and honours cancellation natively, so it
 * answers for the open folders sooner than a walk of the same directories can.
 * It is only ever half the answer: it returns nothing when no folder is open -
 * which for this extension is an ordinary window rather than an edge case - it
 * cannot see `multirepoLedger.additionalRoots`, and it is structurally blind to a
 * bare repository, which has no `.git` at any path. `search.ts` covers the rest
 * and is the authority; this is the accelerator, and losing it costs only the
 * first paint.
 *
 * This is the one file in `discovery/` that imports `vscode`, so everything
 * downstream of it - the merge, the exclusions, the classification and every
 * test over them - stays runnable without an extension host (design.md D2).
 *
 * Nothing here spawns a process, and nothing here writes.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { pathKey } from '../model/keys.ts';
import { log } from '../util/log.ts';
import type { RepositoryCandidate } from './search.ts';

/**
 * Ordinary repositories, whose `.git` is a directory.
 *
 * The segment immediately before `HEAD` must be `.git`, so this pattern returns
 * one hit per ordinary repository and cannot match `.git/worktrees/<name>/HEAD`
 * or `.git/modules/<name>/HEAD` - which is what keeps a repository's own
 * internals from being reported as further repositories (design.md D6).
 */
const GIT_DIRECTORY_GLOB = '**/.git/HEAD';

/**
 * The three shapes in which `.git` is a *file*: a linked worktree, a submodule
 * working directory, and a repository created with `--separate-git-dir`.
 *
 * `findFiles` returns files and never directories, so this pattern can never
 * return an ordinary repository's `.git` directory and the two passes do not
 * overlap.
 */
const GIT_FILE_GLOB = '**/.git';

/**
 * Paths one pass will accept before it stops.
 *
 * A guard against paging an unbounded path list into the extension host, not a
 * limit on how many repositories the board shows: the walk covers the same
 * directories and is bounded separately. It is not derived from any
 * measurement - it is a ceiling far above any layout of repositories, chosen so
 * that reaching it means something is wrong rather than something is large.
 * Reaching it is logged with the count, because a search that silently stops at
 * a cap is a search that lies about being complete.
 */
const MAX_RESULTS_PER_PASS = 20_000;

/**
 * The index search, as `repositories.ts` takes it: one function, injected, so
 * that the assembly around it has no `vscode` import and can be unit-tested.
 */
export function createWorkspaceSearcher(): (signal?: AbortSignal) => Promise<RepositoryCandidate[]> {
  return (signal) => searchWorkspace(signal);
}

async function searchWorkspace(signal?: AbortSignal): Promise<RepositoryCandidate[]> {
  const source = new vscode.CancellationTokenSource();
  const onAbort = (): void => source.cancel();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) {
    source.cancel();
  }

  const found = new Map<string, RepositoryCandidate>();
  try {
    for (const uri of await findFiles(GIT_DIRECTORY_GLOB, source.token)) {
      // `<repo>/.git/HEAD` -> the git directory, then the working tree that
      // holds it. The working tree is the identity a row is keyed by and the
      // directory every later git command is spawned in, so the hit is mapped
      // back to it here rather than anywhere downstream.
      const gitPath = path.dirname(uri.fsPath);
      const worktreePath = path.dirname(gitPath);
      found.set(pathKey(worktreePath), { worktreePath, gitPath, gitIsFile: false });
    }

    for (const uri of await findFiles(GIT_FILE_GLOB, source.token)) {
      const gitPath = uri.fsPath;
      const worktreePath = path.dirname(gitPath);
      const key = pathKey(worktreePath);
      // A `.git` cannot be a directory and a file at once, so the two passes
      // cannot honestly disagree about one working tree. The check is here for
      // the case where they do anyway - a `.git` that is a link, which one pass
      // may follow and the other may not - and the first pass wins because it
      // saw a `HEAD` file inside the entry rather than only the entry's name.
      if (key.length > 0 && !found.has(key)) {
        found.set(key, { worktreePath, gitPath, gitIsFile: true });
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    source.dispose();
  }

  return [...found.values()];
}

/**
 * One pass.
 *
 * `null` is passed for the exclude argument, and it is the only value that
 * works. `findFiles` documents the parameter as: when `undefined`, the default
 * file excludes apply; when `null`, no excludes apply. VS Code's default
 * `files.exclude` carries an entry that hides every `.git` in the workspace, so
 * omitting the argument - and equally, merging `files.exclude` and
 * `search.exclude` into one glob the way the sibling project's
 * `vscodeSearch.ts` carefully does - makes both patterns above match nothing,
 * always, and say nothing about it. The board would ship confidently empty,
 * with no error anywhere (design.md D5).
 *
 * Rejected: merging the two settings and dropping the patterns that would hide
 * a `.git`. A user-authored glob can hide it without naming it - anything that
 * matches every dot-directory does - so deciding whether an arbitrary pattern
 * excludes a given path is not a one-line test, and getting it wrong
 * reintroduces exactly that silent-empty failure.
 *
 * The cost is that the search reaches into directories the user has hidden.
 * That is paid back on the results rather than in the query: `repositories.ts`
 * applies the walk's own directory-name list to everything this returns, and
 * `multirepoLedger.exclude` removes a named repository from the board entirely.
 */
async function findFiles(
  include: string,
  token: vscode.CancellationToken,
): Promise<readonly vscode.Uri[]> {
  try {
    const found = await vscode.workspace.findFiles(include, null, MAX_RESULTS_PER_PASS, token);
    if (found.length >= MAX_RESULTS_PER_PASS) {
      log.warn(
        `The search for ${include} in the open folders stopped at ${found.length} results, so repositories beneath them may be missing from the list`,
      );
    }
    return found;
  } catch (error) {
    // A failed pass yields no repositories from the index. The other pass and
    // the filesystem walk still stand, and the walk covers the same folders, so
    // this narrows the answer rather than emptying it.
    log.error(`Searching the open folders for ${include} failed`, error);
    return [];
  }
}
