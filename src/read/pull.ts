/**
 * Catching up, but only where catching up cannot go wrong.
 *
 * `fetch` answers "what is on the server"; this answers "bring it here". The
 * difference is the working tree: a fetch cannot touch a file you have open, and
 * a pull can.
 *
 * Which is exactly why this is not `git pull` across the board. One button over
 * twenty repositories, three of which conflict, leaves three half-merged working
 * trees nobody asked for - and the reader finds out days later, opening one of
 * them. So this runs only where git is about to move a pointer and nothing else:
 *
 *   - the branch is behind its upstream and **not** ahead of it, so there is
 *     nothing of the reader's to merge with;
 *   - HEAD is on a branch, not detached and not unborn;
 *   - no merge, rebase, cherry-pick, revert or bisect is half-finished;
 *   - the working tree is clean, *and known to be clean* - see below.
 *
 * `--ff-only` makes git enforce the first of those itself, so the check here is
 * not the safety net: it is what lets the reader be told which repositories were
 * left alone and why, before anything runs, instead of reading twelve identical
 * refusals afterwards.
 *
 * The repositories that fail the test are the ones worth a person's attention
 * anyway. Being told "diverged - 2 ahead and 2 behind" is the useful answer;
 * having that one silently merged is not.
 */

import type { RepositoryRow } from '../model/types.ts';
import { runGit, formatCommand } from '../util/git.ts';
import { fetchEnvironment, FETCH_TIMEOUT_MS } from './fetch.ts';
import { forEachBounded } from './reader.ts';

/**
 * `git pull --ff-only`, which is what a person would type.
 *
 * It fetches first, so pressing this after nothing - without a fetch - still
 * works on current information rather than on whatever the last fetch left.
 *
 * `--ff-only` rather than a bare pull: git refuses anything that would need a
 * merge commit, so even if the check below were wrong about a repository, the
 * worst outcome is a refusal carrying git's own words.
 */
export function pullArgs(): string[] {
  return ['pull', '--ff-only'];
}

/** Why a repository was left alone. */
export interface NotEligible {
  readonly ok: false;
  /** Said to the reader as-is. */
  readonly reason: string;
}

export type Eligibility = { readonly ok: true } | NotEligible;

/**
 * Whether a fast-forward is the only thing that could happen here.
 *
 * Pure, and the order of the tests is the order a person would check them in:
 * what git would refuse outright first, then what is theirs to lose.
 *
 * A working tree nobody has read is treated as *not* clean. The read is the
 * second tier of a pass, so a row carries `not-read` until it returns and
 * whenever it failed, and reading that as "no changes" would be the one mistake
 * this whole extension is written to avoid - here it would not merely
 * misreport, it would write over somebody's work. git would very likely refuse
 * anyway; "very likely" is not the standard for something that touches files.
 */
export function eligibleForFastForward(row: RepositoryRow): Eligibility {
  if (row.failure !== undefined) {
    return { ok: false, reason: 'git would not answer for it' };
  }
  if (row.operation !== undefined) {
    return { ok: false, reason: `${row.operation.kind} in progress` };
  }
  if (row.head.kind === 'detached') {
    return { ok: false, reason: 'detached HEAD - no branch to move' };
  }
  if (row.head.kind === 'unborn') {
    return { ok: false, reason: 'nothing committed yet' };
  }
  if (row.head.kind === 'unknown') {
    return { ok: false, reason: 'HEAD could not be read' };
  }

  switch (row.divergence.kind) {
    case 'no-upstream':
      return { ok: false, reason: 'the branch tracks nothing' };
    case 'gone':
      return { ok: false, reason: `its upstream ${row.divergence.upstream} is gone` };
    case 'unknown':
      return { ok: false, reason: 'the divergence could not be read' };
    case 'in-sync':
      // Not a refusal. Whether it is really current depends on how old the
      // remote-tracking ref is, and `pull` fetches before it decides - so this
      // is a repository worth running, not one worth skipping.
      break;
    case 'diverged': {
      if (row.divergence.ahead > 0 && row.divergence.behind > 0) {
        return {
          ok: false,
          reason: `diverged - ${row.divergence.ahead} ahead and ${row.divergence.behind} behind`,
        };
      }
      if (row.divergence.ahead > 0) {
        return { ok: false, reason: `${row.divergence.ahead} ahead, nothing to catch up on` };
      }
      break;
    }
  }

  if (row.workingTree.kind === 'not-read') {
    return { ok: false, reason: 'the working tree was not read, so it cannot be called clean' };
  }
  if (row.workingTree.kind === 'incomplete') {
    return { ok: false, reason: `the working tree read did not finish: ${row.workingTree.reason}` };
  }
  const counts = row.workingTree.counts;
  const dirty = counts.staged + counts.unstaged + counts.untracked + counts.conflicted;
  if (dirty > 0) {
    return { ok: false, reason: 'uncommitted changes' };
  }

  return { ok: true };
}

