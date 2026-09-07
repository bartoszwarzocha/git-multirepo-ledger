/**
 * The second-tier read: what is uncommitted in a repository's working tree.
 *
 * This is the only read in the extension that has to walk the working tree, so
 * it is the expensive one and it is deliberately not part of the pass that
 * renders a row. `for-each-ref` answers the first tier for every repository;
 * this fills the dirty count in behind it, for visible rows, when the user has
 * asked for it.
 *
 * ---------------------------------------------------------------------------
 * Why `--no-optional-locks`, and why its position in the argument list matters
 * ---------------------------------------------------------------------------
 *
 * A plain `git status` is not a read. It refreshes the index - restatting every
 * tracked file and rewriting `.git/index` with the fresh stat data - and it
 * takes `index.lock` to do it. Verified in a scratch repository: after touching
 * five tracked files without changing their contents, `git status` moved the
 * mtime of `.git/index`, and `git --no-optional-locks status` left it exactly
 * where it was. This extension promises it never writes anything inside a
 * repository it discovered, and that promise dies on the first status call
 * without this flag - silently, because the rewrite is invisible until it
 * collides with the user's own `git commit` waiting on the same lock.
 *
 * `--no-optional-locks` is a **git-level** option, so it must come before the
 * subcommand. Written the other way round, `git status --porcelain=v2
 * --no-optional-locks` exits **129** with ``error: unknown option
 * `no-optional-locks'``. That failure is the dangerous kind: a non-zero exit
 * lands in the "the repository did not answer" path, so every row would report
 * an unreadable working tree while the flag that was supposed to protect the
 * index was never applied at all. The order has been got wrong once already in
 * this project, which is why `statusArgs` is a function nobody has to retype.
 *
 * ---------------------------------------------------------------------------
 * What this module refuses to guess
 * ---------------------------------------------------------------------------
 *
 * `WorkingTree` has three cases and this module produces all three, because a
 * repository nobody has asked about, a repository that is genuinely clean, and
 * a repository whose answer arrived cut short are three different rows. The
 * counts inside `counted` are therefore only ever produced by a run that
 * finished, exited zero, was not truncated and contained no line this parser
 * did not understand. Everything else is `incomplete` and says why. A short
 * count rendered as a small number is worse than no count, because a small
 * number reads as "nearly clean" and nothing on the row contradicts it.
 */

import type {
  DirtyCounts,
  Divergence,
  HeadState,
  ReadFailure,
  RepositoryKind,
  WorkingTree,
} from '../model/types.ts';
import type { GitResult } from '../util/git.ts';
import { runGit } from '../util/git.ts';
import { log } from '../util/log.ts';

/**
 * A cap on how much `status` output is buffered, and a guard rather than a
 * tuning: nothing measured on any machine chose it.
 *
 * It is derived from the shape of the format. An ordinary changed-entry line
 * carries two forty-character object ids, three six-digit modes and a path, so
 * it runs to roughly 120 bytes; four mebibytes therefore admits tens of
 * thousands of changed paths, which is already far past the point where a
 * number on a row means anything to a reader. What it stops is the pathological
 * case - an untracked tree of hundreds of thousands of files, a `node_modules`
 * nobody ignored - buffering hundreds of megabytes inside the extension host.
 * Reaching the cap reports `incomplete`, never a short count.
 */
const STATUS_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The exact command, in the only order that works.
 *
 * A function rather than an exported array so that a caller cannot mutate the
 * arguments of every future read by sorting or splicing the one it was handed.
 */
export function statusArgs(): string[] {
  // `--branch` costs nothing extra - the headers it adds come out of the same
  // process - and it is what makes this read able to say anything about the
  // upstream at all. `--untracked-files` is left at git's default of `all`
  // deliberately: `normal` collapses an untracked directory into a single
  // entry, so a row would report one untracked "file" for a directory holding
  // two hundred, and the number on the row would disagree with the number the
  // user sees in their own terminal.
  return ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'];
}

/**
 * A bare repository has no working tree, so there is nothing here to read.
 *
 * Verified: `git --no-optional-locks status --porcelain=v2 --branch` in a bare
 * repository exits **128** with `fatal: this operation must be run in a work
 * tree`. The caller checks this rather than spawning and interpreting that
 * failure, because a bare repository is not a repository that failed - asking
 * it about uncommitted changes is asking a question that does not exist.
 *
 * A repository whose kind discovery could not establish is still asked. It may
 * turn out to be bare, in which case git says so and the row carries that
 * reason - which is a better outcome than skipping a repository that was
 * probably readable on the strength of a classification that already failed.
 */
export function canReadWorkingTree(kind: RepositoryKind): boolean {
  return kind !== 'bare';
}

// ---------------------------------------------------------------------------
// What the `# branch.*` headers say
// ---------------------------------------------------------------------------

