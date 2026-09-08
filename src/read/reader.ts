/**
 * From discovered repositories to rows: the pass that runs git, in two tiers.
 *
 * `refs.ts`, `status.ts`, `gitState.ts` and `classify.ts` each answer one
 * question about one repository. This module is what turns them into a pass over
 * a whole directory: it decides how many reads are in flight, what a repository
 * costs, when a read is abandoned, and what a row says when git will not answer.
 * It owns no parsing of its own - every string it produces about git's output
 * came from one of those four - and it imports no `vscode`, so the whole of it
 * runs under `node --test`.
 *
 * ---------------------------------------------------------------------------
 * Two tiers, and why the first one is the one that matters
 * ---------------------------------------------------------------------------
 *
 * **Tier one** is one `for-each-ref` process (`refs.ts`) beside a handful of
 * `stat`s and one directory listing (`gitState.ts`). It produces a complete row
 * except for one field: what is uncommitted in the working tree. It is what
 * makes the list appear, and it costs one process per repository however large
 * the working tree is.
 *
 * **Tier two** is `git status` (`status.ts`), which is the only read in the
 * extension that walks the working tree. Its cost is proportional to the number
 * of tracked and untracked files rather than to the number of repositories, so
 * on a large checkout or a network share it is the read that would make a board
 * feel slow. It is therefore opt-in (`multirepoLedger.dirty.enabled`) and it runs
 * only for the rows the caller asks about - in practice, the ones on screen.
 *
 * The two costs are orthogonal: `for-each-ref` scales with ref count and
 * `status` with file count, so neither is universally the cheap one, and the
 * only lever either way is how many processes are spawned.
 *
 * ---------------------------------------------------------------------------
 * Nothing here writes
 * ---------------------------------------------------------------------------
 *
 * Every command this module runs is a read, and the arguments come from
 * `refs.ts` and `status.ts` rather than being spelled here, so the
 * `--no-optional-locks` that keeps `git status` from rewriting `.git/index`
 * cannot be lost by a caller assembling its own argument list. Nothing in this
 * file passes `-c safe.directory=<path>` to make a refused repository readable:
 * that one argument deliberately defeats a control that exists to stop a
 * repository sitting in a directory somebody else can write from executing
 * attacker-controlled configuration - `core.pager`, `core.hooksPath`,
 * `core.fsmonitor` and aliases among it, all of which are commands. An
 * extension whose premise is reading repositories the user has *not* opened is
 * the worst possible place to hold that switch. The refusal is reported instead,
 * in git's own words, and the user decides in their own shell.
 */

import * as os from 'node:os';

import type {
  DiscoveredRepository,
  ReadFailure,
  RepositoryRow,
} from '../model/types.ts';
import type { GitResult } from '../util/git.ts';
import { GitMissingError, formatCommand, isGitAvailable, runGit } from '../util/git.ts';
import { describeError, log } from '../util/log.ts';
import { readGitState, type GitState } from './gitState.ts';
import {
  headCommitArgs,
  headSymrefArgs,
  parseHeadCommit,
  parseRefs,
  refsCommand,
  type RefsCommand,
  type RefsRead,
} from './refs.ts';
import { readWorkingTree } from './status.ts';

// ---------------------------------------------------------------------------
// How many reads are in flight
// ---------------------------------------------------------------------------

/**
 * The fewest reads in flight, whatever the machine says about itself.
 *
 * A row costs a **process spawn** and then waiting on the filesystem; it does
 * not cost arithmetic. So a machine that reports one usable CPU - a container
 * with a quota, a constrained remote, a laptop with the extension host pinned to
 * one core - must not read two hundred repositories one after another, because
 * it would spend the whole pass idle between spawns. This floor is not a
 * measurement and no machine's core count contributed to it: it is the smallest
 * number at which a single-CPU report cannot serialise the board.
 */
export const CONCURRENCY_FLOOR = 4;

