/**
 * The filesystem walk that finds git repositories.
 *
 * Adapted from the sibling project's `src/discovery/search.ts` (design.md D3).
 * The needle changed from a directory named `openspec` to a `.git` entry, and
 * that change is not the string it looks like: `.git` was a member of the
 * sibling's exclusion list, `.git` is often a *file* rather than a directory,
 * and finding one means stopping rather than merely skipping.
 *
 * The editor's own index answers faster for the open folders and
 * `vscodeSearch.ts` asks it (design.md D4), but the index cannot see
 * `repoLedger.additionalRoots`, cannot see a bare repository, and returns
 * nothing at all in a window with no folder open - which for this extension is
 * an ordinary window and not an edge case. So the walk is the authority, and it
 * is also what the unit tests can run, because it needs no extension host.
 *
 * Nothing here spawns a process. Every fact this module reports came from a
 * directory listing.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { pathKey } from '../model/keys.ts';
import { statSafe } from '../util/fsx.ts';
import { log } from '../util/log.ts';

/**
 * A directory the walk decided is a repository. No `gitdir:` pointer has been
 * resolved and no process has run: classifying this into a `RepositoryKind` is
 * `classify.ts`'s job (design.md D8), and it needs to know which of the shapes
 * below the walk actually saw.
 */
export interface RepositoryCandidate {
  /**
   * Absolute path of the directory holding the `.git` entry - the working tree,
   * and the directory every later git command is spawned in.
   *
   * A bare repository has no working tree, and for one of those this is the
   * repository directory itself.
   */
  readonly worktreePath: string;
  /**
   * Absolute path of the `.git` entry, in whichever shape it was found, and
   * **absent for a bare repository**, which has no such entry at all.
   *
   * The absence is the statement, rather than a flag beside it or a `gitPath`
   * pointed back at the directory: `classify.ts` reads the missing value as
   * "the directory is itself the git directory" and applies git's own test to
   * it, so encoding the same fact a second way would give the two modules two
   * chances to disagree about one repository.
   */
  readonly gitPath?: string;
  /**
   * `.git` is a file rather than a directory - a linked worktree, a submodule
   * working directory, or a repository created with `--separate-git-dir`.
   * Meaningless, and false, when there is no `gitPath`.
   */
  readonly gitIsFile: boolean;
}

/**
 * Directory names the walk will not descend into, from the sibling's list with
 * `.git` removed.
 *
 * Removing `.git` is the single most consequential line in this file. Left in -
 * and it is in the list this file was copied from - the walk skips the entry it
 * exists to find, descends past every repository under the root, and returns
 * nothing. There is no error in that failure anywhere: the extension simply
 * ships with an empty board.
 *
 * The list applies only to what the walk descends *into*, never to a directory
 * the user named as a root, so a repository living under one of these names is
 * still reachable by naming it, or its parent, in `repoLedger.additionalRoots`.
 * It is deliberately not a setting (design.md D10): `repoLedger.exclude` already
 * removes a repository by path, which is the case users actually have, and a
 * second and subtly different exclusion mechanism is a second thing to get
 * wrong.
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  '.vscode-test',
  '.venv',
  '__pycache__',
  'bin',
  'obj',
];

export interface FsSearchOptions {
  /** Levels below each starting directory. Default 32, from `repoLedger.maxDepth`. */
  maxDepth?: number;
  /** Replaces `DEFAULT_EXCLUDED_DIRS` rather than adding to it. */
  excludedDirs?: readonly string[];
  /** Directories read before the walk gives up. Default 100 000. */
  maxDirectories?: number;
  signal?: AbortSignal;
}

/**
 * Levels below a starting directory.
 *
 * The caller passes this from `repoLedger.maxDepth`; the default here is the
 * same number and exists so a test, or a caller that has no settings to read,
 * is still bounded. It is a stop against a symlink cycle the dirent check
 * misses and against a root that turns out to be a home directory - **not** a
 * way to make the scan cheaper. Because the walk stops at every repository it
 * finds, depth is not what keeps it cheap, so the bound does not have to be
 * small to be useful; and a repository missing from the board produces no
 * evidence that it is missing, whereas a slow scan announces itself.
 */
const DEFAULT_MAX_DEPTH = 32;

/**
 * Directories read before the walk stops and says so.
 *
 * Its only job is to turn "the user pointed this at `C:\`" into a reported
 * condition rather than a hang (design.md D10). It is deliberately far above
 * any layout of repositories - the walk counts only the directories *above* the
 * repositories, since each repository ends the walk of its own subtree - so it
 * is a stop and not a budget to tune. It is not derived from any measurement.
 */
