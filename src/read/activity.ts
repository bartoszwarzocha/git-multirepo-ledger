/**
 * What landed across every repository, in one list.
 *
 * This is the thing the extension exists for and the one question no other
 * surface in the editor answers. Source Control, GitLens and Git Graph are all
 * organised around a repository: they answer "what happened *here*". A person
 * with twenty repositories opens their editor wanting "what happened *at all*,
 * since Friday" - and today they get it by opening twenty histories.
 *
 * One `git log` per repository, run at the same derived concurrency as the row
 * read, and merged into a single list ordered by time. Nothing is cached: the
 * question is asked when the reader asks it, and a stale answer to "what landed
 * today" is worse than a slow one.
 */

import type { Commit, DiscoveredRepository } from '../model/types.ts';
import { runGit } from '../util/git.ts';
import { parseHistory } from './history.ts';
import { deriveConcurrency, forEachBounded } from './reader.ts';

/** One commit, and which repository it came from. */
export interface ActivityEntry {
  readonly repositoryPath: string;
  readonly label: string;
  readonly commit: Commit;
}

export interface ActivityFailure {
  readonly label: string;
  readonly command: string;
  readonly stderr: string;
}

export interface ActivityResult {
  readonly entries: ActivityEntry[];
  /**
   * Repositories that could not be read, by name.
   *
   * Reported rather than dropped: a digest of the week that quietly left out
   * four repositories is a digest that says the week was quieter than it was,
   * and that is the one failure this whole extension is built to avoid.
   */
  readonly failures: ActivityFailure[];
  /** Repositories that answered, whether or not they had anything to say. */
  readonly asked: number;
}

/**
 * Commits per repository per period.
 *
 * A guard, not a preference: without it one repository having a busy month
 * would fill a digest meant to cover twenty. A repository that reaches the cap
 * is reported as having reached it rather than silently truncated.
 */
export const ACTIVITY_LIMIT_PER_REPOSITORY = 200;

export interface ActivityRequest {
  readonly repositories: readonly DiscoveredRepository[];
  /** ISO date, or any string git's `--since` accepts. */
  readonly since: string;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly cpuCount?: number;
  readonly timeoutMs?: number;
}

// Kept identical to `HISTORY_FORMAT`, because `parseHistory` reads both. They
// are two constants rather than one import so that changing the digest's fields
// cannot silently change the pane's, but a test asserts they agree.
export const FORMAT = ['%H', '%P', '%D', '%ct', '%an', '%ae', '%s'].join('%x1f') + '%x1e';

export function activityArgs(since: string): string[] {
  // An empty bound is not `--since=`: git accepts that and reads it as an
  // unparseable date, which quietly returns everything on some versions and
  // nothing on others. The flag is left out instead.
  const bound = since.length > 0 ? [`--since=${since}`] : [];
  return [
    '--no-optional-locks',
    'log',
    ...bound,
    `--max-count=${ACTIVITY_LIMIT_PER_REPOSITORY}`,
    '--date-order',
    `--format=${FORMAT}`,
    'HEAD',
  ];
}

export async function readActivity(request: ActivityRequest): Promise<ActivityResult> {
  const entries: ActivityEntry[] = [];
  const failures: ActivityFailure[] = [];
  let asked = 0;

  const concurrency = deriveConcurrency({
    ...(request.concurrency === undefined ? {} : { configured: request.concurrency }),
    ...(request.cpuCount === undefined ? {} : { cpuCount: request.cpuCount }),
  });

  await forEachBounded(
    request.repositories,
    concurrency,
    async (repository) => {
      if (request.signal?.aborted) {
        return;
      }
      const args = activityArgs(request.since);
      const options: { cwd: string; signal?: AbortSignal; timeoutMs?: number } = {
        cwd: repository.path,
      };
      if (request.signal) {
        options.signal = request.signal;
      }
      if (request.timeoutMs !== undefined) {
        options.timeoutMs = request.timeoutMs;
      }

      try {
        const result = await runGit(args, options);
        if (result.code !== 0) {
          failures.push({
            label: repository.label,
            command: result.command,
            stderr: result.stderr.trim(),
          });
          return;
        }
        asked += 1;
        for (const commit of parseHistory(result.stdout)) {
          entries.push({
            repositoryPath: repository.path,
            label: repository.label,
            commit,
          });
        }
      } catch (error) {
        failures.push({
          label: repository.label,
          command: `git ${args.join(' ')}`,
          stderr: String(error),
        });
      }
    },
    request.signal,
  );

  // Newest first, across every repository. The secondary key is the repository
  // path so two commits sharing a second do not swap places between passes.
  entries.sort(
    (a, b) =>
      b.commit.committedAt - a.commit.committedAt ||
      a.repositoryPath.localeCompare(b.repositoryPath),
  );

  return { entries, failures, asked };
}
