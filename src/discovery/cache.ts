/**
 * The discovered repository list, held until something that could change it
 * happens.
 *
 * Discovery is re-run when a workspace folder is added or removed, when a
 * setting that decides what is scanned changes, and when the user refreshes -
 * and explicitly *not* when something happens inside a repository already known
 * (design.md D64). A commit made in a terminal fires watcher events on that
 * repository's git directory many times in a second, and this cache is what
 * keeps each of them from re-walking every root to rediscover a list that
 * cannot have changed.
 *
 * Copied from the sibling project's `discovery/cache.ts` and retyped. Two
 * behaviours in it are subtler than they look and are kept exactly: a second
 * caller joins the walk already running rather than starting its own, and the
 * result of a walk that was cancelled or overtaken goes to whoever joined it
 * and no further.
 *
 * No `vscode` import: this is bookkeeping over a promise, and keeping it out of
 * the extension host is what lets the module it wraps be tested.
 */

import type { DiscoveredRepository } from '../model/types.ts';
import { discoverRepositories, type DiscoveryInput } from './repositories.ts';

interface Run {
  /** The value of `#generation` when the walk started. */
  generation: number;
  controller: AbortController;
  /** The signal the walk actually observes: the cache's, plus the caller's. */
  signal: AbortSignal;
  promise: Promise<DiscoveredRepository[]>;
}

export class RepositoryCache {
  #repositories: DiscoveredRepository[] | undefined;
  #run: Run | undefined;
  /** Bumped by `invalidate`, so a walk that began before it is not kept. */
  #generation = 0;

  /** The last completed discovery, or undefined when none has completed. Not a copy. */
  get current(): DiscoveredRepository[] | undefined {
    return this.#repositories;
  }

  get(input: DiscoveryInput): Promise<DiscoveredRepository[]> {
    const cached = this.#repositories;
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const running = this.#run;
    if (running !== undefined) {
      // A second caller joins the walk under way rather than starting its own.
      return running.promise;
    }

    const controller = new AbortController();
    const signal =
      input.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, input.signal]);

    const promise = discoverRepositories({ ...input, signal });
    const run: Run = { generation: this.#generation, controller, signal, promise };
    this.#run = run;

    // Bookkeeping is attached after `#run` is set, so the completion handler can
    // never observe a half-registered run. It runs before any caller's
    // continuation, which is what makes `current` valid the moment `get`
    // resolves.
    void promise.then(
      (repositories) => this.#finish(run, repositories),
      () => this.#finish(run, undefined),
    );
    return promise;
  }

  /**
   * Drop the cached list. A walk already under way keeps running for whoever
   * joined it, but its result is no longer stored: it was started against a
   * workspace that has since changed.
   */
  invalidate(): void {
    this.#generation++;
    this.#repositories = undefined;
    this.#run = undefined;
  }

  /** Abort a walk in progress. A list discovered earlier stays valid. */
  cancel(): void {
    this.#run?.controller.abort();
    this.#run = undefined;
  }

  #finish(run: Run, repositories: DiscoveredRepository[] | undefined): void {
    if (this.#run === run) {
      this.#run = undefined;
    }
    // A cancelled walk, or one overtaken by an invalidation, may have seen only
    // part of the tree. Its result goes to whoever joined it and no further.
    if (
      repositories !== undefined &&
      run.generation === this.#generation &&
      !run.signal.aborted
    ) {
      this.#repositories = repositories;
    }
  }
}
