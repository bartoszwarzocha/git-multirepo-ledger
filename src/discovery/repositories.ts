/**
 * From two searches to the repository list the rest of the extension works
 * from.
 *
 * The editor's index (`vscodeSearch.ts`) and the filesystem walk (`search.ts`)
 * only propose. This module is where the two answers become one list: merged by
 * resolved path, narrowed by the exclusions, classified from the filesystem,
 * and ordered. It is also where the differences between the two sources are
 * reconciled, because a board whose contents depend on which search happened to
 * reach a directory is a board nobody can predict.
 *
 * Nothing here imports `vscode`, which is the whole reason it is a separate
 * file from the search it calls (design.md D2): every judgement below - which
 * candidate is dropped, which repository is labelled as belonging to a
 * workspace folder, what order the list comes back in - is decided here and
 * unit-tested in `repositories.test.ts`, with no extension host.
 *
 * Nothing here spawns a process. Every fact in the returned list was read from
 * a directory entry or a one-line file (design.md D8).
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { isPathInside, normalizePath, pathKey, pathsEqual } from '../model/keys.ts';
import type { DiscoveredRepository, RepositorySource } from '../model/types.ts';
import {
  classifyRepository,
  type RepositoryCandidate as ClassifiableCandidate,
} from '../read/classify.ts';
import { isDirectory } from '../util/fsx.ts';
import { log } from '../util/log.ts';
import { DEFAULT_EXCLUDED_DIRS, searchFilesystem, type RepositoryCandidate } from './search.ts';

/** The index search, injected so that discovery runs without an extension host. */
export type WorkspaceSearch = (signal?: AbortSignal) => Promise<RepositoryCandidate[]>;

export interface DiscoveryInput {
  /** Absolute paths of the open folders. Empty is a normal state, not an error. */
  workspaceFolders: readonly string[];
  /** Raw `multirepoLedger.additionalRoots` value. */
  additionalRoots: readonly string[];
  /** Raw `multirepoLedger.exclude` value. */
  exclude?: readonly string[];
  /** `multirepoLedger.maxDepth`; the walk applies its own default when this is absent. */
  maxDepth?: number;
  /** Omitted means no index search - which is what every test, and every window with no folder open, gets. */
  searchWorkspace?: WorkspaceSearch;
  signal?: AbortSignal;
  /** Called once per configured path that is not a directory on disk. */
  onMissingRoot?: (path: string) => void;
}

/** Names the walk refuses to descend into, folded once rather than per candidate. */
const EXCLUDED_DIRECTORY_NAMES = new Set(DEFAULT_EXCLUDED_DIRS.map((name) => name.toLowerCase()));

export async function discoverRepositories(input: DiscoveryInput): Promise<DiscoveredRepository[]> {
  return log.time('Repository discovery', () => discover(input));
}

async function discover(input: DiscoveryInput): Promise<DiscoveredRepository[]> {
  const folders = input.workspaceFolders.map((folder) => normalizePath(folder));
  const roots = await resolveAdditionalRoots(input, folders);

  // The index reads a database the editor already holds and the walk reads
  // directories, so the two overlap rather than queue: neither waits on the
  // other's resource, and discovery costs the slower of them rather than both.
  const [fromIndex, fromWalk] = await Promise.all([
    runWorkspaceSearch(input),
    runWalk(input, folders, roots),
  ]);

  if (input.signal?.aborted) {
    // A cancelled pass is discarded by its caller anyway, and a partial list
    // merged into the next generation would put repositories from two different
    // answers on one board (design.md D16).
    return [];
  }

  const candidates = admit(fromIndex, fromWalk, folders, roots, resolveExcluded(input, folders));

  const repositories = await Promise.all(
    candidates.map((candidate) => classifyRepository(describe(candidate, folders))),
  );

  // Ordered so that two passes over an unchanged directory produce the same
  // list in the same order. This is not the order the board is in - that is
  // `view/order.ts`, which sorts by the last commit and has facts this module
  // has not read yet - it is only a promise that discovery adds no shuffle of
  // its own to whatever the board does next.
  repositories.sort(
    (a, b) => a.label.localeCompare(b.label) || pathKey(a.path).localeCompare(pathKey(b.path)),
  );

  log.info(
    `Discovered ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`,
  );
  return repositories;
}

// ---------------------------------------------------------------------------
// The two searches
// ---------------------------------------------------------------------------