export interface PullFailure {
  readonly label: string;
  readonly command: string;
  readonly stderr: string;
}

export interface PullSkipped {
  readonly label: string;
  readonly reason: string;
}

export interface PullReport {
  /** Repositories whose branch actually moved. */
  readonly advanced: number;
  /** Ran, succeeded, and had nothing to bring. */
  readonly alreadyCurrent: number;
  readonly skipped: readonly PullSkipped[];
  readonly failures: readonly PullFailure[];
  readonly cancelled: boolean;
}

export interface PullRequest {
  readonly rows: readonly RepositoryRow[];
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onSettled?: (label: string) => void;
}

export async function pullRepositories(request: PullRequest): Promise<PullReport> {
  const skipped: PullSkipped[] = [];
  const failures: PullFailure[] = [];
  let advanced = 0;
  let alreadyCurrent = 0;

  const eligible: RepositoryRow[] = [];
  for (const row of request.rows) {
    const verdict = eligibleForFastForward(row);
    if (verdict.ok) {
      eligible.push(row);
    } else {
      skipped.push({ label: row.repository.label, reason: verdict.reason });
    }
  }

  const environment = fetchEnvironment(request.env ?? process.env);
  const timeoutMs = request.timeoutMs ?? FETCH_TIMEOUT_MS;

  await forEachBounded(eligible, Math.max(1, request.concurrency), async (row) => {
    if (request.signal?.aborted) {
      return;
    }
    const cwd = row.repository.path;
    const options = {
      cwd,
      timeoutMs,
      env: environment,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    // The commit before and after, rather than reading what git printed.
    // "Already up to date." is translated; two object ids are not, and the
    // difference between them is the only honest way to say whether anything
    // moved.
    const before = await runGit(['rev-parse', 'HEAD'], options);

    const args = pullArgs();
    try {
      const result = await runGit(args, options);
      if (result.code !== 0) {
        if (!request.signal?.aborted) {
          failures.push({
            label: row.repository.label,
            command: result.command,
            stderr: result.stderr.trim(),
          });
        }
        return;
      }
      const after = await runGit(['rev-parse', 'HEAD'], options);
      if (before.code === 0 && after.code === 0 && before.stdout.trim() !== after.stdout.trim()) {
        advanced += 1;
      } else {
        alreadyCurrent += 1;
      }
    } catch (error) {
      failures.push({
        label: row.repository.label,
        command: formatCommand(args),
        stderr: String(error),
      });
    }
    request.onSettled?.(row.repository.label);
  });

  return {
    advanced,
    alreadyCurrent,
    skipped,
    failures,
    cancelled: request.signal?.aborted === true,
  };
}

function repositories(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/**
 * What the reader is told afterwards.
 *
 * What moved comes first, because that is the thing they pressed the button
 * for. What was left alone comes next and is named one repository at a time up
 * to a limit: "3 left alone" is a number nobody can act on, whereas "billing
 * has uncommitted changes" is a sentence that tells them where to go.
 */
export function pullSentence(report: PullReport): string {
  const parts: string[] = [];

  if (report.advanced > 0) {
    parts.push(`${repositories(report.advanced)} caught up`);
  }
  if (report.alreadyCurrent > 0) {
    parts.push(`${report.alreadyCurrent} already current`);
  }

  if (report.skipped.length > 0) {
    const named = report.skipped
      .slice(0, 3)
      .map((entry) => `${entry.label} (${entry.reason})`)
      .join(', ');
    const rest = report.skipped.length > 3 ? ` and ${report.skipped.length - 3} more` : '';
    parts.push(`${report.skipped.length} left alone: ${named}${rest}`);
  }

  if (report.failures.length > 0) {
    parts.push(`${repositories(report.failures.length)} refused`);
  }
  if (report.cancelled) {
    parts.push('stopped early');
  }

  return parts.length === 0 ? 'Nothing to catch up on.' : `${parts.join('. ')}.`;
}
