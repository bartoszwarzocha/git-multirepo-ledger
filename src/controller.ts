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
  Commit,
  CommitFile,
  DiscoveredRepository,
  FilterMode,
  HistoryModel,
  HistoryStatus,
  ListModel,
  ListStatus,
  RepositoryRow,
  RowAction,
  SortMode,
} from './model/types.ts';
import { readDirtyState, readRows } from './read/reader.ts';
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
  }

  dispose(): void {
    this.disposed = true;
    this.passAbort?.abort();
    this.historyAbort?.abort();
    if (this.passTimer) {
      clearTimeout(this.passTimer);
    }
    this.cache.cancel();
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
        return;
      case 'sort':
        await this.context.workspaceState.update(SORT_KEY, request.sort);
        this.publish(this.passRunning);
        return;
      case 'filter':
        await this.context.workspaceState.update(FILTER_KEY, request.filter);
        this.publish(this.passRunning);
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
    const row = this.historySelection;
    const model: HistoryModel = {
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

  private forgeEnabled(): boolean {
    return this.config.get<boolean>('forge.enabled', false);
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