async function runWorkspaceSearch(input: DiscoveryInput): Promise<RepositoryCandidate[]> {
  if (!input.searchWorkspace) {
    return [];
  }
  try {
    return await input.searchWorkspace(input.signal);
  } catch (error) {
    // One failing search must not empty a list the walk could still fill.
    log.error('Searching the open folders for repositories failed', error);
    return [];
  }
}

/**
 * The walk covers the configured roots **and** the open folders.
 *
 * Walking the open folders repeats what the index was just asked for, and that
 * is deliberate: the index is blind to a bare repository, it returns nothing
 * when a search fails, and it answers only while a folder is open. The walk is
 * what makes the list the same list in all of those cases, which is what "the
 * walk is the authority" means (design.md D4). The repetition costs nothing on
 * the board, because the two sources are merged by resolved path below, and
 * little on disk, because the walk stops at every repository it finds rather
 * than descending into it (design.md D7).
 */
function runWalk(
  input: DiscoveryInput,
  folders: readonly string[],
  roots: readonly string[],
): Promise<RepositoryCandidate[]> {
  const dirs = [...folders, ...roots];
  if (dirs.length === 0) {
    // Nothing to scan is an ordinary state - no folder open and no configured
    // root - and it is answered here rather than left to the walk, which would
    // return the same empty list after resolving nothing.
    return Promise.resolve([]);
  }
  return searchFilesystem(dirs, { maxDepth: input.maxDepth, signal: input.signal });
}

// ---------------------------------------------------------------------------
// Which candidates become rows
// ---------------------------------------------------------------------------

/**
 * The merged candidate set, with everything that is not a row removed.
 *
 * The three filters run in a fixed order, and the order is a decision rather
 * than an accident: nesting is judged against the *merged* set and before
 * `multirepoLedger.exclude` is applied, so that excluding a repository can only ever
 * remove rows. Judging it afterwards would mean excluding an outer repository
 * made the vendored clone inside it appear, which is a setting producing the
 * opposite of what it says.
 */
function admit(
  fromIndex: readonly RepositoryCandidate[],
  fromWalk: readonly RepositoryCandidate[],
  folders: readonly string[],
  roots: readonly string[],
  excluded: readonly string[],
): RepositoryCandidate[] {
  const merged = new Map<string, RepositoryCandidate>();

  for (const candidate of fromIndex) {
    // The index query carries no excludes at all, because any other value
    // returns nothing (design.md D5), so it reaches into `node_modules`,
    // `target` and `.venv` - the directories the walk refuses to enter. The
    // walk's own list is applied to the index's results here instead, and only
    // to the index's results: applying it to the walk's would drop a repository
    // under a root the user named `D:\build`, which the walk was right to
    // return, because the list governs what is descended into and never what
    // was asked for by name.
    if (underExcludedDirectoryName(candidate.worktreePath, folders)) {
      continue;
    }
    merged.set(pathKey(candidate.worktreePath), normalize(candidate));
  }

  for (const candidate of fromWalk) {
    // The walk overwrites the index's answer for the same working tree rather
    // than deferring to it. The two agree in every ordinary case; where they
    // can disagree it is about the shape of the `.git` entry, and the walk
    // stat'ed that entry while the index inferred it from which glob matched.
    merged.set(pathKey(candidate.worktreePath), normalize(candidate));
  }

  const nested = nestedCandidates(merged, roots);

  return [...merged.values()].filter(
    (candidate) =>
      !nested.has(pathKey(candidate.worktreePath)) && !isExcluded(candidate.worktreePath, excluded),
  );
}

/**
 * One candidate in one spelling.
 *
 * The editor's index hands back whatever the search returned - forward slashes
 * on Windows, sometimes a trailing separator - while the walk hands back paths
 * it built itself, and from here on the two are compared, logged and handed to
 * `classify.ts` side by side. `pathKey` already makes the *comparisons* agree;
 * this makes the strings a reader sees agree too, so a log line naming a
 * repository and a log line naming the repository it sits inside are not
 * written in two different alphabets.
 */
function normalize(candidate: RepositoryCandidate): RepositoryCandidate {
  return {
    worktreePath: normalizePath(candidate.worktreePath),
    gitIsFile: candidate.gitIsFile,
    ...(candidate.gitPath === undefined ? {} : { gitPath: normalizePath(candidate.gitPath) }),
  };
}

