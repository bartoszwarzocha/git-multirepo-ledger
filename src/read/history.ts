/**
 * The history read: one `git log` per page, and what its output means.
 *
 *     git --no-optional-locks log --max-count=<n> --skip=<m> \
 *         --format=<HISTORY_FORMAT> HEAD
 *
 * One process per page, not per commit. Everything the pane draws - the hash,
 * the parents, the refs, the date, the author and the subject - comes out of
 * that single invocation, because a pane that spawned a process per row would
 * cost a hundred processes to scroll.
 *
 * `--no-optional-locks` sits before the subcommand, where a git-level option
 * has to sit. Written after it, git exits 129 with ``unknown option
 * `no-optional-locks'`` and the pane would report every repository as
 * unreadable for a reason that is about the command line rather than about the
 * repository.
 *
 * Parents (`%P`) are read and stored from the first version even though nothing
 * renders them yet. Drawing merge lanes is a later change, and reading the
 * parent list now means that change adds a renderer rather than a migration.
 */

import type { Commit, CommitRef, CommitRefKind } from '../model/types.ts';
import { shortSha } from '../model/keys.ts';
import { runGit } from '../util/git.ts';

/**
 * Field and record separators, as git spells them and as JavaScript does.
 *
 * A record terminator is needed as well as a field separator because
 * `%(contents:subject)` is one line but nothing guarantees the same of an
 * author name: `GIT_AUTHOR_NAME` accepts a newline, and a record split on
 * newlines would then read one commit as two. U+001E terminates the record and
 * U+001F separates the fields inside it; both are refused inside a ref name by
 * git's own `check-ref-format`, and the subject is placed last so that a
 * separator somebody managed to commit into it is absorbed rather than
 * shifting every field after it.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

// `%ae` sits between the name and the subject rather than at the end, because
// the subject has to stay last: everything past the final separator is rejoined
// into it, which is what absorbs a separator somebody committed into a message.
export const HISTORY_FORMAT = ['%H', '%P', '%D', '%ct', '%an', '%ae', '%s'].join('%x1f') + '%x1e';

/** Commits per page. A setting rather than a constant; this is the fallback. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * A page is capped well below what `git log` will happily produce.
 *
 * Not a figure measured anywhere: it is a guard against a repository with a
 * decade of history being asked for all of it at once and handing the webview
 * a document it has to lay out in one frame. The reader asks for more by
 * scrolling, which is cheap; the pane never asks for everything, which is not.
 */
export const MAX_PAGE_SIZE = 500;

export interface HistoryRequest {
  cwd: string;
  limit?: number;
  skip?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HistoryResult {
  readonly commits: Commit[];
  /** More commits exist past this page. */
  readonly more: boolean;
  /** Set when git refused, with the command as a user could retype it. */
  readonly failure?: { readonly command: string; readonly stderr: string };
  /** Set when the output was cut short, so what is missing is unknown. */
  readonly incomplete?: string;
}

export function historyArgs(limit: number, skip: number): string[] {
  // One extra commit is asked for and never shown: its presence is how the
  // pane knows there is a next page without a second count of the history,
  // which on a large repository is the expensive question.
  return [
    '--no-optional-locks',
    'log',
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    `--format=${HISTORY_FORMAT}`,
    'HEAD',
  ];
}

/**
 * `%D` in, classified refs out.
 *
 * git writes `HEAD -> main, origin/main, tag: v1.2`. The arrow form appears
 * only when HEAD is on a branch; a detached HEAD writes a bare `HEAD`. Tags
 * carry a `tag: ` prefix. Anything with a slash that is not a tag is taken as a
 * remote-tracking ref, which is what every remote ref looks like and what no
 * local branch may look like unless somebody named one `feature/x` - so the
 * remote list would have to be known to do better, and that is another process
 * for a chip.
 */
export function parseRefs(decoration: string): CommitRef[] {
  const refs: CommitRef[] = [];
  for (const raw of decoration.split(',')) {
    const piece = raw.trim();
    if (piece.length === 0) {
      continue;
    }
    if (piece.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: piece.slice(5) });
      continue;
    }
    if (piece === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' });
      continue;
    }
    const arrow = piece.indexOf(' -> ');
    if (arrow >= 0) {
      refs.push({ kind: 'head', name: 'HEAD' });
      refs.push({ kind: 'branch', name: piece.slice(arrow + 4) });
      continue;
    }
    refs.push({ kind: piece.includes('/') ? 'remote' : 'branch', name: piece });
  }

  // HEAD first, then local branches, then remotes, then tags: the order answers
  // "where am I", "what else is here", "what does the server have", "what was
  // released", which is the order a reader asks them in.
  const rank: Record<CommitRefKind, number> = { head: 0, branch: 1, remote: 2, tag: 3 };
  return refs.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Raw stdout in, commits out. Never throws.
 *
 * A record with too few fields is skipped rather than fatal: the parse holds
 * one page of somebody else's history, and one malformed record must not cost
 * the other forty-nine.
 */
