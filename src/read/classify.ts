/**
 * What kind of repository the walk found, decided without spawning anything.
 *
 * Every answer here is a stat or a one-line file read. That is not a
 * micro-optimisation: the walk can hand this module hundreds of directories at
 * once, and `git rev-parse --git-common-dir --is-bare-repository` would turn
 * each of them into a process before a single row had been read. Process count
 * is the budget the whole read is planned against, so the questions that the
 * filesystem can answer are answered here and never bought with a spawn.
 *
 * It is also the only place that *can* answer some of them. `git status
 * --porcelain=v2` says nothing about whether a checkout is a linked worktree, a
 * submodule or a bare repository, and nothing about whether its history is
 * truncated - yet all three change what the row is allowed to claim, because a
 * shallow clone's ahead/behind figures are computed against a graph that stops.
 *
 * Nothing here imports `vscode`, and nothing here writes.
 */

import * as path from 'node:path';

import { isPathInside, normalizePath, pathsEqual } from '../model/keys.ts';
import type { DiscoveredRepository, RepositoryKind, RepositorySource } from '../model/types.ts';
import { isDirectory, isFile, readTextSafe, statSafe } from '../util/fsx.ts';

/**
 * What the walk found, before anything has been decided about it.
 *
 * `gitPath` is optional, and its absence is the bare-repository case. The walk
 * looks for a `.git` entry and stops descending when it finds one, so a bare
 * repository - which has no `.git` inside it, only the admin files themselves -
 * can never be found that way. It reaches this module only when the walk has
 * some other reason to propose the directory: it is one of the configured
 * roots, or it is named `something.git`, the convention every forge and every
 * `git clone --bare` follows. Anything bare that is neither of those is not
 * found at all, and this module does not pretend otherwise.
 */
export interface RepositoryCandidate {
  /** Absolute path of the directory the walk found. */
  readonly worktreePath: string;
  /** Absolute path of the `.git` entry inside it, when there is one. */
  readonly gitPath?: string;
  /** True when that entry is a file rather than a directory. Ignored without `gitPath`. */
  readonly gitIsFile: boolean;
  readonly source: RepositorySource;
  /** Absolute path of the workspace folder containing the repository, when it is inside one. */
  readonly workspaceFolder?: string;
}

/** The first eight bytes of a `.git` file, and the only prefix git itself accepts. */
const GIT_FILE_PREFIX = 'gitdir: ';

/**
 * A `.git` file holds one line naming one directory. This cap is not a
 * performance guard - it is a refusal to read something that is not a `.git`
 * file into memory just to discover that it is not one. Four kilobytes is far
 * past the longest path any filesystem here accepts, so no real file is
 * rejected by it.
 */
const MAX_GIT_FILE_BYTES = 4096;

/**
 * Classify one candidate and resolve its real git directory.
 *
 * Always returns a repository, never throws and never omits one: a candidate
 * that cannot be classified comes back with `kind: 'unknown'` and a `problem`
 * saying why, because a row that explains itself is worth more than a
 * repository that silently is not in the list. Nothing on screen can say that
 * something is missing.
 */
export async function classifyRepository(
  candidate: RepositoryCandidate,
): Promise<DiscoveredRepository> {
  const worktreePath = normalizePath(candidate.worktreePath);
  const found = await examine(candidate, worktreePath);

  const repository: DiscoveredRepository = {
    path: worktreePath,
    gitDir: found.gitDir,
    label: labelFor(worktreePath, candidate.workspaceFolder),
    kind: found.kind,
    shallow: found.shallow,
    source: candidate.source,
  };
  if (candidate.workspaceFolder !== undefined) {
    repository.workspaceFolder = normalizePath(candidate.workspaceFolder);
  }
  if (found.problem !== undefined) {
    repository.problem = found.problem;
  }
  return repository;
}

/** The three facts this module establishes, before they are dressed as a repository. */
interface Classification {
  readonly kind: RepositoryKind;
  readonly gitDir: string;
  readonly shallow: boolean;
  readonly problem?: string;
}

function examine(
  candidate: RepositoryCandidate,
  worktreePath: string,
): Promise<Classification> {
  if (candidate.gitPath === undefined) {
    return classifyDirectoryItself(worktreePath);
  }
  const gitPath = normalizePath(candidate.gitPath);
  return candidate.gitIsFile ? classifyGitFile(gitPath) : classifyGitDirectory(gitPath);
}

/**
 * `.git` is a directory: an ordinary checkout, and the common case by a long way.
 *
 * The `HEAD` check is the whole of the validation, and it is deliberately not
 * the fuller `HEAD` + `objects` + `refs` test used for a bare candidate below.
 * The asymmetry is the evidence available: here the directory is already named
 * `.git`, which is strong evidence on its own, so one more stat is enough to
 * throw out a stray folder somebody happened to call that. A stricter test
 * would risk rejecting a real repository whose layout is unusual - a relocated
 * object store, say - and a genuine repository missing from the list is a worse
 * failure than an odd row, because nothing on screen would say it was dropped.
 */