/**
 * The most reads in flight when the number is derived rather than chosen.
 *
 * Every unit in flight is a child process holding handles, and on a network
 * share an outstanding request as well. Unbounded fan-out is how an extension
 * turns a slow disk into a window that stops repainting, and the operating
 * system's own limiter is exhaustion. Like the floor this is a stated guard
 * rather than a tuned figure - a concurrency measured on one machine's disk and
 * core count would be wrong on every other machine, which is the mistake this
 * project has already made once and recorded.
 */
export const CONCURRENCY_CEILING = 16;

/**
 * The most reads in flight when the user chooses the number themselves.
 *
 * `multirepoLedger.concurrency` overrides the derivation entirely, because the person
 * with the network share is better placed to know what it can take than any
 * derivation is. This cap is not a second opinion about their machine: it is the
 * point past which a setting stops being a preference and becomes a fork bomb
 * inside the extension host, which is shared with every other extension in the
 * window. A value above it is honoured up to here and the log says so.
 */
export const CONCURRENCY_MAX = 64;

/**
 * How long one repository gets before its row says it did not answer.
 *
 * The same ten seconds `runGit` defaults to, restated here because the row has
 * to be able to *say* the number - "did not answer in 10 s" - and a sentence
 * quoting a constant it did not use would eventually be wrong. It is a guard
 * against a repository on a sleeping network share or a filesystem that has
 * stopped answering, not a budget: a repository that needs nine seconds is
 * pathological, and one that needs eleven is not answering.
 */
export const DEFAULT_ROW_TIMEOUT_MS = 10_000;

export interface ConcurrencyInput {
  /** `multirepoLedger.concurrency`. Zero, absent or nonsense means "derive it". */
  readonly configured?: number;
  /** What the runtime reports. Injected by tests; otherwise read from `os`. */
  readonly cpuCount?: number;
}

/**
 * How many repositories to read at once.
 *
 * Derived, never a literal, and the derivation is the whole point: a number
 * tuned on the machine this was written on would be wrong on a two-core laptop,
 * wrong on a thirty-two-core workstation, and wrong again on a remote where the
 * repositories are on a share and the cores are irrelevant. What a row actually
 * costs is a process spawn and a wait, so the count derives from what the
 * runtime says it can run at once, clamped by two guards that each name the
 * failure they prevent, and is replaced outright by the setting when the user
 * has one.
 */
export function deriveConcurrency(input: ConcurrencyInput = {}): number {
  const configured = input.configured;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 1) {
    const chosen = Math.min(Math.floor(configured), CONCURRENCY_MAX);
    if (chosen < Math.floor(configured)) {
      log.warn(
        `multirepoLedger.concurrency is ${configured}; ${CONCURRENCY_MAX} reads at once is the most this extension will hold open, so that is what it will use`,
      );
    }
    return chosen;
  }
  const reported = input.cpuCount ?? runtimeParallelism();
  const usable = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : CONCURRENCY_FLOOR;
  return Math.min(Math.max(usable, CONCURRENCY_FLOOR), CONCURRENCY_CEILING);
}

/**
 * What the runtime says it can run at once.
 *
 * `availableParallelism` rather than `cpus().length`: it accounts for CPU
 * affinity and container quotas, and those are exactly the machines where the
 * two disagree - a host pinned to two cores still reports every core the
 * hardware has through `cpus()`. The fallback is for a Node that predates the
 * function rather than for a machine that lacks the information.
 */
function runtimeParallelism(): number {
  const available =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Number.isFinite(available) && available >= 1 ? Math.floor(available) : CONCURRENCY_FLOOR;
}

// ---------------------------------------------------------------------------
// A bounded pass over a list
// ---------------------------------------------------------------------------