/**
 * The headers, which arrive free in the same process as the counts.
 *
 * Both fields are optional and that is the point: `--branch` prints
 * `branch.oid` and `branch.head` always, `branch.upstream` only when the branch
 * tracks something, and `branch.ab` only when the tracked ref could actually be
 * resolved. An answer that arrived truncated before the headers, or a caller
 * that dropped `--branch`, leaves both undefined - which reads as "not
 * established" everywhere downstream, and never as a branch called nothing.
 *
 * This is a second opinion, not the authority. The first-tier `for-each-ref`
 * read owns `HeadState` and `Divergence` on the row; what is here exists so a
 * caller can cross-check, or fill a row whose first-tier read failed.
 */
export interface StatusBranch {
  readonly head?: HeadState;
  readonly divergence?: Divergence;
}

/** Everything one `status --porcelain=v2 --branch` run said. */
export interface ParsedStatus {
  readonly counts: DirtyCounts;
  readonly branch: StatusBranch;
  /**
   * Lines this parser did not recognise as any documented record type.
   *
   * Surfaced rather than swallowed because the only ways to get one are a git
   * that has grown a record shape newer than this code, and output that arrived
   * mangled - and both of those mean the counts below may be short. Silently
   * ignoring an unknown line would undercount, and an undercount renders as a
   * repository quieter than it is.
   */
  readonly unrecognized: number;
}

/** The result of running the read, in the shape a row wants. */
export interface StatusRead {
  readonly workingTree: WorkingTree;
  readonly branch: StatusBranch;
  /**
   * Why the working tree is `incomplete`, with the command that produced it.
   *
   * This is deliberately **not** `RepositoryRow.failure`. A row is only
   * `unreadable` when the first-tier read failed; a second-tier read that git
   * refused leaves a perfectly good row that simply cannot say what is
   * uncommitted. Conflating the two would blank a row that has a branch, a last
   * commit and a divergence figure, because a `status` call timed out.
   */
  readonly failure?: ReadFailure;
}

export interface StatusReadOptions {
  /** The working tree directory. git is spawned here. */
  cwd: string;
  /** Skips the spawn entirely for a bare repository. Defaults to `plain`. */
  kind?: RepositoryKind;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * The structural signature of a changed or unmerged entry.
 *
 * Matching on the four-character submodule field rather than on the XY codes is
 * what makes this safe against a path that got onto its own line. That field is
 * documented as `N...` for anything that is not a submodule and `S<c><m><u>`
 * for one that is, with each of the three positions either its letter or a dot;
 * verified against a real submodule, which reported `S.MU`. A stray fragment of
 * a path would have to begin `1 `, `2 ` or `u ` and then carry two arbitrary
 * characters and that exact four-character shape to be miscounted.
 *
 * The XY pair, by contrast, is matched loosely as any two characters. Pinning
 * it to today's letters would mean a git that adds a status code counts the
 * entry as unrecognised - which is safe, but noisier than it needs to be, since
 * all this parser asks of X and Y is whether each is a dot.
 */
const ENTRY = /^([12u]) (..) [NS][C.][M.][U.] /;

/** `+2 -1`. `+? -?` is what `--no-ahead-behind` prints, and is not a number. */
const AHEAD_BEHIND = /^\+(\d+) -(\d+)$/;

/**
 * Read one `status --porcelain=v2` output. Pure, and never throws.
 *
 * Never throwing is a contract rather than a nicety: this runs once per visible
 * repository inside a pass over a whole directory, and an exception on one
 * repository's output would take down the pass and leave every other row
 * unexplained. An input this function cannot make sense of is reported through
 * `unrecognized`, which the caller turns into `incomplete`.
 */
export function parseStatus(stdout: string): ParsedStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  let unrecognized = 0;

  let oid: string | undefined;
  let headName: string | undefined;
  let upstream: string | undefined;
  let ab: string | undefined;
  let sawBranchHeader = false;