const DEFAULT_MAX_DIRECTORIES = 100_000;

/**
 * Directories read at once.
 *
 * This bounds concurrently open directory handles, not processor work, so it is
 * not derived from the core count and does not vary with the machine: a wide
 * tree must not be able to exhaust the file-handle table of the extension host,
 * which is shared with every other extension in the window.
 */
const CONCURRENCY = 16;

const GIT_ENTRY = '.git';

/**
 * The layout that says a directory is a repository with no working tree.
 *
 * Spelled exactly as git writes them, and matched exactly. Folding case here
 * would let a directory holding `head`, `config`, `objects/` and `refs/` - four
 * ordinary names - be reported as a repository on a case-sensitive filesystem,
 * where git itself would refuse it.
 */
const BARE_FILES: readonly string[] = ['HEAD', 'config'];
const BARE_DIRS: readonly string[] = ['objects', 'refs'];

interface Visited {
  candidate?: RepositoryCandidate;
  children: string[];
}

/**
 * Find every git repository at or beneath `dirs`.
 *
 * Level by level rather than depth-first, so `maxDepth` is a real bound on the
 * work and a shallow repository is reported before a deep one is even reached.
 * An aborted signal ends the walk and yields what was found so far, because a
 * cancelled discovery is discarded by its caller anyway (design.md D16).
 */
export async function searchFilesystem(
  dirs: readonly string[],
  options: FsSearchOptions = {},
): Promise<RepositoryCandidate[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const excluded = new Set(
    (options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS).map((name) => name.toLowerCase()),
  );
  const signal = options.signal;

  const found = new Map<string, RepositoryCandidate>();
  /** Guards against overlapping start directories walking the same tree twice. */
  const seen = new Set<string>();
  /** Directories actually read, which is what `maxDirectories` bounds. */
  let read = 0;

  let level: string[] = [];
  for (const dir of dirs) {
    // A root the user named is resolved through its links rather than refused:
    // `~/src -> /Volumes/work` is an ordinary layout and a path the user typed
    // is a statement of intent (design.md D10). Resolving it here is also what
    // makes `seen` a set of *real* paths at no further cost - the walk descends
    // into nothing but a directory entry that reports itself as a directory, so
    // every path built below a resolved root is already real - and a set of
    // real paths is what makes a cycle terminate rather than merely be bounded.
    const start = await realPath(dir);
    const key = pathKey(start);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    level.push(start);
  }

  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += CONCURRENCY) {
      if (signal?.aborted) {
        return sortCandidates(found);
      }
      if (read >= maxDirectories) {
        reportStop(`Repository search stopped after reading ${plural(read, 'directory')}`, [
          ...level.slice(index),
          ...next,
        ]);
        return sortCandidates(found);
      }
      const batch = level.slice(index, index + CONCURRENCY);
      read += batch.length;
      const results = await Promise.all(batch.map((dir) => visit(dir, excluded, signal)));
      for (const result of results) {
        if (result.candidate) {
          found.set(pathKey(result.candidate.worktreePath), result.candidate);
        }
        for (const child of result.children) {
          const key = pathKey(child);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          next.push(child);
        }
      }
    }
    level = next;
  }

  // Depth is the last guard against a cycle the dirent check missed, so when it
  // is what ended the walk, a repository that never appeared has an explanation
  // in the log. Nothing on the board can say it: an incomplete list looks
  // exactly like a complete one.
  reportStop(`Repository search stopped at depth ${maxDepth}`, level);

  return sortCandidates(found);
}

/** Say what was left unwalked, or say nothing at all when the walk finished. */
function reportStop(what: string, unsearched: readonly string[]): void {
  const first = unsearched[0];
  if (first === undefined) {
    return;
  }
  log.warn(
    `${what}, leaving ${plural(unsearched.length, 'directory')} unsearched, starting with ${first}`,
  );
}

function plural(count: number, noun: 'directory'): string {
  return `${count} ${count === 1 ? noun : 'directories'}`;
}

