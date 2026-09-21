/**
 * Wiring. Discovery feeds the reader, the reader feeds the list, and the list
 * sends back what the reader clicked.
 *
 * The one rule this file exists to enforce is that nothing below runs while
 * `activate` is on the stack: `start()` is scheduled after it returns, so both
 * views are registered and rendering before any directory is walked.
 *
 * It holds no judgements. Which repositories exist is `discovery/`; what each
 * row says is `view/row.ts`; what order they come in is `view/order.ts`. What
 * is here is sequencing: when a pass runs, what cancels it, and which answer is
 * allowed to reach the screen.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

import { RepositoryCache } from './discovery/cache.ts';
import type { DiscoveryInput } from './discovery/repositories.ts';
import { createWorkspaceSearcher } from './discovery/vscodeSearch.ts';
import { pathKey } from './model/keys.ts';
import {
  DEFAULT_REFRESH_MINUTES,
  WATCHED_GIT_PATHS,
  refreshIntervalMs,
  shouldRefreshOnFocus,
} from './model/refresh.ts';
import type {
  ActivityAuthor,
  ActivityView,
  Commit,
  CommitFile,
  DiscoveredRepository,
  FilterMode,
  HistoryModel,
  HistoryStatus,
  PaneMode,
  ListModel,
  ListStatus,
  RepositoryRow,
  RowAction,
  SortMode,
} from './model/types.ts';
import { readDirtyState, readRows } from './read/reader.ts';
import { readActivity, type ActivityEntry, type ActivityFailure } from './read/activity.ts';
import { fetchRepositories, fetchSentence } from './read/fetch.ts';
import {
  buildActivityReport,
  renderActivityReport,
  windowPhrase,
} from './report/activityReport.ts';
import { ReportPanel } from './view/reportPanel.ts';
import {
  ACTIVITY_PERIODS,
  PERIOD_LABELS,
  authorLabels,
  authorOf,
  authorsOf,
  failureSentence,
  filterActivity,
  groupByDay,
  sinceFor,
  summarise,
  timeOf,
  type ActivityPeriod,
} from './view/activity.ts';
import { resetCliCache } from './forge/cli.ts';
import { readReviewCounts, targetKey } from './forge/counts.ts';
import { forgeKindOf, parseForgeTarget, type ForgeTarget } from './forge/remote.ts';
import { BADGE_MODES, DEFAULT_BADGE_MODE, badgeFor, type BadgeMode } from './view/badge.ts';
import { filterRows, isUnreadable, sortRows, tallyOf } from './view/order.ts';
import { HistoryViewProvider, type HistoryRequest } from './view/historyPanel.ts';
import { ListViewProvider, type PanelRequest } from './view/listPanel.ts';
import { BLOB_SCHEME, BlobFileSystemProvider, blobUri } from './git/blobFileSystem.ts';
import { readCommitFiles } from './read/commitFiles.ts';
import { DEFAULT_PAGE_SIZE, readHistory, readUnpushed } from './read/history.ts';
import { log } from './util/log.ts';

const SORT_KEY = 'multirepoLedger.sort';
const FILTER_KEY = 'multirepoLedger.filter';
const STATE_CONTEXT = 'multirepoLedger.state';

/**
 * A burst of watcher events becomes one pass.
 *
 * An agent rewriting refs, or a `git fetch --all` across a directory, fires
 * many times a second; without this each event would start its own walk. The
 * value is a guard against that burst rather than a figure measured anywhere:
 * long enough to swallow a burst, short enough that a human pressing Refresh
 * does not notice it.
 */
const PASS_DEBOUNCE_MS = 300;