async function classifyGitDirectory(gitPath: string): Promise<Classification> {
  const common = await resolveCommonDir(gitPath);
  const shallow = await isShallow(common.commonDir);

  if (!(await isFile(path.join(gitPath, 'HEAD')))) {
    return {
      kind: 'unknown',
      gitDir: gitPath,
      shallow,
      problem: `${gitPath} is a directory but holds no HEAD file, so it is not a git directory.`,
    };
  }
  return { kind: 'plain', gitDir: gitPath, shallow };
}

/**
 * `.git` is a file: a linked worktree, a submodule, or a repository created
 * with `--separate-git-dir`. All three point somewhere else, and which of the
 * three it is cannot be told from the file's presence alone.
 */
async function classifyGitFile(gitPath: string): Promise<Classification> {
  const stats = await statSafe(gitPath);
  if (stats !== undefined && stats.size > MAX_GIT_FILE_BYTES) {
    return {
      kind: 'unknown',
      gitDir: gitPath,
      shallow: false,
      problem: `${gitPath} is ${stats.size} bytes, and a .git file is one line.`,
    };
  }

  const text = await readTextSafe(gitPath);
  if (text === undefined) {
    return {
      kind: 'unknown',
      gitDir: gitPath,
      shallow: false,
      problem: `${gitPath} could not be read.`,
    };
  }

  const target = parseGitFile(text);
  if (target === undefined) {
    return {
      kind: 'unknown',
      gitDir: gitPath,
      shallow: false,
      problem: `${gitPath} does not begin with "gitdir: ", so it names no git directory.`,
    };
  }

  // Resolved against the directory holding the `.git` file, which is what git
  // does and what the common case needs: a submodule's file says
  // `gitdir: ../.git/modules/<name>`, and resolving that against the process
  // working directory instead would land somewhere unrelated on every machine.
  const resolved = normalizePath(path.resolve(path.dirname(gitPath), target));

  if (!(await isDirectory(resolved))) {
    // A dangling pointer: the parent repository was deleted, or a worktree was
    // removed without `git worktree remove`. The kind is still reported when
    // the path shape carries it, because that shape is evidence actually read
    // off disk rather than a guess, and "this worktree's repository is gone" is
    // a more useful row than "something here is unreadable".
    const shape = kindFromGitDirPath(resolved);
    return {
      kind: shape ?? 'unknown',
      gitDir: resolved,
      shallow: false,
      problem: `${gitPath} points at ${resolved}, which is not there.`,
    };
  }

  const common = await resolveCommonDir(resolved);
  // Filesystem evidence first, path shape second. Only a linked worktree's git
  // directory carries a `commondir` file, so its presence settles the question
  // outright; the path shape is what remains for a submodule, whose git
  // directory is a complete one and looks like any other.
  const kind: RepositoryKind = common.linked ? 'worktree' : (kindFromGitDirPath(resolved) ?? 'plain');

  return { kind, gitDir: resolved, shallow: await isShallow(common.commonDir) };
}

/**
 * No `.git` entry at all, so the only remaining question is whether the
 * directory *is* a git directory - a bare repository, which has no working tree
 * to hold one.
 *
 * The test is the same one git applies: a `HEAD` file beside `objects` and
 * `refs`. `core.bare` in the config file is not consulted, because the walk can
 * only offer a candidate here when there is no working tree beside these files,
 * and having no working tree is exactly what the word means to somebody reading
 * the row. Parsing a config file to contradict that would buy a different
 * answer only for a case nobody has.
 */
async function classifyDirectoryItself(worktreePath: string): Promise<Classification> {
  const [head, objects, refs] = await Promise.all([
    isFile(path.join(worktreePath, 'HEAD')),
    isDirectory(path.join(worktreePath, 'objects')),
    isDirectory(path.join(worktreePath, 'refs')),
  ]);

  if (!head || !objects || !refs) {
    return {
      kind: 'unknown',
      gitDir: worktreePath,
      shallow: false,
      problem: `${worktreePath} has no .git entry and holds no HEAD, objects and refs of its own.`,
    };
  }

  const common = await resolveCommonDir(worktreePath);
  return { kind: 'bare', gitDir: worktreePath, shallow: await isShallow(common.commonDir) };
}

/**
 * The path a `.git` file names, or `undefined` when the file is not one.
 *
 * Only trailing whitespace is stripped. Leading whitespace is kept, because a
 * directory name may legitimately start with a space on every filesystem this
 * runs on and trimming it would silently point the read at a different
 * directory - the kind of failure that shows up as "this one repository never
 * loads" and is invisible in a log.
 */