async function visit(
  dir: string,
  excluded: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Visited> {
  // Checked here as well as per batch, so a cancellation lands between two
  // directories rather than after the whole batch it arrived in.
  if (signal?.aborted) {
    return { children: [] };
  }

  const entries = await readEntries(dir);

  // Case is folded here and deliberately not folded for the bare layout below,
  // because the two mistakes are not the same size. Accepting a `.Git` that git
  // itself would refuse costs one row, and `classify.ts` marks it `unknown` and
  // says why; missing a `.git` whose case the filesystem folded costs a
  // repository that is silently absent, and nothing on the board can say a row
  // is missing.
  const git = entries.find((entry) => entry.name.toLowerCase() === GIT_ENTRY);
  if (git !== undefined) {
    const gitPath = path.join(dir, git.name);
    const candidate: RepositoryCandidate = {
      worktreePath: dir,
      gitPath,
      gitIsFile: await gitEntryIsFile(git, gitPath),
    };
    // A repository is a leaf (design.md D7). Its own subdirectories are not
    // further repositories: to git, a `.git` inside a working tree is either a
    // submodule - which the superproject records in `.gitmodules` and which is
    // read from there, at zero process cost - or untracked junk it has been
    // told to ignore. Neither wants the walk to go looking, and descending
    // anyway would make discovery's cost scale with what is *inside* the
    // repositories rather than with how many there are, which is backwards for
    // a board whose unit is the repository. Working trees are also exactly
    // where `node_modules`, `target` and `.venv` live.
    return { candidate, children: [] };
  }

  if (isBareLayout(entries)) {
    // A bare repository has no `.git` anywhere, so neither index pass can see
    // it (design.md D6) and this is the only place it is ever found. Stopping
    // here matters twice over: it is a repository and therefore a leaf, and its
    // `objects/` directory fans out into 256 subdirectories that would
    // otherwise each be read to learn nothing.
    return { candidate: { worktreePath: dir, gitIsFile: false }, children: [] };
  }

  const children: string[] = [];
  for (const entry of entries) {
    // A symbolic link or a Windows junction reports itself as a link and not as
    // a directory, so this test is also what stops the walk following one into
    // a cycle or out of the root the user asked about.
    if (!entry.isDirectory()) {
      continue;
    }
    if (excluded.has(entry.name.toLowerCase())) {
      continue;
    }
    children.push(path.join(dir, entry.name));
  }
  return { children };
}

/**
 * Directory entries, sorted by name; empty when the directory cannot be read.
 *
 * `fsx.listDirectories` is the same `readdir` call and is not used here because
 * it keeps only the directories - and whether `.git` is a file or a directory
 * is precisely what this walk has to report. Recovering that afterwards would
 * cost a second syscall per repository for something the first one already
 * knew.
 *
 * Sorted so that the log line naming the first unsearched directory names the
 * same one on every platform; the results themselves are sorted at the end.
 */
async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // A directory that was removed between being listed and being read, a
    // permission wall, or a path that turned out to be a file. One unreadable
    // directory must not be able to decide what the whole board shows, so this
    // is reported as "nothing here" rather than raised: the walk continues, and
    // every other repository still appears.
    return [];
  }
}

/**
 * Whether the `.git` entry is a file rather than a directory.
 *
 * The dirent describes the entry itself, so a `.git` that is a symbolic link is
 * neither a file nor a directory to it, and answering from the dirent alone
 * would classify the repository by the shape of the link instead of by what it
 * points at. Only that case pays for a `stat`. A link that points nowhere is
 * reported as a file, because `classify.ts` then tries to read the pointer and
 * reports git's own complaint on the row, which is worth more than this walk
 * inventing a kind for a repository it could not resolve.
 */
async function gitEntryIsFile(entry: Dirent, gitPath: string): Promise<boolean> {
  if (entry.isFile()) {
    return true;
  }
  if (entry.isDirectory()) {
    return false;
  }
  const stats = await statSafe(gitPath);
  return !stats?.isDirectory();
}

/**
 * The four entries that say a directory is a bare repository (design.md D8).
 *
 * Answered from the entries already in hand, so a bare repository costs the
 * walk no extra syscall and no process. Each name is required in the shape git
 * writes it - `HEAD` and `config` as files, `objects` and `refs` as directories
 * - because it is the combination that makes this cheap test safe: any one of
 * the four alone is an ordinary name that an ordinary directory may carry.
 */
function isBareLayout(entries: readonly Dirent[]): boolean {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.add(entry.name);
    } else if (entry.isFile()) {
      files.add(entry.name);
    }
  }
  return BARE_FILES.every((name) => files.has(name)) && BARE_DIRS.every((name) => dirs.has(name));
}

/**
 * The path with its links resolved, or the path itself when it cannot be
 * resolved.
 *
 * A root that does not exist is kept rather than dropped, so that the walk
 * returns nothing for it in the ordinary way and the caller - which is the only
 * place that knows the path came from a setting rather than from a workspace
 * folder - is the one that reports it.
 */
async function realPath(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function sortCandidates(found: ReadonlyMap<string, RepositoryCandidate>): RepositoryCandidate[] {
  return [...found.values()].sort((a, b) =>
    pathKey(a.worktreePath).localeCompare(pathKey(b.worktreePath)),
  );
}