export function parseHistory(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split(RECORD)) {
    const trimmed = record.replace(/^[\r\n]+/, '');
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split(FIELD);
    if (fields.length < 7) {
      continue;
    }
    const sha = (fields[0] ?? '').trim();
    const committedAt = Number.parseInt(fields[3] ?? '', 10);
    if (sha.length === 0 || !Number.isFinite(committedAt)) {
      continue;
    }
    commits.push({
      sha,
      shortSha: shortSha(sha),
      parents: (fields[1] ?? '').split(' ').filter((part) => part.length > 0),
      refs: parseRefs(fields[2] ?? ''),
      committedAt,
      author: fields[4] ?? '',
      authorEmail: fields[5] ?? '',
      // Everything past the sixth separator is the subject, so a separator that
      // somebody committed into it rejoins rather than truncating the message.
      subject: fields.slice(6).join(FIELD),
      unpushed: false,
    });
  }
  return commits;
}

export async function readHistory(request: HistoryRequest): Promise<HistoryResult> {
  const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const skip = Math.max(0, request.skip ?? 0);
  const args = historyArgs(limit, skip);

  const options: { cwd: string; signal?: AbortSignal; timeoutMs?: number } = { cwd: request.cwd };
  if (request.signal) {
    options.signal = request.signal;
  }
  if (request.timeoutMs !== undefined) {
    options.timeoutMs = request.timeoutMs;
  }

  let result;
  try {
    result = await runGit(args, options);
  } catch (error) {
    return {
      commits: [],
      more: false,
      failure: { command: `git ${args.join(' ')}`, stderr: String(error) },
    };
  }

  if (result.code !== 0) {
    return {
      commits: [],
      more: false,
      failure: { command: result.command, stderr: result.stderr.trim() },
    };
  }

  const parsed = parseHistory(result.stdout);
  const more = parsed.length > limit;
  const page = more ? parsed.slice(0, limit) : parsed;

  const out: HistoryResult = { commits: page, more };
  if (result.truncated) {
    // Stated rather than inferred from the length: a page read as complete when
    // it was cut off would report the history as shorter than it is, and the
    // pane would show a last commit that is not the last commit.
    return { ...out, incomplete: 'the output was truncated, so this page is not the whole answer' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which commits exist only here
// ---------------------------------------------------------------------------

export function unpushedArgs(limit: number): string[] {
  return ['--no-optional-locks', 'rev-list', `--max-count=${limit}`, 'HEAD', '--not', '--remotes'];
}

/**
 * The set of commits no remote this repository knows about carries.
 *
 * A second process, and it runs only when the row already said there was
 * something ahead - so an answer of "none" is a fact rather than a question
 * nobody asked. Deriving the set from the ahead count instead would be one
 * process cheaper and wrong the moment the history is not linear: the ahead
 * count is a number of commits, not the first N in date order.
 */
export async function readUnpushed(request: HistoryRequest): Promise<Set<string>> {
  const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const options: { cwd: string; signal?: AbortSignal; timeoutMs?: number } = { cwd: request.cwd };
  if (request.signal) {
    options.signal = request.signal;
  }
  if (request.timeoutMs !== undefined) {
    options.timeoutMs = request.timeoutMs;
  }

  try {
    const result = await runGit(unpushedArgs(limit), options);
    if (result.code !== 0) {
      return new Set();
    }
    return new Set(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    return new Set();
  }
}
