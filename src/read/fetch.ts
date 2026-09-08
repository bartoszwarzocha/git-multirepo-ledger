/**
 * The one thing this extension runs that is not a read.
 *
 * Everything else here answers questions about a repository. `git fetch` adds
 * to one: it writes remote-tracking refs, `FETCH_HEAD` and objects into `.git`.
 * It is in this project anyway, and no other write is, because of what it
 * cannot do - it does not touch the working tree, the branches you are on, or
 * any commit you have made. Nothing it does can lose work, and nothing it does
 * can conflict.
 *
 * It is here because without it half the board is a claim about the past. The
 * ahead/behind figures are computed against remote-tracking refs, which are
 * exactly as old as the last fetch: twenty rows can read "in sync" while none
 * of those repositories has asked its server anything for a month. The row
 * already admits this - `FetchEvidence` reports when a fetch was last attempted
 * and says `no-record` rather than pretending - and this is what lets a reader
 * do something about it.
 *
 * What it deliberately is not: `pull`, `rebase`, `push` or `--prune`. Those
 * reach into the working tree, publish, or delete. Run across twenty
 * repositories at once, a conflict in three of them leaves three half-merged
 * trees nobody asked for and nothing on screen saying so. The row already hands
 * those off to somewhere a person is looking at one repository - the SCM view,
 * or a terminal opened in it.
 */

import type { DiscoveredRepository } from '../model/types.ts';
import { runGit, formatCommand } from '../util/git.ts';
import { forEachBounded } from './reader.ts';

/**
 * How long one fetch may take.
 *
 * A guard, not a measurement. Generous, because a first fetch of a large
 * repository over a slow link is legitimate work and killing it at ten seconds
 * would report a failure that is really impatience. A reader who does not want
 * to wait cancels, which is why the progress is cancellable.
 */
export const FETCH_TIMEOUT_MS = 120_000;

/**
 * Exactly `git fetch`, with nothing added.
 *
 * Not `--all`: git's own default fetches the remote the current branch tracks,
 * falling back to `origin`, which is precisely the remote the row's divergence
 * is measured against. Fetching every configured remote would do work nobody
 * asked for on repositories that have several.
 *
 * Not `--prune`: pruning deletes remote-tracking refs, and a button whose name
 * is "fetch" must not delete anything.
 *
 * And not `--no-optional-locks`, which every other command here carries. That
 * flag exists to stop a *read* from rewriting `.git/index`; this is not a read,
 * and putting it here would suggest otherwise. What a reader sees reported is
 * the command they would have typed.
 */
export function fetchArgs(): string[] {
  return ['fetch'];
}

/**
 * The environment a fetch runs in, given the one the extension host has.
 *
 * The whole point is that a repository wanting credentials **fails**, quickly,
 * instead of hanging. A spawned git has no terminal, so a password prompt would
 * wait for input that can never arrive - and twenty of those at once is an
 * extension that appears to have frozen.
 *
 *   - `GIT_TERMINAL_PROMPT=0` turns the terminal prompt into an immediate
 *     error, which is the same thing the editor's built-in git extension does.
 *   - `GIT_ASKPASS` and `SSH_ASKPASS` are *removed* rather than set to
 *     something that fails: an empty value is a value, and git would try to run
 *     it. Removed, git falls through to the terminal prompt, which the line
 *     above has already disabled.
 *   - ssh gets `BatchMode=yes` so it refuses rather than waiting on a
 *     passphrase or an unknown host key - but only when the environment does
 *     not already say how to run ssh. Somebody who has set `GIT_SSH_COMMAND`
 *     knows something about their setup that this does not, and appending
 *     options to a command string of unknown shape would break it.
 */
export function fetchEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['GIT_ASKPASS'];
  delete env['SSH_ASKPASS'];
  env['GIT_TERMINAL_PROMPT'] = '0';
  if (env['GIT_SSH_COMMAND'] === undefined || env['GIT_SSH_COMMAND'].length === 0) {
    env['GIT_SSH_COMMAND'] = 'ssh -oBatchMode=yes';
  }
  return env;
}

/** Why a fetch did not happen. */
export type FetchReason =
  /** git wanted credentials and was not allowed to ask for them. */
  | 'credentials'
  /** The server could not be reached at all. */
  | 'unreachable'
  /** It ran past the guard above. */
  | 'timed-out'
  /** Anything else. git's own words are carried alongside. */
  | 'refused';

export interface FetchFailure {
  readonly label: string;
  readonly path: string;
  readonly reason: FetchReason;
  /** The command as a user could retype it. */
  readonly command: string;
  /** git's own words, never paraphrased. */
  readonly stderr: string;
}