/**
 * The candidates that lie inside another candidate's working tree, which are
 * not second rows (design.md D67).
 *
 * The walk already stops at the outer `.git` and never enters a working tree,
 * so this rule changes nothing about what the walk returns - and it must still
 * be here, because the *index* is not pruned and cannot be. Its second pass
 * matches a file named `.git` at any depth, which is precisely the shape of an
 * initialised submodule and of a vendored clone sitting inside somebody else's
 * working tree. Without this test a workspace holding one initialised submodule
 * grows a row the design says it does not have, and - because the index answers
 * before the walk does - that row would appear and then vanish, which is worse
 * than either outcome on its own.
 *
 * So: do not "fix" the walk to descend into working trees, and do not delete
 * this because the walk makes it look redundant. Each covers a source the other
 * does not.
 *
 * The exception is the user. Naming the inner repository, or a directory
 * between it and the enclosing working tree, in `multirepoLedger.additionalRoots` is
 * how somebody asks for a row the walk would otherwise decline to look for.
 * Naming the enclosing repository itself is not that request: it asks for that
 * repository, which is exactly what it gets.
 */
function nestedCandidates(
  merged: ReadonlyMap<string, RepositoryCandidate>,
  roots: readonly string[],
): Set<string> {
  const nested = new Set<string>();
  for (const [key, candidate] of merged) {
    const enclosing = enclosingWorktree(candidate.worktreePath, merged);
    if (enclosing === undefined) {
      continue;
    }
    const named = roots.some(
      (root) =>
        isPathInside(candidate.worktreePath, root) &&
        isPathInside(root, enclosing) &&
        !pathsEqual(root, enclosing),
    );
    if (named) {
      continue;
    }
    nested.add(key);
    log.info(
      `${candidate.worktreePath} sits inside ${enclosing} and gets no row of its own; name it, or a directory above it, in multirepoLedger.additionalRoots to see it`,
    );
  }
  return nested;
}

/**
 * The innermost other candidate whose working tree contains this one.
 *
 * Answered by walking this path's own ancestors and looking each one up in the
 * set already keyed by path, rather than by comparing every candidate with
 * every other. The ancestor walk is bounded by the depth of one path where the
 * comparison is bounded by the square of the number of repositories, and on a
 * directory of two hundred of them that is the difference between a few hundred
 * lookups and forty thousand string comparisons for an answer that is almost
 * always "no".
 */
function enclosingWorktree(
  target: string,
  merged: ReadonlyMap<string, RepositoryCandidate>,
): string | undefined {
  let current = normalizePath(target);
  for (;;) {
    const parent = path.dirname(current);
    // `path.dirname` of a root is that root, which is what ends this loop on
    // every platform without needing to know what a root looks like.
    if (parent === current) {
      return undefined;
    }
    const found = merged.get(pathKey(parent));
    if (found !== undefined) {
      return found.worktreePath;
    }
    current = parent;
  }
}

/**
 * Whether a path the editor's index returned sits under a directory the walk
 * would have refused to enter.
 *
 * Judged relative to the workspace folder the candidate came from, never on the
 * whole absolute path: a user whose projects live under `C:\build` would
 * otherwise lose every repository they own, because a name on the list appears
 * in the path to all of them. A candidate from outside every open folder cannot
 * be judged this way - there is no root for it to be relative to - and is
 * admitted, because `findFiles` searches only inside the open folders and a hit
 * from anywhere else is not something this rule can reason about.
 */
