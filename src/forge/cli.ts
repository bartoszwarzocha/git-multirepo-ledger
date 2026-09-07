/**
 * The `gh` and `glab` command line tools: whether they are here, whether they
 * are signed in, and what they answer.
 *
 * This is the only part of the extension that reaches the network, and it is
 * the only part that ships switched off. Everything below runs a subprocess
 * that talks to whatever host the repository points at, using credentials those
 * tools already hold - no token is ever asked for, stored, or read out of them.
 *
 * The queries are **batched by owner**, and that is not an optimisation. GitHub
 * allows thirty search requests a minute; a directory of forty repositories
 * asked about one at a time hits that ceiling and renders a half-populated
 * board, which reads as a bug rather than as a rate limit. One query per owner
 * answers every repository under it at once.
 *
 * A query that fails reports **silence** rather than zero. "No open reviews" and
 * "we could not ask" are different facts and only one of them is good news.
 */

import { spawn } from 'node:child_process';

import { log } from '../util/log.ts';
import type { ForgeKind } from './remote.ts';

/**
 * A forge query may sit on a network the extension knows nothing about, so it
 * gets more room than a local read - and still a bound, because a board that
 * waits forever on a VPN nobody is connected to is a board that never settles.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Output past this is a sign the query matched far more than a board can use. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly command: string;
}

export class CliMissingError extends Error {
  // Declared and assigned rather than written as a parameter property: the
  // tests run the TypeScript sources unbuilt through Node's strip-only mode,
  // which erases types and refuses any syntax that emits code. A parameter
  // property does, so it fails at import time rather than at type-check.
  readonly tool: string;

  constructor(tool: string) {
    super(`${tool} was not found on PATH`);
    this.name = 'CliMissingError';
    this.tool = tool;
  }
}

/**
 * Run one of the forge tools.
 *
 * The environment is pinned so nothing being parsed can be translated,
 * paginated into a pager, or turned into a prompt: `GH_PROMPT_DISABLED` and
 * `GIT_TERMINAL_PROMPT=0` matter most, because a tool that stops to ask for a
 * password on a headless read is a tool that hangs until the timeout.
 */
export function runCli(
  tool: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CliResult> {
  const command = `${tool} ${args.join(' ')}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CliResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(tool, [...args], {
        windowsHide: true,
        // No shell: the arguments carry owner and group names read off a remote
        // URL, which is text somebody else wrote.
        shell: false,
        env: {
          ...process.env,
          GH_PAGER: 'cat',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GLAB_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          NO_COLOR: '1',
        },
      });
    } catch (error) {
      reject(isMissing(error) ? new CliMissingError(tool) : error);
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
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

    const finish = (result: CliResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_BYTES) {
        out.push(chunk);
        outBytes += chunk.length;
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
      reject(isMissing(error) ? new CliMissingError(tool) : error);
    });

    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        command,
      });
    });
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// Is it here, and is it signed in
// ---------------------------------------------------------------------------

export type CliAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unauthenticated'; readonly detail: string };

const TOOLS: Record<ForgeKind, string> = { github: 'gh', gitlab: 'glab' };

const availability = new Map<ForgeKind, Promise<CliAvailability>>();

/**
 * Whether the tool for this forge can answer, asked once per session.
 *
 * `auth status` rather than `--version`, because a tool that is installed and
 * signed out fails every query afterwards with an error the board would have to
 * render forty times. Asked once and remembered: it is a fact about the machine
 * rather than about any repository, and the answer changes when the reader
 * signs in, which is a Refresh away.
 */
export function checkCli(kind: ForgeKind, signal?: AbortSignal): Promise<CliAvailability> {
  const cached = availability.get(kind);
  if (cached) {
    return cached;
  }
  const tool = TOOLS[kind];
  const pending = (async (): Promise<CliAvailability> => {
    try {
      const options = signal ? { signal, timeoutMs: 10_000 } : { timeoutMs: 10_000 };
      const result = await runCli(tool, ['auth', 'status'], options);
      if (result.code === 0) {
        return { kind: 'ready' };
      }
      // Both tools write the useful sentence to stderr and exit non-zero when
      // no account is configured, so it is quoted rather than paraphrased.
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
      log.info(`${tool} is installed but not signed in: ${detail}`);
      return { kind: 'unauthenticated', detail };
    } catch (error) {
      if (error instanceof CliMissingError) {
        log.info(`${tool} is not on PATH, so ${kind} review counts are unavailable`);
        return { kind: 'missing' };
      }
      log.error(`could not determine whether ${tool} can answer`, error);
      return { kind: 'missing' };
    }
  })();
  availability.set(kind, pending);
  return pending;
}

/** Test seam, and what Refresh calls so signing in takes effect without a reload. */
export function resetCliCache(): void {
  availability.clear();
}

export function toolFor(kind: ForgeKind): string {
  return TOOLS[kind];
}