export function parseGitFile(contents: string): string | undefined {
  if (!contents.startsWith(GIT_FILE_PREFIX)) {
    return undefined;
  }
  const target = contents.slice(GIT_FILE_PREFIX.length).trimEnd();
  return target.length === 0 ? undefined : target;
}

/**
 * What the shape of a git directory path says the checkout is, if anything.
 *
 * git puts a linked worktree's admin directory at `<common>/worktrees/<name>`
 * and a submodule's at `<common>/modules/<name>`, so the segment names are the
 * signal. The last match wins rather than the first, because the two nest: a
 * linked worktree added inside a submodule sits at
 * `<super>/.git/modules/sub/worktrees/wt`, and it is a worktree - the innermost
 * qualifier is the one that describes what this checkout is. Taking the first
 * match would call every such worktree a submodule.
 *
 * Whole segments are compared rather than searching for `/worktrees/` in the
 * string, so a repository living under a directory that happens to be called
 * `modules-old` is not swept up by a substring. A repository whose git
 * directory genuinely sits under a directory named `modules` is still
 * mislabelled here, and that is accepted: it changes one marker word on line
 * three and changes nothing about what is read or how.
 */
export function kindFromGitDirPath(gitDir: string): 'worktree' | 'submodule' | undefined {
  let found: 'worktree' | 'submodule' | undefined;
  for (const segment of gitDir.split(/[\\/]+/)) {
    if (segment === 'worktrees') {
      found = 'worktree';
    } else if (segment === 'modules') {
      found = 'submodule';
    }
  }
  return found;
}

interface CommonDir {
  /** A `commondir` file was there, which only a linked worktree's git directory has. */
  readonly linked: boolean;
  /** Where the repository-wide files live: the git directory itself, unless linked. */
  readonly commonDir: string;
}

/**
 * The directory a linked worktree shares with the repository it was added from.
 *
 * Its own git directory holds only what is per-worktree - HEAD, the index, its
 * reflogs - and points at the rest through a `commondir` file, usually holding
 * the relative `../..`. Everything repository-wide is over there, which is why
 * this is resolved before anything repository-wide is looked for.
 */
async function resolveCommonDir(gitDir: string): Promise<CommonDir> {
  const text = await readTextSafe(path.join(gitDir, 'commondir'));
  if (text === undefined) {
    return { linked: false, commonDir: gitDir };
  }
  const target = text.trim();
  if (target.length === 0) {
    return { linked: true, commonDir: gitDir };
  }
  // `path.resolve` returns an absolute target unchanged, so both spellings git
  // may have written are handled by the one call.
  return { linked: true, commonDir: normalizePath(path.resolve(gitDir, target)) };
}

/**
 * Whether the history stops short.
 *
 * The presence of the file is the whole test, which is what git itself does:
 * it treats the file as the answer and reads the contents only to learn where
 * the graft points are. `git fetch --unshallow` deletes it, so a repository
 * that has been filled in stops reporting shallow without anything having to
 * notice.
 *
 * The argument is the *common* directory rather than the git directory,
 * because the file is repository-wide. Passing the git directory would work for
 * every ordinary checkout and quietly fail for exactly one case - a linked
 * worktree of a shallow clone, which would then report a complete history and
 * let its row present ahead/behind figures computed against a truncated graph
 * as though they were the whole story.
 */
async function isShallow(commonDir: string): Promise<boolean> {
  return isFile(path.join(commonDir, 'shallow'));
}

/**
 * What the list calls a repository.
 *
 * The path relative to the open folder is what tells nine sibling repositories
 * apart, and it is what a reader recognises: `services/billing` says where the
 * thing is, where `billing` on its own could be any of three. The folder's own
 * name reads better than an empty string when a repository sits at the top of
 * it, and a repository from `repoLedger.additionalRoots` has no folder to be
 * relative to, so it is named after its own directory.
 *
 * Forward slashes even on Windows, matching the sibling extension: the label is
 * a display string rather than a path anything opens, and one spelling means a
 * screenshot, a bug report and a test all read the same on every platform.
 */
export function labelFor(repositoryPath: string, workspaceFolder: string | undefined): string {
  const target = normalizePath(repositoryPath);

  if (workspaceFolder !== undefined) {
    const folder = normalizePath(workspaceFolder);
    if (pathsEqual(target, folder)) {
      return path.basename(folder) || folder;
    }
    // `isPathInside` rather than testing the relative path for a leading `..`:
    // it is the module that owns path identity, it folds case where the
    // filesystem does, and its separator check is what stops `C:\a\bc` from
    // being labelled as though it sat inside `C:\a\b`.
    if (isPathInside(target, folder)) {
      return path.relative(folder, target).split(/[\\/]+/).join('/');
    }
  }
  return path.basename(target) || target;
}
