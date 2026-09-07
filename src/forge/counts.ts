/**
 * Open review counts, one query per owner rather than one per repository.
 *
 * The batching is the design, not a saving. GitHub allows thirty search
 * requests a minute; a directory of forty repositories asked about one at a
 * time exhausts that in the first pass and renders a board where some rows
 * carry a count and some do not, for a reason nobody can see. One
 * `gh search prs --owner <owner>` answers every repository under that owner at
 * once, and a directory usually has very few owners.
 *
 * The two forges are asymmetric and the asymmetry is not hidden here. GitHub's
 * search returns the repository each pull request belongs to, so one query
 * yields a count per repository. GitLab's project list carries no merge-request
 * count at all, so the same question needs `glab mr list` per group and the
 * results are attributed by project path. Where a host answers neither, the row
 * says nothing - never zero.
 */

import type { ReviewState } from '../model/types.ts';
import { checkCli, runCli, toolFor, type CliAvailability } from './cli.ts';
import { forgeKindOf, type ForgeKind, type ForgeTarget } from './remote.ts';

/**
 * `unavailable` carries its own sentence because the reasons call for different
 * remedies - install the tool, sign in, or nothing, this host has no client -
 * and a single grey dash would send the reader to check the wrong one.
 */
export type { ReviewState } from '../model/types.ts';

/**
 * How many results one owner query will fetch.
 *
 * A cap rather than a measurement: the count on a row is a prompt to go and
 * look, so an owner with more open reviews than this is already telling the
 * reader everything the row can. Reaching it is reported as `n+` rather than as
 * a total the query did not establish.
 */
export const OWNER_QUERY_LIMIT = 300;

/**
 * One owner's answer: a count per repository, and whether the query stopped at
 * its limit rather than at the end of the results.
 */
export interface CountedOwner {
  readonly counts: Map<string, number>;
  readonly truncated: boolean;
}

export interface OwnerQuery {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly owner: string;
}

/** Keyed `host/owner/name`, lower-cased, which is how a row finds its own count. */
export function targetKey(target: ForgeTarget): string {
  return `${target.host}/${target.owner}/${target.name}`.toLowerCase();
}

/**
 * The distinct owner queries a set of repositories needs.
 *
 * On GitHub the owner is the first path segment; on GitLab the whole group path
 * is the unit, because a project can sit several subgroups deep and `glab`
 * takes the group. Deduplicated by host and owner, so ten repositories under
 * one organisation cost one query.
 */