  // Records are newline-separated and a path can never split one, because git
  // always quotes a path containing a control character - `core.quotePath` only
  // governs whether bytes above 0x7f are quoted too, which is why a file called
  // `zażółć-gęślą.txt` came back as `"za\305\274..."` by default and unquoted
  // under `-c core.quotePath=false`. `\r?\n` rather than `\n` because nothing
  // in this codebase should depend on git's Windows build not translating its
  // own pipe.
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith('# ')) {
      const space = line.indexOf(' ', 2);
      const key = space === -1 ? line.slice(2) : line.slice(2, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      switch (key) {
        case 'branch.oid':
          oid = value;
          sawBranchHeader = true;
          break;
        case 'branch.head':
          headName = value;
          sawBranchHeader = true;
          break;
        case 'branch.upstream':
          upstream = value;
          sawBranchHeader = true;
          break;
        case 'branch.ab':
          ab = value;
          sawBranchHeader = true;
          break;
        default:
          // A header this module did not ask for - `# stash <n>`, which only
          // appears under `--show-stash`. Skipped rather than counted as
          // unrecognised, because a header nobody read cannot make a count
          // wrong, and marking the whole read incomplete over one would be a
          // lie about the counts that did arrive.
          break;
      }
      continue;
    }

    const entry = ENTRY.exec(line);
    if (entry) {
      const type = entry[1];
      const xy = entry[2] ?? '..';
      if (type === 'u') {
        // An unmerged path's XY is a pair of conflict codes - `UU`, `AA`, `DU`
        // and so on - not a staged/unstaged pair, so it is counted once here
        // and never added to the other two buckets. Counting `UU` as both
        // staged and unstaged would make one conflicted file show up three
        // times across a four-number row.
        conflicted += 1;
      } else {
        // X is what is staged and Y is what is not, and a dot in either
        // position means no change there. `MM` - staged, then edited again in
        // the working tree - is therefore one staged file and one unstaged
        // file, not two of either; `RM` behaves the same way for a rename that
        // was edited after it was staged. Both were verified against real
        // output.
        if (xy[0] !== '.') {
          staged += 1;
        }
        if (xy[1] !== '.') {
          unstaged += 1;
        }
      }
      continue;
    }

    if (line.startsWith('? ') && line.length > 2) {
      untracked += 1;
      continue;
    }

    if (line.startsWith('! ') && line.length > 2) {
      // Ignored. Only ever present under `--ignored`, which `statusArgs` does
      // not pass, and counted nowhere: an ignored file is not dirt, and a row
      // that added it to a total would make every repository with a build
      // directory look like it had uncommitted work.
      continue;
    }

    unrecognized += 1;
  }

  return {
    counts: { staged, unstaged, untracked, conflicted },
    branch: sawBranchHeader ? describeBranch(oid, headName, upstream, ab) : {},
    unrecognized,
  };
}

/**
 * Turn the four headers into the model's two unions.
 *
 * The whole of the difficulty is in what `branch.ab` means by its absence, and
 * that was settled by experiment rather than by reading:
 *
 * - Present with numbers: the tracked ref resolved and this is the arithmetic.
 * - Present as `+? -?`: `--no-ahead-behind` was passed. `statusArgs` never
 *   passes it, but a value of `?` is reported as `unknown` rather than parsed
 *   into a zero, because that is precisely the substitution this model exists
 *   to prevent.
 * - **Absent while `branch.upstream` is present**: the branch tracks a ref git
 *   could not resolve - it was deleted on the remote and pruned locally. That
 *   is `gone`, and the reason it can be claimed rather than guessed is that the
 *   other candidate explanation was checked and eliminated:
 *   `status.aheadBehind=false` does *not* suppress the header in porcelain
 *   output, and `--no-ahead-behind` prints `+? -?` instead of dropping the line.
 * - Absent along with `branch.upstream`: the branch tracks nothing at all.
 */
function describeBranch(
  oid: string | undefined,
  headName: string | undefined,
  upstream: string | undefined,
  ab: string | undefined,
): StatusBranch {
  const head = describeHead(oid, headName);
  if (!head) {
    return {};
  }
  return { head, divergence: describeDivergence(head, upstream, ab) };
}

function describeHead(oid: string | undefined, headName: string | undefined): HeadState | undefined {
  if (headName === undefined || headName.length === 0 || oid === undefined) {
    // Both headers are needed and neither can stand in for the other: the name
    // alone cannot tell a branch with commits from one `git init` made a moment
    // ago, and the oid alone has no name to show. Missing either means the
    // output was cut off before the headers finished, so nothing is claimed.
    return undefined;
  }
  if (headName === '(detached)') {
    // git's literal spelling for a HEAD that is not on a branch, verified.
    return oid === '(initial)' ? undefined : { kind: 'detached', sha: oid };
  }
  if (oid === '(initial)') {
    // `git init` and nothing since: HEAD names a branch that has no commit yet.
    return { kind: 'unborn', name: headName };
  }
  return { kind: 'branch', name: headName };
}

function describeDivergence(
  head: HeadState,
  upstream: string | undefined,
  ab: string | undefined,
): Divergence {
  if (head.kind !== 'branch') {
    // An unborn HEAD has nothing to compare, and a detached HEAD has no branch
    // to carry a tracking configuration. `no-upstream` would be true of both in
    // a literal sense, but it renders as the words "no upstream" beside a row
    // that already says "detached at 7c86ebf" - noise answering a question the
    // reader did not ask. `unknown` renders as silence, which is the honest
    // shape of "there is no such question here".
    return { kind: 'unknown' };
  }
  if (upstream === undefined || upstream.length === 0) {
    return { kind: 'no-upstream' };
  }
  if (ab === undefined) {
    return { kind: 'gone', upstream };
  }
  const parsed = AHEAD_BEHIND.exec(ab.trim());
  if (!parsed) {
    return { kind: 'unknown' };
  }
  const ahead = Number(parsed[1]);
  const behind = Number(parsed[2]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return { kind: 'unknown' };
  }
  return ahead === 0 && behind === 0
    ? { kind: 'in-sync', upstream }
    : { kind: 'diverged', upstream, ahead, behind };
}

