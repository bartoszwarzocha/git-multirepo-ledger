/**
 * A thin runner over the `git` CLI.
 *
 * The extension shells out rather than embedding a JavaScript reimplementation
 * of git, so what it reports is exactly what the user gets by running the same
 * command. A reimplementation would have to be believed on its own word: when a
 * row disagreed with the terminal there would be no way to tell which of the
 * two was right, whereas a spawned command can simply be retyped.
 */

import { spawn } from 'node:child_process';
import { log } from './log.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Output past `maxBytes` was dropped, so `stdout` is a prefix of the answer.
   *
   * Stated rather than left to be inferred from the length: a caller that reads
   * a truncated commit list as the complete one would report the repository as
   * quieter than it is - an older commit shown as the latest, a branch count
   * short of the branches that fell off the end - and a row that is confidently
   * wrong is worse than one that says it could not finish reading.
   */
  truncated: boolean;
  /** The command as a user could retype it. Shown beside what it reported. */
  command: string;
}

/**
 * The same result with `stdout` left as bytes.
 *
 * Everything the extension reads about a repository is text, with one
 * exception: `git cat-file blob`, which hands back whatever is in the object.
 * Decoding that as UTF-8 to satisfy a `string` field would corrupt a PNG, a
 * font or a file saved in another encoding - and the corruption is silent,
 * because the replacement character is a valid character. So the one caller
 * that needs bytes gets bytes, and every other caller keeps the decoded form.
 */
export interface GitBufferResult extends Omit<GitResult, 'stdout'> {
  stdout: Buffer;
}

export interface GitOptions {
  cwd: string;
  /** Default 10 s. A repository that hangs must not hang the extension host. */
  timeoutMs?: number;
  /** Default 32 MiB. Output past this is truncated, not buffered without bound. */
  maxBytes?: number;
  signal?: AbortSignal;
  /**
   * The complete environment for the child, replacing the one it would inherit.
   *
   * Only the fetch uses this, and it uses it to take things away: git must not
   * be able to ask for a password, because a spawned process has no terminal to
   * ask on and the question would never be answered. Every read leaves this
   * unset and inherits the host'''s environment, which is what makes a command
   * shown on screen the same command a user could retype.
   */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** `git log --format=%H -- x` -> `git log --format=%H -- x`, quoting only what needs it. */
export function formatCommand(args: readonly string[]): string {
  const quoted = args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg));
  return `git ${quoted.join(' ')}`;
}

export class GitMissingError extends Error {
  constructor() {
    super('git was not found on PATH');
    this.name = 'GitMissingError';
  }
}

/**
 * Run git and resolve with its result, including a non-zero exit code.
 *
 * Only git being absent from PATH throws, because that is a different kind of
 * fact: it disables whole features rather than failing one query.
 */
export function runGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
  return runGitBuffer(args, options).then((result) => ({
    ...result,
    stdout: result.stdout.toString('utf8'),
  }));
}

/**
 * As `runGit`, but `stdout` is the bytes git wrote.
 *
 * Same guards - the timeout, the byte cap, the abort signal, `shell: false` -
 * because a raw read is not a less careful one.
 */
export function runGitBuffer(
  args: readonly string[],
  options: GitOptions,
): Promise<GitBufferResult> {
  const command = formatCommand(args);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<GitBufferResult>((resolve, reject) => {
    let child;
    try {
      child = spawn('git', [...args], {
        cwd: options.cwd,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
        // No shell: arguments carry user-controlled paths and task text.
        shell: false,
      });
    } catch (error) {
      reject(isMissingGit(error) ? new GitMissingError() : error);
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result: GitBufferResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) {
        out.push(chunk);
        outBytes += chunk.length;
      } else {
        truncated = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < 64 * 1024) {
        err.push(chunk);
        errBytes += chunk.length;
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(isMissingGit(error) ? new GitMissingError() : error);
    });

    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        command,
      });
    });
  });
}

function isMissingGit(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// Cached facts about the environment
// ---------------------------------------------------------------------------

let availability: Promise<boolean> | undefined;
const repoRoots = new Map<string, Promise<string | undefined>>();

/** Whether `git` is on PATH. Answered once per session. */
export function isGitAvailable(): Promise<boolean> {
  if (!availability) {
    availability = runGit(['--version'], { cwd: process.cwd(), timeoutMs: 5000 })
      .then((result) => result.code === 0)
      .catch((error) => {
        if (error instanceof GitMissingError) {
          log.info(
            'git is not on PATH; nothing can be read, and every row reports that as its state',
          );
          return false;
        }
        log.warn(`could not determine whether git is available: ${String(error)}`);
        return false;
      });
  }
  return availability;
}

/**
 * Absolute path of the repository containing `dir`, or undefined when it is not
 * inside one. Cached per directory: the answer does not change while a window
 * is open, and the same directory is asked about more than once.
 */
export function findRepositoryRoot(dir: string): Promise<string | undefined> {
  const cached = repoRoots.get(dir);
  if (cached) {
    return cached;
  }
  const pending = (async (): Promise<string | undefined> => {
    if (!(await isGitAvailable())) {
      return undefined;
    }
    try {
      const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 5000 });
      if (result.code !== 0) {
        return undefined;
      }
      const top = result.stdout.trim();
      return top.length > 0 ? top : undefined;
    } catch {
      return undefined;
    }
  })();
  repoRoots.set(dir, pending);
  return pending;
}

/** Test seam: forget the cached environment facts. */
export function resetGitCaches(): void {
  availability = undefined;
  repoRoots.clear();
}
