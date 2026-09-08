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
import type {
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
import { buildActivityReport, renderActivityReport } from './report/activityReport.ts';
import { ReportPanel } from './view/reportPanel.ts';
import {
  ACTIVITY_PERIODS,
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
import { filterRows, sortRows, tallyOf } from './view/order.ts';
import { HistoryViewProvider, type HistoryRequest } from './view/historyPanel.ts';
import { ListViewProvider, type PanelRequest } from './view/listPanel.ts';
import { BLOB_SCHEME, BlobFileSystemProvider, blobUri } from './git/blobFileSystem.ts';
import { readCommitFiles } from './read/commitFiles.ts';
import { DEFAULT_PAGE_SIZE, readHistory, readUnpushed } from './read/history.ts';
import { log } from './util/log.ts';

const SORT_KEY = 'repoLedger.sort';
const FILTER_KEY = 'repoLedger.filter';
const STATE_CONTEXT = 'repoLedger.state';

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
  private activityAuthor: string | undefined;
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
    await this.refresh({ rediscover: true });
    // Read after the board, whichever scope the pane is in: the author list on
    // the board is built from this answer, and `All` has to be instant rather
    // than a second wait the reader pays for having pressed it.
    await this.loadActivity();
  }

  dispose(): void {
    this.disposed = true;
    this.passAbort?.abort();
    this.historyAbort?.abort();
    this.activityAbort?.abort();
    if (this.passTimer) {
      clearTimeout(this.passTimer);
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
      generation: this.generation,
      ...(this.selectedPath === undefined ? {} : { selectedPath: this.selectedPath }),
      period: this.activityPeriod,
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { author: this.activityAuthor }),
      authors: authorsOf(this.activityEntries),
    };
    this.list.setModel(model);
  }

  // -------------------------------------------------------------------------
  // What the panel asks for
  // -------------------------------------------------------------------------

  private async handleRequest(request: PanelRequest): Promise<void> {
    switch (request.type) {
      case 'refresh':
        await this.refresh({ rediscover: true });
        if (this.paneMode === 'all') {
          await this.loadActivity();
        }
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
        if (request.author !== undefined) {
          this.activityAuthor = request.author.length > 0 ? request.author : undefined;
        }
        this.publish(this.passRunning);
        if (this.paneMode === 'all') {
          this.publishActivity(false);
        }
        return;
      case 'settings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'repoLedger.additionalRoots',
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
    // Logged because this is the one interaction with no visible effect when it
    // goes wrong: a click that never arrives and a click that arrives and finds
    // no row look identical on screen, and the log is what tells them apart.
    log.info(row ? `selected ${row.repository.label}` : `selected a path no row holds: ${target}`);
    this.selectedPath = row ? row.repository.path : undefined;
    this.paneMode = 'selected';
    this.publish(this.passRunning);
    this.history.reveal();
    void this.loadHistory(row, 0);
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
        if (request.scope === 'all') {
          await this.loadActivity();
        } else {
          this.publishHistory(
            this.historySelection ? { kind: 'ready' } : { kind: 'no-selection' },
            false,
          );
        }
        return;
      }
      case 'openAt':
        await this.openFromDigest(request.repositoryPath, request.sha);
        return;
      case 'report':
        await this.openActivityReport();
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
      void vscode.window.showErrorMessage(`Repo Ledger could not open the diff for ${short}.`);
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
      void vscode.window.showErrorMessage(`Repo Ledger could not open ${filePath} at ${short}.`);
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
   * Runs only when `repoLedger.forge.enabled` is on, and only over repositories
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
        'Repo Ledger has not found any repositories to report on yet.',
      );
      return;
    }

    const period = this.activityPeriod;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Repo Ledger: reading every repository' },
      async () => {
        const result = await readActivity({
          repositories,
          since: sinceFor(period),
          concurrency: this.concurrency(),
        });
        const input = {
          entries: result.entries,
          failures: result.failures,
          period,
          discovered: repositories.length,
          now: Date.now(),
        };
        // The panel renders the structure; the markdown rides along so the Copy
        // button can hand over something that pastes into a stand-up note.
        ReportPanel.show(buildActivityReport(input), renderActivityReport(input));
      },
    );
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

  private publishActivity(busy: boolean): void {
    const filtered = filterActivity(this.activityEntries, {
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { author: this.activityAuthor }),
    });
    const summary = summarise(filtered, this.activityPeriod);

    const activity: ActivityView = {
      period: this.activityPeriod,
      summary: summary.sentence,
      ...(this.activityFailures.length > 0 ? { unreadable: this.activityFailures } : {}),
      days: groupByDay(filtered, Date.now()).map((day) => ({
        heading: day.heading,
        entries: day.entries.map((entry) => ({
          repositoryPath: entry.repositoryPath,
          label: entry.label,
          sha: entry.commit.sha,
          shortSha: entry.commit.shortSha,
          time: timeOf(entry.commit.committedAt),
          author: entry.commit.author,
          subject: entry.commit.subject,
          merge: entry.commit.parents.length > 1,
        })),
      })),
      // Offered from the unfiltered set, so choosing an author does not remove
      // every other name from the control that chose them.
      authors: authorsOf(this.activityEntries),
      mergesOnly: this.activityMergesOnly,
      ...(this.activityAuthor === undefined ? {} : { author: this.activityAuthor }),
    };

    // The board's author list comes from the same read, so the digest is built
    // even while the pane is showing one repository - it simply is not published
    // over it.
    this.publish(this.passRunning);
    if (this.paneMode !== 'all') {
      return;
    }
    this.history.setModel({ mode: 'all', activity, status: { kind: 'ready' }, busy });
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
        `Repo Ledger could not read ${sha.slice(0, 7)} in ${repositoryPath}.`,
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
    return vscode.workspace.getConfiguration('repoLedger');
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
   * `HEAD`, `FETCH_HEAD` and everything under `refs/` cover a commit, a
   * checkout, a fetch and a branch change - every event that alters what a row
   * says. Working-tree files are deliberately not watched: they change on every
   * keystroke in every editor across every repository on the board, and the
   * dirty column is a second-tier read that a Refresh already covers.
   */
  private installWatchers(repositories: readonly DiscoveredRepository[]): void {
    this.disposeWatchers();
    for (const repository of repositories) {
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(repository.gitDir),
        '{HEAD,FETCH_HEAD,refs/**}',
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
      vscode.commands.registerCommand('repoLedger.refresh', () => {
        // Signing in to `gh` while the window is open should take effect on the
        // next Refresh rather than on the next reload, and whether a tool is
        // signed in is remembered for the session.
        resetCliCache();
        return this.refresh({ rediscover: true });
      }),
      vscode.commands.registerCommand('repoLedger.activityReport', () =>
        this.openActivityReport(),
      ),
      vscode.commands.registerCommand('repoLedger.openAdditionalRootsSetting', () =>
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'repoLedger.additionalRoots',
        ),
      ),
    );
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedulePass(true)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // Only the settings that change what is discovered force a new walk;
        // the rest are picked up by the next publish.
        if (
          event.affectsConfiguration('repoLedger.additionalRoots') ||
          event.affectsConfiguration('repoLedger.exclude') ||
          event.affectsConfiguration('repoLedger.maxDepth')
        ) {
          this.schedulePass(true);
        } else if (
          event.affectsConfiguration('repoLedger.dirty.enabled') ||
          event.affectsConfiguration('repoLedger.concurrency') ||
          event.affectsConfiguration('repoLedger.forge.enabled')
        ) {
          this.schedulePass();
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