/**
 * Run `work` over every item with at most `limit` of them in flight, stopping
 * between two items when the signal aborts. Resolves `true` when every item was
 * taken and `false` when the signal ended it early.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than slicing the
 * list into batches of `limit` and awaiting each batch: a batch finishes at the
 * speed of its slowest member, so one repository on a sleeping share would hold
 * back the fifteen beside it and the board would fill in visible steps instead
 * of continuously.
 *
 * `work` is expected never to reject - each caller below wraps its own body -
 * because one repository must not be able to end a pass over two hundred.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Checked before *taking* an item rather than after finishing one, so an
      // abort stops the pass spawning anything further rather than merely
      // stopping it reporting.
      if (signal?.aborted === true) {
        stopped = true;
        return;
      }
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await work(item);
    }
  };

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return !stopped;
}

// ---------------------------------------------------------------------------
// What a pass reports about itself
// ---------------------------------------------------------------------------

/**
 * What a finished pass says about itself. Deliberately **not** the rows.
 *
 * Rows leave through the callback as they resolve, so a promise that also
 * carried them would offer a second, tidier-looking way to use this module -
 * `const rows = await readRows(...)` - whose whole effect is to hold every row
 * back until the slowest repository has answered. A directory of two hundred
 * repositories must fill in progressively or the board is blank for as long as
 * its worst member takes, so the shape that would allow that is not offered.
 */
export interface PassOutcome {
  /** Rows handed to the callback. Rows of a superseded pass are not counted. */
  readonly emitted: number;
  /** Rows that carry a `failure`, which is a subset of `emitted`. */
  readonly unreadable: number;
  /** The caller's signal aborted before the pass finished. */
  readonly aborted: boolean;
  /** How many reads were in flight, after the derivation and the setting. */
  readonly concurrency: number;
  /**
   * The whole pass was disabled for one stated reason, rather than every
   * repository failing separately. `no-git` is the only value today.
   */
  readonly disabled?: 'no-git';
}

export interface RowPassOptions {
  readonly repositories: readonly DiscoveredRepository[];
  /**
   * Called once per row, as it resolves.
   *
   * Never called for a row whose pass was superseded: a cancelled pass's answers
   * are dropped at this boundary rather than merged into whatever replaced it,
   * because a board mixing rows read before a folder change with rows read after
   * it is a list nobody can explain.
   */
  readonly onRow: (row: RepositoryRow) => void;
  readonly signal?: AbortSignal;
  /** `multirepoLedger.concurrency`. Zero or absent derives it. */
  readonly concurrency?: number;
  /** Test seam for the derivation; otherwise the runtime is asked. */
  readonly cpuCount?: number;
  /** Per repository, not per pass. Defaults to `DEFAULT_ROW_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface DirtyPassOptions {
  /** The rows to fill in, which is the caller's decision and usually "the visible ones". */
  readonly rows: readonly RepositoryRow[];
  /** Called only for a row that gained something, so an unasked repository is not re-emitted. */
  readonly onRow: (row: RepositoryRow) => void;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly cpuCount?: number;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Tier one: the pass that makes the list appear
// ---------------------------------------------------------------------------

/**
 * Read every repository and hand each row to `onRow` as it resolves.
 *
 * git being absent from `PATH` is answered once, before anything is spawned, and
 * disables the pass with one stated reason. The alternative - letting every
 * repository fail on its own - produces a board of two hundred identical
 * unreadable rows for a fact that is about the machine and not about any
 * repository on it.
 */
export async function readRows(options: RowPassOptions): Promise<PassOutcome> {
  const concurrency = deriveConcurrency({
    ...(options.concurrency !== undefined ? { configured: options.concurrency } : {}),
    ...(options.cpuCount !== undefined ? { cpuCount: options.cpuCount } : {}),
  });

  if (!(await isGitAvailable())) {
    log.info(
      'git is not on PATH, so nothing was read; the list says that once rather than marking every repository unreadable',
    );
    return { emitted: 0, unreadable: 0, aborted: false, concurrency, disabled: 'no-git' };
  }

  // Asked once here rather than left to the pool. `refsCommand` caches the
  // capability probe, so every worker would get the same answer either way, but
  // asking first means the probe process runs before any repository read rather
  // than inside the first `concurrency` of them - and it gives the failure path
  // below the exact command it would have run.
  const command = await refsCommand();

  // An internal controller so that git disappearing part way through stops the
  // rest of the pass - and kills the children already running - without needing
  // the caller to have passed a signal. Combined with the caller's signal rather
  // than replacing it, so both can end the pass.
  const stop = new AbortController();
  const signal =
    options.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, options.signal]);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;

  let emitted = 0;
  let unreadable = 0;
  let missing = false;
  const started = Date.now();

  await forEachBounded(
    options.repositories,
    concurrency,
    async (repository) => {
      let row: RepositoryRow;
      try {
        row = await readRow(repository, { signal, timeoutMs });
      } catch (error) {
        if (error instanceof GitMissingError) {
          // git was there when the pass started and is not there now. One reason
          // for the pass, as above, rather than one failure per repository.
          missing = true;
          stop.abort();
          return;
        }
        // `readRow` turns everything else into a row, so reaching here at all
        // means something outside the read failed. The repository still gets a
        // row, because a repository that vanishes from the board is
        // indistinguishable from one that was never there.
        log.error(`${repository.path}: the row read failed`, error);
        row = unreadableRow(repository, { fetch: { kind: 'no-record' } }, {
          command: formatCommand(command.args),
          stderr: describeError(error),
          summary: 'the read could not be run',
        });
      }

      // Two reasons to drop an answer that has already arrived. A superseded
      // pass's rows are dropped rather than merged into whatever replaced them;
      // and once git has gone missing, the reads that were already in flight
      // come back as killed processes, and publishing each of those as its own
      // unreadable row would spend two hundred rows saying the one thing the
      // pass is about to say once.
      if (options.signal?.aborted === true || missing) {
        return;
      }
      emitted += 1;
      if (row.failure) {
        unreadable += 1;
        log.warn(`${repository.path}: ${row.failure.summary} (${row.failure.command})`);
      }
      options.onRow(row);
    },
    signal,
  );

  const aborted = options.signal?.aborted === true;
  if (!missing) {
    log.info(
      `read ${emitted} of ${options.repositories.length} repositories in ${Date.now() - started} ms, ${concurrency} at a time` +
        (unreadable > 0 ? `, ${unreadable} unreadable` : '') +
        (aborted ? ' (superseded, and its rows were dropped)' : ''),
    );
  }

  return {
    emitted,
    unreadable,
    aborted,
    concurrency,
    ...(missing ? { disabled: 'no-git' as const } : {}),
  };
}

