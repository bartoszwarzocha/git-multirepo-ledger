/**
 * What one commit changed.
 *
 *     git --no-optional-locks diff-tree --no-commit-id --name-status -r -M -z \
 *         --root <sha>
 *
 * One process, and only when the reader expands a commit - a page of fifty
 * commits costs nothing until one of them is asked about.
 *
 * `-z` is not a nicety. Without it git quotes any path containing a space, a
 * quote or a byte above ASCII, and the parse would have to unquote it correctly
 * for every locale and `core.quotePath` setting; with it, records are
 * NUL-separated and paths arrive as the bytes git holds. `--root` is what makes
 * the first commit in a repository answer at all: with no parent to diff
 * against, `diff-tree` otherwise prints nothing and the pane would report the
 * initial commit as having changed no files.
 *
 * A merge commit is the one case this cannot answer in one process. `diff-tree`
 * on a merge prints nothing unless told which parent to compare against, and
 * choosing one silently would show a diff that is true against one side and
 * misleading against the other. So a merge says it is a merge and names its
 * parents, which is a smaller claim and a true one.
 */

import type { CommitFile } from '../model/types.ts';
import { runGit } from '../util/git.ts';

export function commitFilesArgs(sha: string): string[] {
  return [
    '--no-optional-locks',
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '-M',
    '-z',
    '--root',
    sha,
  ];
}

/**
 * The NUL-separated `--name-status -z` stream, parsed.
 *
 * The record shape is not uniform, which is the trap here: an ordinary change
 * is two fields, `M\0path\0`, while a rename or a copy is three,
 * `R100\0old\0new\0`. Reading it as fixed pairs shifts every record after the
 * first rename, so the status letter decides how many fields to take.
 */
export function parseCommitFiles(stdout: string): CommitFile[] {
  const parts = stdout.split('\0');
  const files: CommitFile[] = [];
  let index = 0;

  while (index < parts.length) {
    const status = (parts[index] ?? '').trim();
    if (status.length === 0) {
      index += 1;
      continue;
    }
    const letter = status[0] ?? '';
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[index + 1];
      const newPath = parts[index + 2];
      if (oldPath === undefined || newPath === undefined) {
        break;
      }
      files.push({ status: letter, path: newPath, oldPath });
      index += 3;
      continue;
    }
    const path = parts[index + 1];
    if (path === undefined) {
      break;
    }
    files.push({ status: letter, path });
    index += 2;
  }

  return files;
}

export interface CommitFilesRequest {
  cwd: string;
  sha: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CommitFilesResult {
  readonly files: CommitFile[];
  readonly failure?: { readonly command: string; readonly stderr: string };
}

export async function readCommitFiles(request: CommitFilesRequest): Promise<CommitFilesResult> {
  const args = commitFilesArgs(request.sha);
  const options: { cwd: string; signal?: AbortSignal; timeoutMs?: number } = { cwd: request.cwd };
  if (request.signal) {
    options.signal = request.signal;
  }
  if (request.timeoutMs !== undefined) {
    options.timeoutMs = request.timeoutMs;
  }

  try {
    const result = await runGit(args, options);
    if (result.code !== 0) {
      return {
        files: [],
        failure: { command: result.command, stderr: result.stderr.trim() },
      };
    }
    return { files: parseCommitFiles(result.stdout) };
  } catch (error) {
    return {
      files: [],
      failure: { command: `git ${args.join(' ')}`, stderr: String(error) },
    };
  }
}