export function ownerQueriesFor(targets: readonly ForgeTarget[]): OwnerQuery[] {
  const queries = new Map<string, OwnerQuery>();
  for (const target of targets) {
    const kind = forgeKindOf(target.host);
    if (kind === undefined) {
      continue;
    }
    const owner = kind === 'github' ? (target.owner.split('/')[0] ?? target.owner) : target.owner;
    const key = `${kind}:${target.host}:${owner}`.toLowerCase();
    if (!queries.has(key)) {
      queries.set(key, { kind, host: target.host, owner });
    }
  }
  return [...queries.values()];
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function githubArgs(query: OwnerQuery): string[] {
  return [
    'search',
    'prs',
    '--owner',
    query.owner,
    '--state',
    'open',
    '--limit',
    String(OWNER_QUERY_LIMIT),
    '--json',
    'repository',
  ];
}

/**
 * `gh search prs --json repository` in, a count per repository out.
 *
 * The shape is `[{ "repository": { "nameWithOwner": "owner/name" } }]`. Parsed
 * defensively: this is JSON from a tool whose output format is its own to
 * change, and a board that threw on an unexpected field would lose every row's
 * count for one renamed key.
 */
export function parseGithubCounts(stdout: string, host: string): CountedOwner {
  const counts = new Map<string, number>();
  let total = 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { counts, truncated: false };
  }
  if (!Array.isArray(parsed)) {
    return { counts, truncated: false };
  }
  total = parsed.length;
  for (const entry of parsed) {
    const repository = (entry as { repository?: { nameWithOwner?: unknown } }).repository;
    const full = repository?.nameWithOwner;
    if (typeof full !== 'string' || full.length === 0) {
      continue;
    }
    const key = `${host}/${full}`.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // The query fetched everything it was allowed to, so every count under this
  // owner is a floor rather than a total. Reported rather than inferred from the
  // number, because a repository that genuinely has exactly the limit open is
  // indistinguishable from one whose count stopped short.
  return { counts, truncated: total >= OWNER_QUERY_LIMIT };
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export function gitlabArgs(query: OwnerQuery): string[] {
  return [
    'mr',
    'list',
    '--group',
    query.owner,
    '--state',
    'opened',
    '--per-page',
    String(OWNER_QUERY_LIMIT),
    '--output',
    'json',
  ];
}

/**
 * `glab mr list --output json` in, a count per project out.
 *
 * `web_url` is the field parsed rather than a project id, because the id means
 * nothing to a row keyed by path, and the URL carries the path in a form that
 * survives a self-hosted instance under a subdirectory.
 */
export function parseGitlabCounts(stdout: string, host: string): CountedOwner {
  const counts = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { counts, truncated: false };
  }
  if (!Array.isArray(parsed)) {
    return { counts, truncated: false };
  }
  const total = parsed.length;
  for (const entry of parsed) {
    const url = (entry as { web_url?: unknown }).web_url;
    if (typeof url !== 'string') {
      continue;
    }
    // `https://gitlab.example.com/group/sub/project/-/merge_requests/12`
    const at = url.indexOf('/-/merge_requests');
    if (at < 0) {
      continue;
    }
    let projectPath: string;
    try {
      projectPath = new URL(url.slice(0, at)).pathname.replace(/^\/+/, '');
    } catch {
      continue;
    }
    if (projectPath.length === 0) {
      continue;
    }
    const key = `${host}/${projectPath}`.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { counts, truncated: total >= OWNER_QUERY_LIMIT };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface ReviewPassOptions {
  readonly targets: ReadonlyMap<string, ForgeTarget>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function unavailableSentence(kind: ForgeKind, availability: CliAvailability): string {
  const tool = toolFor(kind);
  if (availability.kind === 'missing') {
    return `${tool} is not installed, so review counts for this host were not asked for`;
  }
  if (availability.kind === 'unauthenticated') {
    return `${tool} is installed but not signed in: ${availability.detail}`;
  }
  return `${tool} could not answer`;
}

/**
 * Count open reviews for every target, batched by owner.
 *
 * Returns a state per target key. A key that is absent from the result was
 * never asked about - a host with no client - and the row shows nothing there,
 * which is the difference this whole layer has to keep: a repository nobody
 * asked about is not a repository with no open reviews.
 */
export async function readReviewCounts(
  options: ReviewPassOptions,
): Promise<Map<string, ReviewState>> {
  const states = new Map<string, ReviewState>();
  const targets = [...options.targets.values()];
  const queries = ownerQueriesFor(targets);

  for (const query of queries) {
    if (options.signal?.aborted) {
      return states;
    }

    const availability = await checkCli(query.kind, options.signal);
    if (availability.kind !== 'ready') {
      const reason = unavailableSentence(query.kind, availability);
      for (const [key, target] of options.targets) {
        if (forgeKindOf(target.host) === query.kind && target.host === query.host) {
          states.set(key, { kind: 'unavailable', reason });
        }
      }
      continue;
    }

    const tool = toolFor(query.kind);
    const args = query.kind === 'github' ? githubArgs(query) : gitlabArgs(query);
    const runOptions: { signal?: AbortSignal; timeoutMs?: number } = {};
    if (options.signal) {
      runOptions.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
      runOptions.timeoutMs = options.timeoutMs;
    }

    let answer: CountedOwner;
    try {
      const result = await runCli(tool, args, runOptions);
      if (result.code !== 0) {
        const reason = `${result.command} failed: ${result.stderr.trim().split('\n')[0] ?? 'no reason given'}`;
        for (const [key, target] of options.targets) {
          if (belongs(target, query)) {
            states.set(key, { kind: 'unavailable', reason });
          }
        }
        continue;
      }
      answer =
        query.kind === 'github'
          ? parseGithubCounts(result.stdout, query.host)
          : parseGitlabCounts(result.stdout, query.host);
    } catch (error) {
      const reason = `${tool} could not be run: ${String(error)}`;
      for (const [key, target] of options.targets) {
        if (belongs(target, query)) {
          states.set(key, { kind: 'unavailable', reason });
        }
      }
      continue;
    }

    // Every repository the query covered gets a state, including the ones with
    // nothing open: here a zero is a measured zero, which is exactly the case
    // the rest of this file exists to distinguish from silence.
    for (const [key, target] of options.targets) {
      if (belongs(target, query)) {
        const open = answer.counts.get(key) ?? 0;
        states.set(
          key,
          answer.truncated ? { kind: 'counted', open, atLeast: true } : { kind: 'counted', open },
        );
      }
    }
  }

  return states;
}

function belongs(target: ForgeTarget, query: OwnerQuery): boolean {
  if (target.host.toLowerCase() !== query.host.toLowerCase()) {
    return false;
  }
  const kind = forgeKindOf(target.host);
  if (kind !== query.kind) {
    return false;
  }
  const owner = kind === 'github' ? (target.owner.split('/')[0] ?? target.owner) : target.owner;
  return owner.toLowerCase() === query.owner.toLowerCase();
}