export class LedgerController implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly list: ListViewProvider;
  private readonly history: HistoryViewProvider;
  private readonly blobs = new BlobFileSystemProvider();
  private readonly cache = new RepositoryCache();
  private readonly disposables: vscode.Disposable[] = [];

  private watchers: vscode.FileSystemWatcher[] = [];
  private rows: RepositoryRow[] = [];
  private status: ListStatus = { kind: 'scanning' };
  private selectedPath: string | undefined;
  private historySelection: RepositoryRow | undefined;
  private commits: Commit[] = [];
  private files: readonly CommitFile[] | undefined;
  private expanded: string | undefined;
  private historyMore = false;
  private historyUnpushedKnown = false;
  private historyAbort: AbortController | undefined;
  private historyGeneration = 0;
  private filesGeneration = 0;
  /**
   * The pane opens on the digest, not on a repository.
   *
   * Reading one repository's history is what every git extension in the editor
   * already does; reading across all of them is the only thing this one adds.
   * Opening on `selected` put the answer nobody else gives behind a control the
   * reader had to find first, and made the extension look like a slower version
   * of what they already had. Clicking a row still moves the pane to that
   * repository - that gesture is unambiguous and it says which one.
   */
  private paneMode: PaneMode = 'selected';
  private activityPeriod: ActivityPeriod = 'week';
  private activityEntries: ActivityEntry[] = [];
  private activityFailures = '';
  private activityFailureList: ActivityFailure[] = [];
  private activityMergesOnly = false;
  /**
   * The person the digest is narrowed to, held whole rather than as a key.
   *
   * Whole, because the picker has to keep offering them after the reader
   * narrows the period past their last commit: an option that vanishes takes
   * the filter with it and widens the list behind the reader's back. Holding
   * the record means the label survives even when the current answer no longer
   * contains a single commit of theirs.
   */
  private activityAuthor: ActivityAuthor | undefined;
  /** A fetch is in flight; a second one must not start behind it. */
  private fetching = false;
  /** The periodic re-read, for everything file watching does not reach. */
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * When the last pass finished, so focus does not stack a read on a read.
   *
   * Zero until one has finished, which is what tells the focus handler that
   * the first pass is still running.
   */
  private lastPassFinishedAt = 0;
  private activityAbort: AbortController | undefined;
  private activityGeneration = 0;
  private generation = 0;

  private passTimer: NodeJS.Timeout | undefined;
  private passRunning = false;
  private passQueued = false;
  private rediscoverPending = false;
  private passAbort: AbortController | undefined;
  private disposed = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.list = new ListViewProvider(context);
    this.history = new HistoryViewProvider(context);

    this.disposables.push(
      this.list,
      vscode.window.registerWebviewViewProvider(ListViewProvider.viewType, this.list, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this.list.onDidRequest((request) => void this.handleRequest(request)),
      this.history,
      vscode.window.registerWebviewViewProvider(HistoryViewProvider.viewType, this.history, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this.history.onDidRequest((request) => void this.handleHistoryRequest(request)),
      this.blobs,
      // Read-only, and registered once for the session: a commit is immutable,
      // so nothing reached through this scheme can change under the editor.
      vscode.workspace.registerFileSystemProvider(BLOB_SCHEME, this.blobs, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
    );

    // Render before anything is read: `start()` does not run until activation
    // has returned, and without this the panel would sit blank for the length
    // of a walk with nothing on screen saying why.
    this.status = this.hasSomethingToSearch() ? { kind: 'scanning' } : { kind: 'nothing-to-scan' };
    this.publish(true);
    void this.setStateContext();

    this.registerCommands();
    this.registerListeners();
  }

  /** Called after `activate` has returned, so a walk never delays the view. */
  async start(): Promise<void> {
    // The pass reads the commits as well, whichever scope the pane is in: the
    // author list on the board is built from that answer, and `All` has to be
    // instant rather than a second wait the reader pays for having pressed it.
    await this.refresh({ rediscover: true });
  }

  dispose(): void {
    this.disposed = true;
    this.passAbort?.abort();
    this.historyAbort?.abort();
    this.activityAbort?.abort();
    if (this.passTimer) {
      clearTimeout(this.passTimer);
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.cache.cancel();
    ReportPanel.dispose();
    this.disposeWatchers();
    for (const item of this.disposables.splice(0, this.disposables.length)) {
      item.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  /**
   * One pass: discover if asked, read every row, then fill in dirty state.
   *
   * Two passes never overlap. A second request while one is running is
   * remembered and run afterwards rather than started alongside, because two
   * concurrent passes would interleave their rows and the board would end up
   * describing two different moments at once.
   */
  async refresh(options: { rediscover?: boolean } = {}): Promise<void> {
    // A request to rediscover must survive being coalesced: debouncing a folder
    // change behind a burst of ref writes would otherwise quietly downgrade it
    // to a plain re-read, and the new folder's repositories would never appear.
    this.rediscoverPending = this.rediscoverPending || options.rediscover === true;

    if (this.passRunning) {
      this.passQueued = true;
      return;
    }
    this.passRunning = true;

    const rediscover = this.rediscoverPending;
    this.rediscoverPending = false;

    // Everything this pass spawns hangs off one controller, so superseding it is
    // one call and no answer from it can reach the screen afterwards.
    this.passAbort?.abort();
    const abort = new AbortController();
    this.passAbort = abort;
    const generation = ++this.generation;

    try {
      if (!this.hasSomethingToSearch()) {
        this.rows = [];
        this.status = { kind: 'nothing-to-scan' };
        this.publish(false);
        await this.setStateContext();
        return;
      }

      if (rediscover) {
        this.cache.invalidate();
      }

      this.status = { kind: 'scanning' };
      this.publish(true);

      const repositories = await this.cache.get(this.discoveryInput(abort.signal));
      if (abort.signal.aborted || generation !== this.generation) {
        return;
      }
      log.info(`discovered ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`);

      if (repositories.length === 0) {
        this.rows = [];
        this.status = { kind: 'no-repositories' };
        this.publish(false);
        await this.setStateContext();
        return;
      }

      this.installWatchers(repositories);

      // Rows replace the previous board wholesale rather than merging into it:
      // a repository that has since been deleted must leave, and a row read
      // before a folder change must not sit beside one read after it.
      const collected: RepositoryRow[] = [];
      this.rows = collected;
      this.status = { kind: 'ready' };

      const outcome = await readRows({
        repositories,
        signal: abort.signal,
        concurrency: this.concurrency(),
        onRow: (row) => {
          if (generation !== this.generation) {
            return;
          }
          collected.push(row);
          this.publish(true);
        },
      });

      if (abort.signal.aborted || generation !== this.generation) {
        return;
      }

      if (outcome.disabled === 'no-git') {
        this.status = { kind: 'no-git' };
        this.publish(false);
        await this.setStateContext();
        return;
      }

      this.publish(this.dirtyEnabled());
      await this.setStateContext();

      // Tier two, behind the board rather than in front of it. The list is
      // already readable; this only adds the one column that costs a second
      // process per repository, and it is skipped entirely when switched off.
      if (this.dirtyEnabled()) {
        await readDirtyState({
          rows: collected,
          signal: abort.signal,
          concurrency: this.concurrency(),
          onRow: (row) => {
            if (generation !== this.generation) {
              return;
            }
            const at = collected.findIndex(
              (existing) => pathKey(existing.repository.path) === pathKey(row.repository.path),
            );
            if (at >= 0) {
              collected[at] = row;
              this.publish(true);
            }
          },
        });
        if (generation === this.generation) {
          this.publish(false);
        }
      }

      // The commits, from the same pass that read the rows.
      //
      // They used to be read only on start-up, on the Refresh button, and when
      // the period changed - never from a pass. So a commit that landed while
      // the window was open moved the row above and left the list below it
      // showing the answer from whenever the period was last touched. It was
      // reported as "the extension did not refresh", and the reporter had found
      // the workaround without knowing it was one: switching the period and
      // back was the only thing on screen that re-read the commits.
      //
      // It costs one `git log` per repository on top of the row read, which is
      // why it sits behind the whole board being on screen rather than in front
      // of it.
      if (generation === this.generation && !abort.signal.aborted) {
        await this.loadActivity();
      }

      // Last, and only when the reader has switched it on. Everything above is
      // a local read; this is the one thing that leaves the machine, so it runs
      // behind a board that is already complete and useful without it.
      if (this.forgeEnabled()) {
        await this.readReviews(collected, abort.signal, generation);
      }
    } catch (error) {
      log.error('pass failed', error);
    } finally {
      this.passRunning = false;
      this.lastPassFinishedAt = Date.now();
      if (this.passQueued && !this.disposed) {
        this.passQueued = false;
        void this.refresh();
      }
    }
  }

  private schedulePass(rediscover = false): void {
    this.rediscoverPending = this.rediscoverPending || rediscover;
    if (this.passTimer) {
      clearTimeout(this.passTimer);
    }
    this.passTimer = setTimeout(() => {
      this.passTimer = undefined;
      void this.refresh();
    }, PASS_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Hand the current board to the panel.
   *
   * Sorting and filtering happen here, on every publish, rather than once when
   * the rows arrive: a row that gains a commit date changes where it belongs,
   * and a board that kept its first ordering would be wrong the moment the
   * second repository answered.
   */
  private publish(busy: boolean): void {
    const filtered = filterRows(this.rows, this.filter);
    const sorted = sortRows(filtered, this.sort);
    const model: ListModel = {
      rows: sorted,
      // The tally counts the whole board, not the filtered slice: a chip that
      // vanished the moment you pressed it would leave no way back.
      tally: tallyOf(this.rows),
      status: this.status,
      sort: this.sort,
      filter: this.filter,
      busy,
      fetchEnabled: this.config.get<boolean>('fetch.enabled', false),
      generation: this.generation,
      ...(this.selectedPath === undefined ? {} : { selectedPath: this.selectedPath }),
      period: this.activityPeriod,
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { authorId: this.activityAuthor.id }),
      authors: this.offeredAuthors(),
    };
    this.list.setModel(model);
    // From the whole board rather than the filtered slice: the badge is what
    // the reader sees while this panel is closed, and a number that moved
    // because of a filter set inside the panel would be unreadable from
    // outside it.
    this.list.setBadge(badgeFor(model.tally, this.badgeMode()));
  }

  // -------------------------------------------------------------------------
  // What the panel asks for
  // -------------------------------------------------------------------------

  private async handleRequest(request: PanelRequest): Promise<void> {
    switch (request.type) {
      case 'refresh':
        // The pass re-reads the commits too. It used to do so only in the `All`
        // scope, so pressing Refresh while looking at one repository - the
        // default - left the very list the reader was looking at untouched.
        await this.refresh({ rediscover: true });
        return;
      case 'sort':
        await this.context.workspaceState.update(SORT_KEY, request.sort);
        this.publish(this.passRunning);
        return;
      case 'filter':
        await this.context.workspaceState.update(FILTER_KEY, request.filter);
        this.publish(this.passRunning);
        return;
      case 'period': {
        if (!(ACTIVITY_PERIODS as readonly string[]).includes(request.period)) {
          return;
        }
        this.activityPeriod = request.period as ActivityPeriod;
        this.publish(this.passRunning);
        // The period governs the pane's list and the report alike, so a change
        // here re-reads rather than re-filtering what an older period fetched.
        await this.loadActivity();
        return;
      }
      case 'commitFilter':
        if (request.mergesOnly !== undefined) {
          this.activityMergesOnly = request.mergesOnly;
        }
        if (request.authorId !== undefined) {
          this.activityAuthor =
            request.authorId.length > 0 ? this.authorFor(request.authorId) : undefined;
        }
        this.publishActivity(false);
        return;
      case 'settings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'multirepoLedger.additionalRoots',
        );
        return;
      case 'select':
        this.select(request.path);
        return;
      case 'action':
        await this.act(request.action, request.path);
        return;
    }
  }

  /**
   * Clicking a row selects it, and that is the whole of what a click does.
   *
   * The pane below follows the selection - that is the shape the two views were
   * asked for: a list on top, and the selected repository's history beneath it.
   * So the click has to stay inert. Opening a folder, revealing it in Source
   * Control or spawning a terminal all change something outside this view, and
   * an action that big has to be aimed at rather than triggered by landing on a
   * row while scrolling.
   *
   * Rejected: opening the repository in a new window on a plain click, which is
   * what an earlier version of this file did. It takes the reader out of the
   * board they are reading, on the one gesture they will make most often and
   * most casually, and there is no undo for a window.
   */
  private select(target: string): void {
    const row = this.rows.find((entry) => pathKey(entry.repository.path) === pathKey(target));
    log.info(row ? `selected ${row.repository.label}` : `selected a path no row holds: ${target}`);
    this.selectedPath = row ? row.repository.path : undefined;
    this.historySelection = row;
    this.paneMode = 'selected';
    this.history.reveal();
    this.publishActivity(false);
  }

  private async act(action: RowAction, target: string): Promise<void> {
    const uri = vscode.Uri.file(target);
    switch (action) {
      case 'open-window':
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        return;
      case 'add-to-workspace':
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri },
        );
        return;
      case 'reveal-in-scm':
        // Handing the repository to the built-in git extension is acceptable
        // as a labelled action the reader asked for, and would not be as a
        // side effect: it adds the repository to their Source Control view and
        // keeps it there.
        await this.openInSourceControl(uri);
        return;
      case 'open-terminal':
        vscode.window.createTerminal({ cwd: uri, name: path.basename(target) }).show();
        return;
      case 'fetch': {
        const row = this.rows.find((entry) => pathKey(entry.repository.path) === pathKey(target));
        if (row) {
          await this.fetch([row]);
        }
        return;
      }
      case 'copy-path':
        await vscode.env.clipboard.writeText(target);
        void vscode.window.showInformationMessage(`Copied ${target}`);
        return;
    }
  }

  private async openInSourceControl(uri: vscode.Uri): Promise<void> {
    const git = vscode.extensions.getExtension('vscode.git');
    if (!git) {
      void vscode.window.showWarningMessage('The built-in Git extension is not available.');
      return;
    }
    try {
      const exports = (await git.activate()) as {
        getAPI?: (version: number) => { openRepository?: (root: string) => Promise<unknown> };
      };
      const api = exports.getAPI?.(1);
      await api?.openRepository?.(uri.fsPath);
      await vscode.commands.executeCommand('workbench.view.scm');
    } catch (error) {
      log.error('could not open the repository in Source Control', error);
    }
  }


  // -------------------------------------------------------------------------
  // The history pane
  // -------------------------------------------------------------------------

  /**
   * Read one page of the selected repository's history.
   *
   * A read for a selection the reader has since moved off is abandoned rather
   * than rendered: clicking down a list of forty repositories starts forty
   * reads, and without this the pane would flicker through all of them and
   * settle on whichever `git log` happened to finish last.
   */
  private async loadHistory(row: RepositoryRow | undefined, skip: number): Promise<void> {
    this.historyAbort?.abort();
    if (!row) {
      this.historySelection = undefined;
      this.commits = [];
      this.publishHistory({ kind: 'no-selection' }, false);
      return;
    }

    const abort = new AbortController();
    this.historyAbort = abort;
    const token = ++this.historyGeneration;
    const label = row.repository.label;
    const cwd = row.repository.path;
    this.historySelection = row;

    if (row.head.kind === 'unborn') {
      // Answered from what the row already knows: `git log` on a repository
      // with no commits fails, and reporting that failure as "unreadable"
      // would blame the repository for being new.
      this.commits = [];
      this.publishHistory({ kind: 'unborn', label }, false);
      return;
    }
    if (row.failure) {
      this.commits = [];
      this.publishHistory(
        {
          kind: 'unreadable',
          label,
          reason: [row.failure.summary, row.failure.command, row.failure.stderr]
            .filter((part) => part.length > 0)
            .join('\n'),
        },
        false,
      );
      return;
    }

    if (skip === 0) {
      this.commits = [];
      this.expanded = undefined;
      this.files = undefined;
      this.publishHistory({ kind: 'reading', label }, true);
    } else {
      this.publishHistory({ kind: 'ready' }, true);
    }

    const limit = this.pageSize();
    const result = await readHistory({ cwd, limit, skip, signal: abort.signal });
    if (token !== this.historyGeneration) {
      return;
    }

    if (result.failure) {
      this.commits = [];
      this.publishHistory(
        {
          kind: 'unreadable',
          label,
          reason: [result.failure.command, result.failure.stderr].join('\n'),
        },
        false,
      );
      return;
    }

    // The unpushed set costs a second process, so it is asked for only when the
    // row already said there was something ahead. When it was not asked, the
    // page says so rather than marking every commit as pushed.
    let unpushedKnown = false;
    let commits: Commit[] = result.commits;
    const ahead = row.divergence.kind === 'diverged' ? row.divergence.ahead : 0;
    if (ahead > 0) {
      const unpushed = await readUnpushed({ cwd, limit: limit + skip, signal: abort.signal });
      if (token !== this.historyGeneration) {
        return;
      }
      unpushedKnown = true;
      commits = commits.map((commit) =>
        unpushed.has(commit.sha) ? { ...commit, unpushed: true } : commit,
      );
    }

    this.commits = skip === 0 ? commits : [...this.commits, ...commits];
    this.historyMore = result.more;
    this.historyUnpushedKnown = unpushedKnown;
    this.publishHistory({ kind: 'ready' }, false);
  }

  private async handleHistoryRequest(request: HistoryRequest): Promise<void> {
    switch (request.type) {
      case 'more':
        await this.loadHistory(this.historySelection, this.commits.length);
        return;
      case 'expand':
        await this.expandCommit(request.sha);
        return;
      case 'diff':
        await this.openDiff(request.sha, request.path);
        return;
      case 'scope': {
        if (request.scope !== 'selected' && request.scope !== 'all') {
          return;
        }
        this.paneMode = request.scope;
        this.publishActivity(false);
        return;
      }
      case 'openAt':
        await this.openFromDigest(request.repositoryPath, request.sha);
        return;
    }
  }

  /**
   * At most one commit's file list is open at a time.
   *
   * Keeping several open would mean holding several `diff-tree` results and
   * re-reading them on every render; one is what a reader is looking at, and
   * pressing the open one closes it.
   */
  private async expandCommit(sha: string): Promise<void> {
    if (this.expanded === sha) {
      this.expanded = undefined;
      this.files = undefined;
      this.publishHistory({ kind: 'ready' }, false);
      return;
    }

    this.expanded = sha;
    this.files = undefined;
    this.publishHistory({ kind: 'ready' }, false);

    const row = this.historySelection;
    if (!row) {
      return;
    }
    const token = ++this.filesGeneration;
    const result = await readCommitFiles({ cwd: row.repository.path, sha });
    if (token !== this.filesGeneration || this.expanded !== sha) {
      return;
    }
    this.files = result.files;
    if (result.failure) {
      log.error(`could not list the files of ${sha}: ${result.failure.stderr}`);
    }
    this.publishHistory({ kind: 'ready' }, false);

    // Selecting a commit opens what it changed, in the editor, which is what
    // the pane is for: the list of files below stays as the way to reach one
    // file on its own, and the multi-file diff is the whole commit at once.
    await this.openCommitDiff(sha, result.files);
  }

  /**
   * Open every file a commit changed, as one multi-file diff in the editor.
   *
   * `vscode.changes` is the same editor the built-in Git extension opens for a
   * commit, so a reader gets the surface they already know rather than a second
   * one this extension invented. Each entry is the file's own path - which is
   * what the editor labels the entry with - and the two sides to compare.
   *
   * Rejected: opening one `vscode.diff` per changed file, which is what an
   * earlier version did through the file list alone. A commit touching thirty
   * files would open thirty tabs, and the reader asked to see a commit rather
   * than to be handed its files one at a time.
   *
   * A merge opens nothing: `diff-tree` reports no files for it without being
   * told which parent to compare against, and picking one silently would show a
   * diff that is true against one side and misleading against the other.
   */
  private async openCommitDiff(sha: string, files: readonly CommitFile[]): Promise<void> {
    const row = this.historySelection;
    if (!row || files.length === 0) {
      return;
    }
    const commit = this.commits.find((entry) => entry.sha === sha);
    if (commit && commit.parents.length > 1) {
      return;
    }
    const repo = row.repository.path;
    const parent = commit?.parents[0] ?? '';
    const short = commit?.shortSha ?? sha.slice(0, 7);

    const changes = files.map((file) => [
      // The label the editor shows. A file the commit deleted no longer exists
      // on disk, and naming it by its own path is still what the reader is
      // looking for in the list.
      vscode.Uri.file(path.join(repo, file.path)),
      // A file this commit added has no previous revision: the empty side is
      // asked for by an empty object id, which is what git shows too.
      blobUri(repo, file.status === 'A' ? '' : parent, file.oldPath ?? file.path),
      blobUri(repo, file.status === 'D' ? '' : sha, file.path),
    ]);

    const title = commit ? `${commit.subject} (${short})` : short;
    try {
      await vscode.commands.executeCommand('vscode.changes', title, changes);
    } catch (error) {
      log.error('could not open the commit diff', error);
      void vscode.window.showErrorMessage(`Multirepo Ledger could not open the diff for ${short}.`);
    }
  }

  /**
   * Open one file of a commit in the editor's own diff, against its parent.
   *
   * Both sides come from this extension's read-only scheme rather than from the
   * built-in `git:` one, which resolves only for repositories the editor has
   * opened - and every repository on this board is one it has not.
   *
   * A first commit has no parent, so the left-hand side is the empty document,
   * which is what git shows too.
   */
  private async openDiff(sha: string, filePath: string): Promise<void> {
    const row = this.historySelection;
    if (!row) {
      return;
    }
    const commit = this.commits.find((entry) => entry.sha === sha);
    const parent = commit?.parents[0] ?? '';
    const repo = row.repository.path;
    const short = commit?.shortSha ?? sha.slice(0, 7);

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        blobUri(repo, parent, filePath),
        blobUri(repo, sha, filePath),
        `${filePath} (${short})`,
        { preview: true },
      );
    } catch (error) {
      log.error('could not open the diff', error);
      void vscode.window.showErrorMessage(`Multirepo Ledger could not open ${filePath} at ${short}.`);
    }
  }

  private publishHistory(status: HistoryStatus, busy: boolean): void {
    if (this.paneMode === 'all') {
      this.publishActivity(busy);
      return;
    }
    const row = this.historySelection;
    const model: HistoryModel = {
      mode: 'selected',
      ...(row ? { selectedLabel: row.repository.label } : {}),
      status,
      busy,
      ...(row && this.commits.length > 0
        ? {
            page: {
              repositoryPath: row.repository.path,
              label: row.repository.label,
              commits: this.commits,
              unpushedKnown: this.historyUnpushedKnown,
              more: this.historyMore,
            },
          }
        : {}),
      ...(this.expanded === undefined ? {} : { expanded: this.expanded }),
      ...(this.files === undefined ? {} : { files: this.files }),
    };
    this.history.setModel(model);
  }

  private pageSize(): number {
    const configured = this.config.get<number>('history.pageSize', DEFAULT_PAGE_SIZE);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PAGE_SIZE;
  }


  // -------------------------------------------------------------------------
  // Review counts
  // -------------------------------------------------------------------------

  /**
   * Fill in open merge and pull request counts, batched by owner.
   *
   * Runs only when `multirepoLedger.forge.enabled` is on, and only over repositories
   * whose remote points at a host this version has a client for. A repository
   * the queries did not cover keeps `review` absent, which the row renders as
   * silence - never as a zero, because "nobody asked" and "nothing is open" are
   * different facts and only one of them is good news.
   */
  private async readReviews(
    rows: RepositoryRow[],
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const targets = new Map<string, ForgeTarget>();
    const byKey = new Map<string, RepositoryRow[]>();

    for (const row of rows) {
      const url = row.remoteUrl;
      if (url === undefined) {
        continue;
      }
      const target = parseForgeTarget(url);
      if (!target || forgeKindOf(target.host) === undefined) {
        continue;
      }
      const key = targetKey(target);
      targets.set(key, target);
      const existing = byKey.get(key);
      if (existing) {
        // Two working trees of the same repository - a linked worktree beside
        // its main checkout - share one remote and one count, and asking twice
        // would spend a query on an answer already held.
        existing.push(row);
      } else {
        byKey.set(key, [row]);
      }
    }

    if (targets.size === 0) {
      return;
    }

    this.publish(true);
    const states = await readReviewCounts({ targets, signal });
    if (signal.aborted || generation !== this.generation) {
      return;
    }

    for (const [key, state] of states) {
      for (const row of byKey.get(key) ?? []) {
        const at = rows.indexOf(row);
        if (at >= 0) {
          rows[at] = { ...row, review: state };
        }
      }
    }
    this.publish(false);
  }


  /**
   * The digest as a document, in the editor.
   *
   * The pane answers "what happened" in a column two hundred pixels wide, which
   * is enough to notice something and not enough to add anything up. This is
   * the same read arranged into tables - per repository, per author, per day -
   * in a window with room for them.
   *
   * An untitled markdown document rather than a webview: it opens in the editor
   * the reader already has, and it can be saved, pasted into a stand-up note,
   * or diffed against last week's. A webview would look better and could do
   * none of those.
   *
   * It runs its own read rather than reusing the pane's, because the pane may be
   * showing a filtered view or a different period, and a report that silently
   * inherited a filter would be a document whose numbers nobody could reproduce.
   */
  private async openActivityReport(): Promise<void> {
    const repositories = this.cache.current ?? [];
    if (repositories.length === 0) {
      void vscode.window.showInformationMessage(
        'Multirepo Ledger has not found any repositories to report on yet.',
      );
      return;
    }

    const period = this.activityPeriod;

    // On screen before the reading starts, not after it finishes. The read is
    // one `git log` per repository and takes as long as somebody else's disk
    // takes; while it ran, nothing appeared at all, so pressing the button and
    // pressing nothing looked the same for several seconds. The panel now goes
    // up immediately carrying what is already known - the period and how many
    // repositories are being asked - and a bar that says the work is running.
    //
    // The window progress that used to stand in for this is gone with it: it
    // reported the same thing in the corner of the editor, where a reader
    // watching the space the report will appear in never saw it.
    ReportPanel.open(PERIOD_LABELS[period], windowPhrase(period), repositories.length);

    const result = await readActivity({
      repositories,
      since: sinceFor(period),
      concurrency: this.concurrency(),
    });
    // The same filters the pane is showing. A report that ignored them - which
    // this one did - answers a question the reader did not ask, and its
    // figures cannot be reconciled with what is on screen beside it.
    const input = {
      entries: filterActivity(result.entries, {
        mergesOnly: this.activityMergesOnly,
        ...(this.activityAuthor === undefined ? {} : { authorId: this.activityAuthor.id }),
      }),
      failures: result.failures,
      period,
      discovered: repositories.length,
      now: Date.now(),
    };
    // The panel renders the structure; the markdown rides along so the Copy
    // button can hand over something that pastes into a stand-up note.
    ReportPanel.show(buildActivityReport(input), renderActivityReport(input));
  }

  private forgeEnabled(): boolean {
    return this.config.get<boolean>('forge.enabled', false);
  }


  // -------------------------------------------------------------------------
  // The cross-repository digest
  // -------------------------------------------------------------------------

  /**
   * Read every repository's recent commits and publish them as one list.
   *
   * This is the question no other surface in the editor answers, and it is why
   * the pane has two modes rather than one. One `git log` per repository, at the
   * same derived concurrency as the board, and nothing cached: a stale answer to
   * "what landed today" is worse than a slow one.
   */
  private async loadActivity(): Promise<void> {
    this.activityAbort?.abort();
    const abort = new AbortController();
    this.activityAbort = abort;
    const token = ++this.activityGeneration;

    const repositories = this.cache.current ?? [];
    if (repositories.length === 0) {
      this.activityEntries = [];
      this.activityFailureList = [];
      this.activityFailures = '';
      this.publishActivity(false);
      return;
    }

    this.publishActivity(true);

    const result = await readActivity({
      repositories,
      since: sinceFor(this.activityPeriod),
      signal: abort.signal,
      concurrency: this.concurrency(),
    });
    if (token !== this.activityGeneration || abort.signal.aborted) {
      return;
    }

    this.activityEntries = result.entries;
    this.activityFailureList = result.failures;
    this.activityFailures = failureSentence(result.failures) ?? '';
    log.info(
      `digest: ${result.entries.length} commits from ${result.asked} of ${repositories.length} repositories`,
    );
    this.publishActivity(false);
  }

  /**
   * Everyone the picker offers.
   *
   * Drawn from the whole answer rather than the scoped one, so choosing a
   * repository does not empty the control that chooses a person, and the
   * currently chosen person is appended when the answer no longer holds any of
   * their commits - with a zero on them, because a count nobody established and
   * a count of none are different facts and this one is established.
   */
  private offeredAuthors(): ActivityAuthor[] {
    const authors = authorsOf(this.activityEntries);
    const chosen = this.activityAuthor;
    if (chosen !== undefined && !authors.some((author) => author.id === chosen.id)) {
      return [...authors, { ...chosen, commits: 0 }];
    }
    return authors;
  }

  /** The person behind an identity key the page sent back. */
  private authorFor(id: string): ActivityAuthor {
    const known = this.offeredAuthors().find((author) => author.id === id);
    // An id with nobody behind it can only come from a page that outlived the
    // answer it was drawn from. It still filters correctly - the key is what
    // filtering compares - so it is kept rather than dropped, labelled with the
    // address itself rather than with a name this extension would be inventing.
    return known ?? { id, label: id, email: id.startsWith('name:') ? '' : id, names: [], commits: 0 };
  }

  /**
   * The pane's list, in whichever scope it is in.
   *
   * One read and one filter path for both scopes. `Selected` used to be a
   * separate `git log` down a different code path, which is why the period, the
   * merges toggle and the author picker did nothing in it - the default scope -
   * and why a reader pressing them saw the list sit there. `Selected` is now the
   * same list narrowed to one repository, so a filter cannot apply to one scope
   * and not the other.
   */
  private publishActivity(busy: boolean): void {
    const scoped =
      this.paneMode === 'selected' && this.selectedPath !== undefined
        ? this.activityEntries.filter(
            (entry) => pathKey(entry.repositoryPath) === pathKey(this.selectedPath ?? ''),
          )
        : this.activityEntries;

    const filtered = filterActivity(scoped, {
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { authorId: this.activityAuthor.id }),
    });
    const summary = summarise(filtered, this.activityPeriod);
    const authors = this.offeredAuthors();
    const labels = authorLabels(authors);

    const activity: ActivityView = {
      period: this.activityPeriod,
      summary: summary.sentence,
      ...(this.activityFailures.length > 0 && this.paneMode === 'all'
        ? { unreadable: this.activityFailures }
        : {}),
      days: groupByDay(filtered, Date.now()).map((day) => ({
        heading: day.heading,
        entries: day.entries.map((entry) => ({
          repositoryPath: entry.repositoryPath,
          label: entry.label,
          sha: entry.commit.sha,
          shortSha: entry.commit.shortSha,
          time: timeOf(entry.commit.committedAt),
          ...authorOf(entry, labels),
          subject: entry.commit.subject,
          merge: entry.commit.parents.length > 1,
        })),
      })),
      authors,
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { authorId: this.activityAuthor.id }),
    };

    // The board's author list comes from the same read.
    this.publish(this.passRunning);

    const status: HistoryStatus =
      this.paneMode === 'selected' && this.selectedPath === undefined
        ? { kind: 'no-selection' }
        : { kind: 'ready' };

    this.history.setModel({
      mode: this.paneMode,
      activity,
      status,
      busy,
      ...(this.paneMode === 'selected' && this.historySelection
        ? { selectedLabel: this.historySelection.repository.label }
        : {}),
    });
  }

  /**
   * Open a commit that belongs to a repository other than the selected one.
   *
   * The digest spans every repository, so a click in it has to carry where the
   * commit lives; the single-repository pane never needs that because the
   * selection already says it.
   */
  private async openFromDigest(repositoryPath: string, sha: string): Promise<void> {
    const files = await readCommitFiles({ cwd: repositoryPath, sha });
    if (files.failure) {
      log.error(`could not list the files of ${sha}: ${files.failure.stderr}`);
      void vscode.window.showErrorMessage(
        `Multirepo Ledger could not read ${sha.slice(0, 7)} in ${repositoryPath}.`,
      );
      return;
    }
    if (files.files.length === 0) {
      void vscode.window.showInformationMessage(
        `${sha.slice(0, 7)} is a merge, so its changes belong to its parents.`,
      );
      return;
    }
    const changes = files.files.map((file) => [
      vscode.Uri.file(path.join(repositoryPath, file.path)),
      blobUri(repositoryPath, file.status === 'A' ? '' : `${sha}^`, file.oldPath ?? file.path),
      blobUri(repositoryPath, file.status === 'D' ? '' : sha, file.path),
    ]);
    try {
      await vscode.commands.executeCommand('vscode.changes', sha.slice(0, 7), changes);
    } catch (error) {
      log.error('could not open the commit diff', error);
    }
  }

  // -------------------------------------------------------------------------
  // Settings, watchers, commands
  // -------------------------------------------------------------------------

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('multirepoLedger');
  }

  private get sort(): SortMode {
    return this.context.workspaceState.get<SortMode>(SORT_KEY) ?? 'recent';
  }

  private get filter(): FilterMode {
    return this.context.workspaceState.get<FilterMode>(FILTER_KEY) ?? 'all';
  }

  private dirtyEnabled(): boolean {
    return this.config.get<boolean>('dirty.enabled', true);
  }

  private concurrency(): number {
    return this.config.get<number>('concurrency', 0);
  }

  private hasSomethingToSearch(): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length > 0 || this.config.get<string[]>('additionalRoots', []).length > 0;
  }

  /**
   * Fetch, in the repositories the reader asked about.
   *
   * The only thing in this extension that writes inside a repository, and it is
   * gated three ways: the setting is off until somebody turns it on, the button
   * is not drawn while it is off, and this refuses even if a command reaches it
   * some other way. A network call is not something a status board starts on
   * its own.
   *
   * Nothing is merged, rebased, pushed or pruned - see `read/fetch.ts` for why
   * a bulk button may not do those. What this changes is the freshness of the
   * evidence: after it, the ahead/behind figures on the board are measured
   * against remote-tracking refs that are current rather than against whatever
   * the last fetch left behind, which is why it ends in a read.
   */
  private async fetch(rows: readonly RepositoryRow[]): Promise<void> {
    if (!this.config.get<boolean>('fetch.enabled', false)) {
      const turnOn = 'Open settings';
      const answer = await vscode.window.showInformationMessage(
        'Fetching is off. Everything else the Ledger does is a local read, so the one thing that reaches the network ships disabled.',
        turnOn,
      );
      if (answer === turnOn) {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'multirepoLedger.fetch.enabled',
        );
      }
      return;
    }

    if (this.fetching) {
      // A second press while one is running would double the connections to
      // the same servers, which is the opposite of what the concurrency
      // setting is there to control.
      void vscode.window.showInformationMessage('A fetch is already running.');
      return;
    }

    const targets = rows.map((row) => row.repository);
    if (targets.length === 0) {
      return;
    }

    // How many at once is a question about somebody else's server, which this
    // machine cannot measure and this extension cannot see. So it is a setting,
    // and its default is deliberately timid.
    const concurrency = Math.max(1, this.config.get<number>('fetch.concurrency', 4));
    const remotes = new Map(
      rows.map((row) => [pathKey(row.repository.path), row.remoteUrl !== undefined]),
    );

    this.fetching = true;
    try {
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            targets.length === 1
              ? `Multirepo Ledger: fetching ${targets[0]?.label ?? ''}`
              : `Multirepo Ledger: fetching ${targets.length} repositories`,
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          let settled = 0;
          return fetchRepositories({
            repositories: targets,
            hasRemote: (path) => remotes.get(pathKey(path)) === true,
            concurrency,
            signal: controller.signal,
            onSettled: (label) => {
              settled += 1;
              progress.report({ message: `${settled} of ${targets.length} · ${label}` });
            },
          });
        },
      );

      // Every failure keeps git's own words and the command that produced them,
      // in the log, where they can be read in full and retyped. The notification
      // carries the count; the evidence is never squeezed into a toast.
      for (const failure of report.failures) {
        log.warn(`fetch failed in ${failure.label}: ${failure.command} -> ${failure.stderr}`);
      }
      log.info(fetchSentence(report));

      if (report.failures.length > 0) {
        const show = 'Show Log';
        const answer = await vscode.window.showWarningMessage(fetchSentence(report), show);
        if (answer === show) {
          await vscode.commands.executeCommand('multirepoLedger.showOutput');
        }
      } else {
        void vscode.window.setStatusBarMessage(`Multirepo Ledger: ${fetchSentence(report)}`, 6000);
      }
    } finally {
      this.fetching = false;
    }

    // The figures the fetch just made answerable are still the old ones until
    // something reads them again.
    this.schedulePass();
  }

  /** What the badge counts, as configured. */
  private badgeMode(): BadgeMode {
    const configured = this.config.get<string>('badge', DEFAULT_BADGE_MODE);
    // A value this version does not know can only come from a settings file
    // written by another one. It falls back rather than throwing, because a
    // typo in a setting must not cost the reader the whole board.
    return (BADGE_MODES as readonly string[]).includes(configured)
      ? (configured as BadgeMode)
      : DEFAULT_BADGE_MODE;
  }

  private discoveryInput(signal: AbortSignal): DiscoveryInput {
    return {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
        (folder) => folder.uri.fsPath,
      ),
      additionalRoots: this.config.get<string[]>('additionalRoots', []),
      exclude: this.config.get<string[]>('exclude', []),
      maxDepth: this.config.get<number>('maxDepth', 32),
      searchWorkspace: createWorkspaceSearcher(),
      signal,
      onMissingRoot: (missing) =>
        log.warn(`configured directory was not found and was skipped: ${missing}`),
    };
  }

  /**
   * Watch what changes a row, and nothing else.
   *
   * The paths are decided in `model/refresh.ts`, where a test asserts that
   * every state the row reports has something watching it - `refs/**` alone
   * missed a branch tip that lives only in `packed-refs`, a repository on the
   * reftable backend that has no `refs/` at all, and the start of a rebase.
   *
   * Watching is never the only mechanism. It degrades on network shares, it is
   * capped per platform, and a reader with `files.watcherExclude` set over
   * `.git` has switched it off without knowing what that costs here - so the
   * timer and the focus handler below cover what it misses.
   */
  private installWatchers(repositories: readonly DiscoveredRepository[]): void {
    this.disposeWatchers();
    for (const repository of repositories) {
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(repository.gitDir),
        WATCHED_GIT_PATHS,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.schedulePass());
      watcher.onDidCreate(() => this.schedulePass());
      watcher.onDidDelete(() => this.schedulePass());
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers.splice(0, this.watchers.length)) {
      watcher.dispose();
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('multirepoLedger.refresh', () => {
        // Signing in to `gh` while the window is open should take effect on the
        // next Refresh rather than on the next reload, and whether a tool is
        // signed in is remembered for the session.
        resetCliCache();
        return this.refresh({ rediscover: true });
      }),
      vscode.commands.registerCommand('multirepoLedger.activityReport', () =>
        this.openActivityReport(),
      ),
      vscode.commands.registerCommand('multirepoLedger.fetchAll', () =>
        // A repository git already refused to answer for is left out of the
        // bulk fetch: it would refuse this too, for the same reason, and the
        // row is already saying so in git's own words. Aiming the row's own
        // button at one is still honoured - that is somebody asking on
        // purpose.
        this.fetch(this.rows.filter((row) => !isUnreadable(row))),
      ),
      vscode.commands.registerCommand('multirepoLedger.openAdditionalRootsSetting', () =>
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'multirepoLedger.additionalRoots',
        ),
      ),
    );
  }

  /**
   * The periodic re-read, restarted whenever its setting changes.
   *
   * Skipped while the window is not focused. A board nobody is looking at does
   * not need to be current, and a machine with six editor windows open would
   * otherwise run six fans of `git` processes at the same moment for the
   * benefit of nobody. Coming back to a window is itself a trigger, so nothing
   * is lost by waiting for it.
   */
  private installRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    const everyMs = refreshIntervalMs(
      this.config.get<number>('refreshIntervalMinutes', DEFAULT_REFRESH_MINUTES),
    );
    if (everyMs === undefined) {
      log.info('periodic refresh is off');
      return;
    }

    log.info(`periodic refresh every ${Math.round(everyMs / 1000)}s`);
    this.refreshTimer = setInterval(() => {
      if (this.disposed || !vscode.window.state.focused) {
        return;
      }
      this.schedulePass();
    }, everyMs);
  }

  private registerListeners(): void {
    this.installRefreshTimer();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedulePass(true)),
      // Work done outside this editor while it sat in the background is the one
      // case neither the watcher nor the timer sees: the watcher because the
      // events arrive to a window that ignores them, the timer because it does
      // not run while unfocused. Somebody who pulls in a terminal, comes back,
      // and finds the board unchanged reads that as broken.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && shouldRefreshOnFocus(this.lastPassFinishedAt, Date.now())) {
          this.schedulePass();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // Only the settings that change what is discovered force a new walk;
        // the rest are picked up by the next publish.
        if (
          event.affectsConfiguration('multirepoLedger.additionalRoots') ||
          event.affectsConfiguration('multirepoLedger.exclude') ||
          event.affectsConfiguration('multirepoLedger.maxDepth')
        ) {
          this.schedulePass(true);
        } else if (
          event.affectsConfiguration('multirepoLedger.dirty.enabled') ||
          event.affectsConfiguration('multirepoLedger.concurrency') ||
          event.affectsConfiguration('multirepoLedger.forge.enabled')
        ) {
          this.schedulePass();
        } else if (event.affectsConfiguration('multirepoLedger.refreshIntervalMinutes')) {
          this.installRefreshTimer();
        } else if (
          event.affectsConfiguration('multirepoLedger.badge') ||
          event.affectsConfiguration('multirepoLedger.fetch.enabled')
        ) {
          // Nothing has to be read again - the tally the badge counts is
          // already in hand - but something does have to be published, or the
          // icon keeps counting what the reader just stopped asking for.
          this.publish(this.passRunning);
        }
      }),
    );
  }

  /**
   * The key the manifest's `viewsWelcome` entries are written against.
   *
   * Only two of the list's states have a welcome behind them, because the
   * others are sentences the list itself says better than a welcome can.
   */
  private async setStateContext(): Promise<void> {
    const value =
      this.status.kind === 'nothing-to-scan'
        ? 'noWorkspace'
        : this.status.kind === 'no-repositories'
          ? 'noRepositories'
          : this.status.kind === 'scanning'
            ? 'loading'
            : 'ready';
    await vscode.commands.executeCommand('setContext', STATE_CONTEXT, value);
  }
}