function underExcludedDirectoryName(target: string, folders: readonly string[]): boolean {
  const folder = containingFolder(target, folders);
  if (folder === undefined) {
    return false;
  }
  const relative = path.relative(folder, normalizePath(target));
  if (relative.length === 0) {
    return false;
  }
  return relative
    .split(/[\\/]+/)
    .some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

/**
 * Whether `multirepoLedger.exclude` removes this repository.
 *
 * A configured path removes the repository at it *and* everything beneath it.
 * The setting is described as a list of repositories, and matching each path
 * exactly would honour that reading - but the case people actually have is a
 * directory of mirrors, or of vendored checkouts they never work in, and asking
 * them to list forty paths that share a parent is asking them to maintain the
 * setting by hand every time they clone. Nothing is lost by the wider reading:
 * a repository named exactly is still removed.
 */
function isExcluded(target: string, excluded: readonly string[]): boolean {
  return excluded.some((entry) => isPathInside(target, entry));
}

// ---------------------------------------------------------------------------
// Where a repository belongs
// ---------------------------------------------------------------------------

/**
 * The candidate as `classify.ts` takes it, with the two facts this module owns
 * attached: which open folder holds the repository, and therefore where the
 * list groups it.
 *
 * Both are decided from containment rather than from which search returned the
 * candidate. The alternative - whichever search found it first decides, which
 * is what the sibling project does - is wrong here for a case that is routine
 * rather than exotic: a bare repository beneath an open folder is invisible to
 * the index and can only ever arrive from the walk, so it would be filed as a
 * configured-root repository and labelled by its own directory name, while the
 * repository beside it that the index did see was labelled by its path within
 * the folder. One fact, read one way, cannot produce that.
 */
function describe(
  candidate: RepositoryCandidate,
  folders: readonly string[],
): ClassifiableCandidate {
  const workspaceFolder = containingFolder(candidate.worktreePath, folders);
  const source: RepositorySource = workspaceFolder === undefined ? 'settings' : 'workspace';
  return {
    worktreePath: candidate.worktreePath,
    gitIsFile: candidate.gitIsFile,
    source,
    // Spread rather than assigned, because `classify.ts` reads the *absence* of
    // `gitPath` as "this directory is itself the git directory", which is how a
    // bare repository is recognised. An explicit `undefined` is a different
    // thing to write and only some of the ways to read it agree with the check
    // that module makes.
    ...(candidate.gitPath === undefined ? {} : { gitPath: candidate.gitPath }),
    ...(workspaceFolder === undefined ? {} : { workspaceFolder }),
  };
}

/** The innermost open folder containing the repository, for nested or overlapping folders. */
function containingFolder(target: string, folders: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folders) {
    if (!isPathInside(target, folder)) {
      continue;
    }
    if (best === undefined || folder.length > best.length) {
      best = folder;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The configured paths
// ---------------------------------------------------------------------------

async function resolveAdditionalRoots(
  input: DiscoveryInput,
  folders: readonly string[],
): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.additionalRoots) {
    if (raw.trim().length === 0) {
      continue;
    }
    const resolved = resolveConfiguredPath(raw, folders);
    if (resolved === undefined) {
      reportMissing(input, raw.trim());
      continue;
    }
    const key = pathKey(resolved);
    // The same directory written twice - or written once as `~/src` and once in
    // full - is one root, and is reported at most once when it is not there.
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (!(await isDirectory(resolved))) {
      reportMissing(input, resolved);
      continue;
    }
    dirs.push(resolved);
  }

  return dirs;
}

/**
 * `multirepoLedger.exclude`, resolved the same way the roots are.
 *
 * A configured path that is not there is deliberately *not* reported here, and
 * the asymmetry with the roots is the point: a root that does not exist is a
 * setting doing nothing, which the user wants to be told about, while an
 * exclusion whose repository has since been deleted is a setting that has
 * already done its job. Reporting it would nag about a line that is harmless to
 * leave in.
 */
function resolveExcluded(input: DiscoveryInput, folders: readonly string[]): string[] {
  const excluded: string[] = [];
  for (const raw of input.exclude ?? []) {
    if (raw.trim().length === 0) {
      continue;
    }
    const resolved = resolveConfiguredPath(raw, folders);
    if (resolved !== undefined) {
      excluded.push(resolved);
    }
  }
  return excluded;
}

/**
 * A configured path that is not there is a setting to correct, not a failure.
 *
 * A caller that takes the callback owns the wording, because it is the only
 * place that knows whether the extension has a surface to say it on; the log is
 * what is left when nobody does.
 */
function reportMissing(input: DiscoveryInput, target: string): void {
  if (input.onMissingRoot) {
    input.onMissingRoot(target);
    return;
  }
  log.warn(`Configured additional root was not found: ${target}`);
}

/**
 * A configured path as the user typed it, made absolute.
 *
 * `~` is expanded because the setting is edited in a text box and a
 * home-relative path is what people type into one. A relative path is read
 * against the first open folder, the only base the user could have meant; with
 * no folder open there is no such base, so the path is reported as missing
 * rather than resolved against whatever directory the extension host happened
 * to be launched in - which is not a place the user has ever seen, and would
 * make the same setting mean different directories in different windows.
 */
export function resolveConfiguredPath(
  raw: string,
  folders: readonly string[],
): string | undefined {
  const trimmed = raw.trim();
  const home = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  const expanded = home ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;

  if (path.isAbsolute(expanded)) {
    return normalizePath(expanded);
  }
  const base = folders[0];
  return base === undefined ? undefined : normalizePath(path.resolve(base, expanded));
}