/**
 * A guess at *why*, over an answer that is never a guess.
 *
 * The classification exists so the summary can say "three need credentials"
 * rather than "three failed", and it is matched on substrings of git's English
 * messages - which is fragile, because git is translated. So it is only ever a
 * label: every failure carries git's own stderr and the exact command, and the
 * reader is never shown this judgement instead of the evidence. When nothing
 * matches, the answer is `refused`, which claims nothing.
 */
export function classifyFetch(result: {
  readonly code: number;
  readonly stderr: string;
  readonly timedOut: boolean;
}): FetchReason | undefined {
  if (result.timedOut) {
    return 'timed-out';
  }
  if (result.code === 0) {
    return undefined;
  }

  const stderr = result.stderr.toLowerCase();
  const has = (...needles: readonly string[]): boolean =>
    needles.some((needle) => stderr.includes(needle));

  if (
    has(
      'terminal prompts disabled',
      'could not read username',
      'could not read password',
      'authentication failed',
      'permission denied (publickey',
      'host key verification failed',
      'invalid username or password',
    )
  ) {
    return 'credentials';
  }
  if (
    has(
      'could not resolve host',
      'connection timed out',
      'connection refused',
      'network is unreachable',
      'could not connect to server',
      'failed to connect to',
    )
  ) {
    return 'unreachable';
  }
  return 'refused';
}

export interface FetchReport {
  /** Repositories a `git fetch` was actually run in. */
  readonly attempted: number;
  readonly fetched: number;
  /** Repositories with nothing configured to fetch from. */
  readonly skipped: number;
  readonly failures: readonly FetchFailure[];
  /** The reader stopped it; what is reported is what finished first. */
  readonly cancelled: boolean;
}

export interface FetchRequest {
  readonly repositories: readonly DiscoveredRepository[];
  /**
   * Which of them have somewhere to fetch from, by path.
   *
   * Taken from the row's `remoteUrl`, which came from `.git/config` - so a
   * repository with no remote is known to have none without spawning anything,
   * and is reported as skipped rather than as a failure. It has not failed at
   * anything.
   */
  readonly hasRemote: (path: string) => boolean;
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Called as each repository settles, for progress that means something. */
  readonly onSettled?: (label: string) => void;
}

export async function fetchRepositories(request: FetchRequest): Promise<FetchReport> {
  const failures: FetchFailure[] = [];
  let attempted = 0;
  let fetched = 0;
  let skipped = 0;

  const environment = fetchEnvironment(request.env ?? process.env);

  await forEachBounded(request.repositories, Math.max(1, request.concurrency), async (repository) => {
    if (request.signal?.aborted) {
      return;
    }
    if (!request.hasRemote(repository.path)) {
      skipped += 1;
      return;
    }

    const args = fetchArgs();
    attempted += 1;
    try {
      const result = await runGit(args, {
        cwd: repository.path,
        timeoutMs: request.timeoutMs ?? FETCH_TIMEOUT_MS,
        env: environment,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const reason = classifyFetch(result);
      if (reason === undefined) {
        fetched += 1;
      } else if (!request.signal?.aborted) {
        // A repository killed by the reader's own cancellation is not a
        // failure and must not be reported as one.
        failures.push({
          label: repository.label,
          path: repository.path,
          reason,
          command: result.command,
          stderr: result.stderr.trim(),
        });
      }
    } catch (error) {
      failures.push({
        label: repository.label,
        path: repository.path,
        reason: 'refused',
        command: formatCommand(args),
        stderr: String(error),
      });
    }
    request.onSettled?.(repository.label);
  });

  return {
    attempted,
    fetched,
    skipped,
    failures,
    cancelled: request.signal?.aborted === true,
  };
}

function repositories(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/**
 * The one sentence the reader is shown afterwards.
 *
 * It names what did not happen before what did. A fetch that quietly succeeded
 * in nineteen repositories and failed in one is, to the person reading the
 * board, a fact about the one: the other nineteen are already visible as rows
 * whose figures just moved.
 */
export function fetchSentence(report: FetchReport): string {
  const parts: string[] = [];

  if (report.failures.length > 0) {
    const byReason = new Map<FetchReason, number>();
    for (const failure of report.failures) {
      byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
    }
    const words: Record<FetchReason, string> = {
      credentials: 'needed credentials',
      unreachable: 'could not reach their server',
      'timed-out': 'ran out of time',
      refused: 'were refused',
    };
    const named = [...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${count} ${words[reason]}`);
    parts.push(`${repositories(report.failures.length)} did not fetch: ${named.join(', ')}`);
  }

  if (report.fetched > 0) {
    parts.push(`${repositories(report.fetched)} fetched`);
  }
  if (report.skipped > 0) {
    parts.push(`${report.skipped} had no remote`);
  }
  if (report.cancelled) {
    parts.push('stopped early');
  }

  // Nothing at all happened, which is still worth saying: silence after a
  // button press reads as a button that does not work.
  return parts.length === 0 ? 'Nothing to fetch.' : `${parts.join('. ')}.`;
}