// ---------------------------------------------------------------------------
// From a finished process to a row's working tree
// ---------------------------------------------------------------------------

/**
 * Decide what one completed `status` run established. Pure, so every branch
 * below is testable without spawning anything.
 *
 * The order of the checks is the order of severity, and it matters: a killed
 * process reports a nonsensical exit code as well as `timedOut`, so the timeout
 * has to be recognised before the code is, or a repository on a sleeping
 * network share would be reported as one git refused.
 */
export function interpretStatusResult(result: GitResult): StatusRead {
  // Parsed unconditionally, because the `# branch.*` headers are printed before
  // any entry and so survive a read that was cut short. A truncated answer
  // still knows which branch it was on, and throwing that away with the counts
  // would blank a field that is not in doubt.
  const parsed = parseStatus(result.stdout);

  const fail = (summary: string, reason: string): StatusRead => ({
    workingTree: { kind: 'incomplete', reason },
    branch: parsed.branch,
    failure: { command: result.command, stderr: result.stderr.trim(), summary },
  });

  if (result.timedOut) {
    return fail('timed out', 'git did not finish reading the working tree in time.');
  }

  if (result.code !== 0) {
    return fail(summarizeStderr(result), stderrReason(result));
  }

  if (result.truncated) {
    return fail(
      'output too large',
      'The list of changes reached the size limit this reader accepts, so the counts would be short.',
    );
  }

  if (parsed.unrecognized > 0) {
    return fail(
      'unrecognised output',
      `git printed ${parsed.unrecognized} line${parsed.unrecognized === 1 ? '' : 's'} in a shape this reader does not know, so the counts may be short.`,
    );
  }

  return { workingTree: { kind: 'counted', counts: parsed.counts }, branch: parsed.branch };
}

/**
 * A short reason for the row, taken from git's own words where they are
 * recognisable.
 *
 * The three cases below are matched on substrings of git's English messages,
 * which is fragile in exactly one direction: a git speaking another language
 * falls through to the generic sentence, which is still true and still carries
 * the exit code. It never produces a wrong reason, only a vaguer one.
 */
function summarizeStderr(result: GitResult): string {
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes('dubious ownership')) {
    return 'git refused this directory';
  }
  if (stderr.includes('must be run in a work tree')) {
    return 'no working tree';
  }
  if (stderr.includes('not a git repository')) {
    return 'not a git repository';
  }
  return `git exited ${result.code}`;
}

function stderrReason(result: GitResult): string {
  const first = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  // git's own sentence is quoted rather than paraphrased, for the same reason
  // `ReadFailure.command` exists: the user's way of checking a row they do not
  // believe is to retype the command and compare what it says.
  return first === undefined
    ? `git exited ${result.code} without saying why.`
    : `git exited ${result.code}: ${first}`;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * Run the second-tier read for one repository.
 *
 * Rejects only with `GitMissingError`, and deliberately: git being absent from
 * PATH is not this repository's failure, it disables every row at once, and the
 * controller reports it once as a list status rather than as a per-row reason.
 * Every other outcome - a refusal, a timeout, output nobody can parse - comes
 * back as an `incomplete` working tree carrying the command that produced it.
 */
export async function readWorkingTree(options: StatusReadOptions): Promise<StatusRead> {
  const kind = options.kind ?? 'plain';
  if (!canReadWorkingTree(kind)) {
    // Not `incomplete`: nothing was attempted and nothing failed. `not-read` is
    // the value that says "no answer here", and it is already what every row
    // carries until this read runs, so a bare repository simply keeps it. The
    // alternative - a fourth `WorkingTree` case for "no working tree" - would
    // make every consumer in the codebase handle a state that renders as
    // exactly the same silence.
    return { workingTree: { kind: 'not-read' }, branch: {} };
  }

  const result = await runGit(statusArgs(), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes ?? STATUS_MAX_BYTES,
    signal: options.signal,
  });

  const read = interpretStatusResult(result);
  if (read.workingTree.kind === 'incomplete') {
    // Logged once here rather than at every call site, because the machines
    // this matters on are ones nobody here can reach, and a row that says
    // "could not read the working tree" is only debuggable if the log says
    // which repository and what git actually printed.
    log.warn(`${options.cwd}: ${read.workingTree.reason}`);
  }
  return read;
}