export interface RowReadOptions {
  readonly signal?: AbortSignal;
  /** The whole repository's budget, shared across every process it takes. */
  readonly timeoutMs?: number;
}

/**
 * One repository's tier-one row.
 *
 * Returns a row for every repository, always. It rejects for exactly one thing -
 * git missing from `PATH` - because that is a fact about the machine that
 * disables the whole pass, and everything else is a fact about this repository
 * that belongs on its row.
 *
 * The timeout is per **repository**, not per process. Nearly every repository
 * costs one process, but the fallback path for a git without
 * `--include-root-refs` can cost three, and three independent ten-second
 * timeouts would let one repository hold a worker for half a minute. So the
 * budget is set once and each process gets what is left of it; when nothing is
 * left the remaining processes are not spawned and the row says what it could
 * not establish.
 */
export async function readRow(
  repository: DiscoveredRepository,
  options: RowReadOptions = {},
): Promise<RepositoryRow> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;
  const startedAt = Date.now();
  const remaining = (): number => timeoutMs - (Date.now() - startedAt);

  // Started before the process and awaited after it. Everything it answers -
  // the operation left running, the fetch evidence - comes off the filesystem,
  // so running it beside the spawn costs nothing and running it afterwards would
  // add its latency to every row.
  const statePromise = readGitState(repository.gitDir);
  const command = await refsCommand();

  try {
    const result = await runGit(command.args, {
      cwd: repository.path,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const state = await statePromise;

    const failure = classifyFailure(result, timeoutMs);
    if (failure) {
      return unreadableRow(repository, state, failure);
    }

    let read = parseRefs(result.stdout, {
      form: command.form,
      truncated: result.truncated,
    });

    // Neither form of the read can name an unborn branch from its own output - a
    // branch with no commits has no ref to print - and the `heads-only` form
    // cannot tell an unborn HEAD from a detached one at all. Both are the same
    // shape here: nothing was established about HEAD. `refs.ts` documents what
    // each further process buys; this is the caller that decides they are worth
    // spending, and they are, because they are only ever spent on a repository
    // that is unborn or detached on an old git.
    if (read.head.kind === 'unknown' && read.incomplete === undefined) {
      read = await establishHead({
        repository,
        command,
        result,
        read,
        remaining,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }

    if (read.head.kind === 'unknown') {
      return unresolvedHeadRow(repository, state, read, command, result);
    }
    return readRowOf(repository, state, read);
  } catch (error) {
    if (error instanceof GitMissingError) {
      throw error;
    }
    // The process could not be run at all: a working directory that disappeared
    // between discovery and the read, a handle limit, a spawn the platform
    // refused. This is the one place `ReadFailure.stderr` does not hold git's
    // own words, because there was no git to produce any; the sentence says so
    // by naming the command that was never run.
    return unreadableRow(repository, await statePromise, {
      command: formatCommand(command.args),
      stderr: describeError(error),
      summary: 'the read could not be run',
    });
  }
}

/** What `establishHead` needs; grouped so the argument list stays readable. */
interface HeadResolution {
  readonly repository: DiscoveredRepository;
  readonly command: RefsCommand;
  readonly result: GitResult;
  readonly read: RefsRead;
  readonly remaining: () => number;
  readonly signal?: AbortSignal;
}

/**
 * Spend one or two further processes on the repositories whose HEAD the ref
 * listing could not name, and re-parse the same output with the answer.
 *
 * `git symbolic-ref -q HEAD` separates the two cases that look alike: it exits 0
 * printing the branch name when HEAD names a branch - which, given no branch row
 * carried the marker, means that branch has no commits yet - and exits 1
 * printing nothing when HEAD is detached. Only the second case needs the third
 * process, and only on a git without `--include-root-refs`, where no `HEAD` row
 * was ever listed to carry the commit.
 *
 * The output is re-parsed rather than patched. `parseRefs` is where every
 * decision about this output is made, including "no marker plus a name means
 * unborn", and a second place that assembled a `RefsRead` from the same evidence
 * would be a second chance to reach a different conclusion about one repository.
 * Re-parsing is a string split over output already in hand.
 */
async function establishHead(context: HeadResolution): Promise<RefsRead> {
  const { repository, command, result, read, remaining, signal } = context;
  const options = { form: command.form, truncated: result.truncated } as const;

  if (remaining() <= 0) {
    return read;
  }
  const symref = await runGit(headSymrefArgs(), {
    cwd: repository.path,
    timeoutMs: remaining(),
    ...(signal ? { signal } : {}),
  });

  const name = symref.stdout.trim();
  if (symref.code === 0 && name.length > 0) {
    const named = parseRefs(result.stdout, { ...options, unbornName: name });
    if (named.head.kind !== 'unknown') {
      return named;
    }
  }

  // HEAD is not a symbolic ref, so it is detached - and on the one-process form
  // a detached HEAD is already on its own row, which means this can only be
  // reached from the legacy form. The commit is what line 2 of the row exists to
  // show, so it is worth the third process; `refs.ts` says why three is the
  // ceiling and why this narrow case may have it.
  if (command.form !== 'heads-only' || remaining() <= 0) {
    return read;
  }
  const commit = await runGit(headCommitArgs(), {
    cwd: repository.path,
    timeoutMs: remaining(),
    ...(signal ? { signal } : {}),
  });
  if (commit.code !== 0) {
    return read;
  }
  const headCommit = parseHeadCommit(commit.stdout);
  return headCommit === undefined ? read : parseRefs(result.stdout, { ...options, headCommit });
}

// ---------------------------------------------------------------------------
// Tier two: what is uncommitted, filled in behind the list
// ---------------------------------------------------------------------------

/**
 * Fill the working-tree count in for the rows the caller asked about.
 *
 * Only rows that gained something are handed back: a bare repository has no
 * working tree to count and an unreadable row has no commit to count against, so
 * neither is re-emitted and neither costs a process. That is what keeps the
 * distinction this model rests on intact at the far end - a row still carrying
 * `not-read` after this pass is a row nobody counted, which is a different thing
 * from a row counted as clean, and the two must not arrive looking alike.
 */
export async function readDirtyState(options: DirtyPassOptions): Promise<PassOutcome> {
  const concurrency = deriveConcurrency({
    ...(options.concurrency !== undefined ? { configured: options.concurrency } : {}),
    ...(options.cpuCount !== undefined ? { cpuCount: options.cpuCount } : {}),
  });

  if (!(await isGitAvailable())) {
    return { emitted: 0, unreadable: 0, aborted: false, concurrency, disabled: 'no-git' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;
  let emitted = 0;
  const started = Date.now();

  await forEachBounded(
    options.rows,
    concurrency,
    async (row) => {
      let filled: RepositoryRow | undefined;
      try {
        filled = await fillDirtyState(row, {
          timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (error instanceof GitMissingError) {
          return;
        }
        // A second-tier failure leaves a perfectly good row: it has a branch, a
        // last commit and a divergence figure, and it simply cannot say what is
        // uncommitted. Blanking it here would spend a whole row on a `status`
        // that timed out.
        log.warn(`${row.repository.path}: the working tree could not be read: ${describeError(error)}`);
        return;
      }
      if (filled === undefined || options.signal?.aborted === true) {
        return;
      }
      emitted += 1;
      options.onRow(filled);
    },
    options.signal,
  );

  const aborted = options.signal?.aborted === true;
  log.info(
    `read the working tree of ${emitted} of ${options.rows.length} rows in ${Date.now() - started} ms, ${concurrency} at a time` +
      (aborted ? ' (superseded, and its answers were dropped)' : ''),
  );

  return { emitted, unreadable: 0, aborted, concurrency };
}

interface DirtyReadOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * One row with its working tree filled in, or `undefined` when there was
 * nothing to ask.
 *
 * Whether a repository has a working tree at all is `status.ts`'s decision and
 * is left there: `readWorkingTree` answers `not-read` without spawning anything
 * for a bare repository, and this reads that answer rather than repeating the
 * test. An unreadable row is skipped here instead, because that is a fact about
 * this pass rather than about the repository - git already refused it once in
 * this generation, and a second process would buy the same refusal.
 *
 * Nothing else on the row is touched. The counts describe the working tree *now*
 * and the rest of the row describes it as tier one found it, which for a
 * repository somebody switched branches in between the two reads means the row
 * is briefly a composite; the next pass settles it. Refusing the count over that
 * would throw away a true answer to avoid a transient one.
 */
export async function fillDirtyState(
  row: RepositoryRow,
  options: DirtyReadOptions = {},
): Promise<RepositoryRow | undefined> {
  if (row.failure) {
    return undefined;
  }
  const read = await readWorkingTree({
    cwd: row.repository.path,
    kind: row.repository.kind,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (read.workingTree.kind === 'not-read') {
    return undefined;
  }
  return { ...row, workingTree: read.workingTree };
}

// ---------------------------------------------------------------------------
// What went wrong
// ---------------------------------------------------------------------------

/**
 * Why the ref listing could not be believed, or `undefined` when it can.
 *
 * Pure, and separated from the process that produced it so that every branch
 * below is reachable from a test without arranging for a repository to hang, to
 * be owned by somebody else, or to be missing.
 *
 * The order is the order of severity and it matters: a killed process reports a
 * nonsensical exit code *as well as* `timedOut`, so the timeout has to be
 * recognised first or a repository on a sleeping share would be reported as one
 * git refused.
 */
export function classifyFailure(result: GitResult, timeoutMs: number): ReadFailure | undefined {
  if (result.timedOut) {
    return {
      command: result.command,
      stderr: result.stderr.trim(),
      summary: `did not answer in ${formatDuration(timeoutMs)}`,
    };
  }
  if (result.code !== 0) {
    return {
      command: result.command,
      stderr: result.stderr.trim(),
      summary: summarize(result),
    };
  }
  return undefined;
}

/**
 * A short reason for the row, in as few words as the row has room for.
 *
 * The dubious-ownership case keys on the **config key** `safe.directory` and not
 * on the English sentence around it. git marks that message for translation, and
 * a build that speaks another language exists; the config key does not change,
 * so this is the one token in the message that can be relied on. The other two
 * cases do match English, and the consequence of a translated build is that they
 * fall through to the exit code - vaguer, never wrong, and the full stderr
 * travels with the row either way.
 */
function summarize(result: GitResult): string {
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes('safe.directory') || stderr.includes('dubious ownership')) {
    // Worded to match what the row prints - "not readable - git refused: dubious
    // ownership" - and deliberately without a remedy attached: the fix is a
    // command the user runs in their own shell, where the whole sentence is in
    // front of them, and this extension never runs it and never offers to.
    return 'git refused: dubious ownership';
  }
  if (stderr.includes('not a git repository')) {
    return 'not a git repository';
  }
  if (stderr.includes('must be run in a work tree')) {
    return 'no working tree';
  }
  return `git exited ${result.code}`;
}

/** `10 s`, `1.5 s`, `250 ms` - whichever reads as a number a person would say. */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// Assembling the row
// ---------------------------------------------------------------------------

function readRowOf(
  repository: DiscoveredRepository,
  state: GitState,
  read: RefsRead,
): RepositoryRow {
  // Each optional field is spread in only when it exists rather than assigned as
  // `undefined`, so an absent key means what it means everywhere else in this
  // model: nobody established this.
  return {
    repository,
    head: read.head,
    divergence: read.divergence,
    ...(state.operation ? { operation: state.operation } : {}),
    ...(read.lastCommit ? { lastCommit: read.lastCommit } : {}),
    // Always `not-read` from tier one, and never a zero: the second-tier read is
    // what establishes this, and until it has run the row is a row nobody has
    // counted rather than a row counted as clean.
    workingTree: { kind: 'not-read' },
    fetch: state.fetch,
    ...(state.remoteUrl === undefined ? {} : { remoteUrl: state.remoteUrl }),
    ...(read.incomplete ? { incomplete: read.incomplete } : {}),
  };
}

function unreadableRow(
  repository: DiscoveredRepository,
  state: GitState,
  failure: ReadFailure,
): RepositoryRow {
  // The operation and the fetch evidence are kept even here. Both were
  // established from the filesystem without asking git anything, so they are as
  // true on a repository git refused as on any other, and dropping them would
  // discard a fact because a different question failed.
  return {
    repository,
    head: { kind: 'unknown' },
    divergence: { kind: 'unknown' },
    ...(state.operation ? { operation: state.operation } : {}),
    workingTree: { kind: 'not-read' },
    fetch: state.fetch,
    ...(state.remoteUrl === undefined ? {} : { remoteUrl: state.remoteUrl }),
    failure,
  };
}

/**
 * The row for a read that finished and still could not say where HEAD points.
 *
 * There are two of these and they need different rows. A repository that is
 * **unborn** has an answer - `git init` and nothing since - and only its branch
 * name is missing, which happens when the process that would have recovered the
 * name was refused or ran out of the repository's budget. That row says the
 * fact without the name rather than saying nothing.
 *
 * Anything else here means the listing arrived truncated or carried a record
 * this reader could not read, and nothing about HEAD survived it. That row is
 * reported as unreadable and not as unknown, and the distinction is the point:
 * `unknown` is the state of a row nobody has got to yet, and a board that files
 * a finished, failed read under it tells its reader it is still working when it
 * is not.
 */
function unresolvedHeadRow(
  repository: DiscoveredRepository,
  state: GitState,
  read: RefsRead,
  command: RefsCommand,
  result: GitResult,
): RepositoryRow {
  if (read.unborn) {
    return readRowOf(repository, state, { ...read, head: { kind: 'unborn', name: '' } });
  }
  return unreadableRow(repository, state, {
    command: formatCommand(command.args),
    stderr: result.stderr.trim(),
    summary: read.incomplete
      ? 'the ref listing did not answer for HEAD'
      : 'git answered, but nothing about HEAD could be read',
  });
}
