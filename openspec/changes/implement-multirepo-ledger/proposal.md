## Why

Multirepo Ledger puts **the last commit's subject and date on every repository row, and sorts the list
by it**. That combination exists nowhere else: it is absent from VS Code's Source Control row, from
its tooltip and from its children, and from GitLens's repository node — all three carry the branch
and the upstream ahead/behind, none carries what landed last or when. Nor does anything sort by it:
core offers discovery time, name or path; GitLens offers discovered, last-fetched or name. Alongside
that, Multirepo Ledger reads repositories **nested deeper than one level below an open folder, or in
directories the editor has never opened at all** — the two cases core's `git.repositoryScanMaxDepth`
default of `1` leaves out, and for which `git.scanRepositories` explicitly refuses an absolute path.
Everything else on the row supports those two things.

Be exact about what is *not* claimed, because a reviewer can check all of it in ten minutes.
`scm.providerCountBadge` defaults to `'hidden'`, so the **dirty count** is hidden out of the box —
but the branch name with its `*`, `+` and `!` markers and the `{behind}↓ {ahead}↑` figure are
visible text in core today. "Source Control answers only which files are dirty" is false.
`git.autoRepositoryDetection` defaults to `true`, so a directory of repositories opened as the
workspace folder already has every immediate child in the Source Control view: **the flat case is
not a gap.** GitLens subscribes to the git extension's SCM open and close events with no folder
filter, so it *can* show repositories outside the workspace; its own source says so. And the
directory-walking discovery model is occupied — `alefragnani.project-manager` (7,522,313 installs)
and `felipecaputo.git-project-manager` (1,504,828) both recursively scan configured absolute base
folders for `.git`. They show no git state. The only true form of the claim is: *nothing takes the
directory as the unit and shows state.*

**And the honest half, which belongs here rather than in a footnote.** Twenty-seven Marketplace
extensions claim multi-repository scope, fourteen updated in the last three months, and **none is
above roughly 760 installs**; the closest direct competitor, `Chuck-Studio.multi-repo-manager`, has
81. The two seven-figure neighbours succeed as *pure navigation with no state layer*, which is the
most parsimonious evidence that people want "open the right repository fast" rather than "watch all
my repositories". No feature request for this shape was found in `microsoft/vscode`; the two nearest
open issues — #312377 "Show only changed/dirty Git repositories" (27 reactions) and #168820 "Sort
Source control repositories by number of changes" (25 reactions, open since 2022) — both ask for
filtering and sorting *inside* the existing Source Control view. And the real competitor is not a
Marketplace extension at all: it is the built-in Source Control view plus the **Source Control Graph
pane**, which ships on by default and already does commit → changed files → native diff with a
repository picker.

**The gap is real and the demand is unproven. The reason to build this is that its author wants
it.** Nothing below leans on a demand argument, because there is not one to lean on.

## What Changes

- **Discover repositories by walking for `.git`** beneath every open workspace folder and every
  absolute path in `multirepoLedger.additionalRoots`, with the editor's own file index as an accelerator
  and the walk as the authority. Finding a `.git` ends the walk of that subtree, so the cost is a
  function of the directories above the repositories rather than of what is inside them.
- **Classify what kind of repository each one is from the filesystem**, before spawning anything:
  ordinary, linked worktree, submodule, separate git directory, bare, shallow. A linked worktree gets
  its own row; a submodule gets its own row behind a setting that ships off.
- **Read a row in one git process** — a scoped `for-each-ref` that yields HEAD state, the short
  object id, the upstream, the divergence, the committer date and the commit subject together, with
  mid-operation state, shallowness and fetch age taken from the filesystem at zero process cost.
  Uncommitted changes are an **opt-in second-tier read**, for visible rows only.
- **Render the list as a webview**: three lines per repository — name, divergence, dirty glyphs and a
  dimmed evidence-age caption; the last commit's relative date and subject; HEAD state, the
  repository-kind marker and the review count. A `TreeItem` has two text slots and this row has
  seven fields.
- **Head the list with clickable state tallies.** "3 repositories have commits that exist only on
  this machine" is a chip, and clicking it filters the list to those three. A count that cannot be
  clicked is decoration.
- **Sort by most recently committed, by default**, with name, divergence and dirtiness as the other
  modes, and repositories that have no key for the current mode grouped rather than sorted as zero.
- **Show the history of the selected repository** in a second webview below the list: a dated list of
  commits with ref chips, one `git log` per page. Selecting a commit expands the **list of files it
  changed**, read with one `diff-tree`, with renames as one row, binaries named as binary and
  mode-only changes stated rather than rendered as no change.
- **Lead somewhere from every row**: open the folder in a new window, show or reveal it in Source
  Control, open a terminal there, copy the path, open the remote in a browser through a four-shape
  allowlist.
- **Show open PR and MR counts** from `gh` and `glab`, **batched by owner** rather than fetched per
  repository, keyed by `(host, owner)` so an answer from one host can never populate a row on
  another. **Off by default**, because it touches the network.
- **State every failure as a sentence.** No commits, detached HEAD, mid-rebase, no upstream, upstream
  gone, bare, shallow, git refusing the directory for dubious ownership, a repository that never
  answers, no `git` on `PATH` — each is a row carrying its reason. No row is blank, and no count the
  extension has not established renders as zero.
- **Correct `openspec/project.md` and `openspec/config.yaml`**, whose competitive premise was checked
  against primary sources and refuted in four places. Both carry it: `project.md` in the paragraph
  under "The problem", three lines above the table that already disproves it, and `config.yaml` in
  its `context:` block — which is the text injected into every future OpenSpec session in this
  project, so leaving it there is how a refuted premise gets read back as authority by the next
  session, which is the mechanism that produced it the first time. The corrected text is the Context
  section of `design.md`.

## Capabilities

### New Capabilities

- `repository-discovery`: Walking for `.git` beneath workspace folders and additional roots, the
  editor-index passes and why their exclude argument must be `null`, repository-kind classification
  from the filesystem, the depth, link and directory-budget guards, exclusions, caching,
  cancellation, and which repositories get a row — including the rule that drops a candidate lying
  inside a known working tree whichever source found it, without which an index query carrying no
  excludes hands the board the submodules and vendored clones the walk deliberately pruned.
- `repository-read`: The one-process row read, its three command shapes and how `HEAD` chooses
  between them, the capability fallback for an older git, the pinned child environment, the opt-in
  second-tier dirty read and where its flag must go, the facts taken from the filesystem instead of
  from a process, and every degenerate repository as a stated row.
- `repository-list`: The webview list — the three-line row field by field, which field yields at
  narrow widths and why, the compact density, the closed state set, the clickable tally header, the
  four sort modes and their three ranks, the two composing filters, selection, and the loading,
  between-generations, empty and failed states.
- `commit-history`: The history pane — the paged `git log`, its record framing, the rev set and its
  ordering guarantee, unpushed marking at no extra cost, ref chips classified by full ref name, the
  changed-file list on expansion, paging and its `--skip` hazard, and what happens to an in-flight
  read when the user selects another repository.
- `repository-actions`: The five hand-offs from a row — open the folder in a new window, show or
  reveal in Source Control, open in a terminal, copy the path, open the remote in a browser — plus
  the two failure-state actions, which actions are deliberately absent, and the remote-URL allowlist
  that makes the last one safe.
- `forge-review-state`: The `gh` and `glab` layer — off by default, batched by owner, serialised,
  keyed by `(host, owner)`, with the forge asymmetry stated rather than hidden, a result type in
  which an unestablished zero cannot be represented, and the local-only fallback when no forge can be
  named.

### Modified Capabilities

_(None — this is the first change in a new project.)_

## Impact

- **New repository.** No existing code is modified. The extension depends on no other extension being
  installed; the built-in git extension is used for one optional hand-off and its absence removes
  that one action.
- **Spawn count.** One git process per repository per refresh for the row read, and **one** on every
  path except a repository whose `HEAD` could not be read on a git too old for
  `--include-root-refs`, which costs two, once. Repository kind, mid-operation state, shallowness,
  fetch age and the unborn-versus-detached distinction cost **zero** processes: they are read from
  the filesystem. Uncommitted changes cost one more per *visible* row and ship off. The history pane
  costs one process per page and one per commit expansion, in a single slot outside the row-read
  pool. `git --version` is one process per session. `design.md` carries the whole table, and every
  concurrency figure is derived from `os.availableParallelism()` between a named floor and ceiling or
  is the `multirepoLedger.concurrency` setting — no number measured on a development machine appears as a
  constant, a threshold or an argument anywhere in this change.
- **Cancellation.** Every discovery-and-read pass carries a generation and an `AbortSignal`; a
  refresh, a workspace-folder change, a relevant settings change or disposal aborts it, kills the
  children and **drops** any answer that arrives carrying a stale generation rather than merging it.
  Selecting a different repository does **not** cancel the board — the user did not stop asking that
  question — but it does cancel the history read, and the pane clears to name the newly selected
  repository *before* any process starts, so one repository's commits can never appear under
  another's name.
- **Nothing on the activation path.** `activate` registers and returns, with a budget stated as a
  count rather than a duration: zero awaited operations, zero spawned processes, zero files read
  while VS Code holds the activation path open. Rows appear from discovery, before any git process
  has answered.
- **What touches the network.** Exactly three paths, two of them behind a setting that ships off:
  `gh search prs`, `glab mr list`, and `env.openExternal` on a remote URL, which is a user gesture
  where the request is made by the browser. No telemetry, no update check, no analytics, no
  extension-owned HTTP client; the bundle has no runtime dependencies and the source contains no
  `fetch`, no `https` import and no socket. `git fetch --dry-run` is never used — it downloads the
  full payload despite its name — and neither is `git ls-remote`.
- **No credentials.** The extension offers no token setting, reads no `GH_TOKEN` or `GITLAB_TOKEN`,
  writes nothing to `SecretStorage`, and never logs a token. Whatever authentication exists is what
  the user established with `gh` or `glab` in their own shell. `GIT_TERMINAL_PROMPT=0` and piped
  stdio make it impossible for a child to block on a credential prompt.
- **Writes.** None. The extension never stages, commits, pushes, fetches, prunes or rewrites
  anything, and there is no batch operation across repositories. It never runs
  `git config --add safe.directory` and never passes `-c safe.directory` in its own invocations: a
  repository git refuses is a row that states the refusal and offers to copy the command, so the
  decision stays with the person who can check the path.
- **Workspace trust.** `untrustedWorkspaces.supported: false`, already in the manifest. Running git
  inside a discovered directory is arbitrary code execution, because a repository's own `.git/config`
  can set `core.pager`, `core.fsmonitor`, `core.hooksPath` and aliases. In an untrusted workspace the
  extension does not activate and the editor's own banner explains why. There is deliberately no
  setting naming the `git`, `gh` or `glab` binary, so a workspace-scoped `settings.json` cannot point
  the extension at an executable.
- **Virtual workspaces.** `virtualWorkspaces.supported: false`, already in the manifest. There is no
  local path to spawn a process in, no `.git` to stat and no `.git/config` to parse.
- **Manifest changes required by this design.** Two kinds, and the second is longer than it looks.
  **The view type:** `multirepoLedger.history` is currently declared without a `type`, which makes it a
  tree. It becomes `"type": "webview"`, because the pane must render caveats above a *non-empty*
  list — a mid-rebase banner, a truncated page, a paging cap — and `viewsWelcome` renders only when a
  tree is empty. The two existing `viewsWelcome` blocks describe states of the list rather than of
  the history and move into the list's own empty states. **The settings:** `package.json` declares
  four (`additionalRoots`, `exclude`, `maxDepth`, `forge.enabled`) and this design introduces six
  more — `multirepoLedger.includeSubmodules` (D9), `multirepoLedger.dirtyState.enabled` (D14),
  `multirepoLedger.concurrency` (D15), `multirepoLedger.rowDensity` (D28), `multirepoLedger.history.pageSize` (D48)
  and `multirepoLedger.history.maxRetainedCommits` (D48). Each is declared where the phase that needs it
  lands, and each description says what the setting costs, or which failure it guards against, rather
  than what it tunes.
- **File watching.** Two non-recursive watchers per repository, on the git directory and on its
  reflog, never on the working tree. Recursive patterns are silently subject to
  `files.watcherExclude`, which many users set to `**/.git/**`, and a watcher an unrelated setting
  disables is worse than no watcher. The cost is two OS handles per repository, and window focus and
  manual Refresh are independent paths to a fresh board.
- **External tools.** `git` must be on `PATH`; its absence is one explained state for the whole board
  rather than a hundred failed rows. `gh` and `glab` are optional and their absence is a dimmed
  reason on the row, never a zero.

## Out of scope for this change

- **Graph lanes.** No merge lanes, no tracks, no ASCII graph. Deferred deliberately, not overlooked:
  VS Code's Source Control Graph pane ships on by default, so lanes are the least
  differentiated work available and are a week on their own, most of it correctness edge cases. The
  parent list (`%P`) is read into the model from day one, so the later change adds a lane column and a
  pure layout module without touching the read, the parse or the paging.
- **The native per-file diff, and the `FileSystemProvider` it requires.** The `git:` URI scheme
  resolves only for repositories the built-in git extension has opened, which is exactly the set this
  extension exists to look outside of, so a real diff needs this extension to own a read-only provider
  over `git cat-file` — and with it answers for missing blobs after `gc`, submodule paths whose blob
  is a commit id in another repository, mode-only changes that would render as no change, and LFS
  pointers that diff as pointer text, silently and plausibly. In v1 a changed file opens its current
  working-tree copy, and the pane says that is what it is doing.
- **Per-file history.** `git log --follow -- <path>` from a changed file needs its own rev set, its
  own paging and its own way back. A later change.
- **Any write to a repository.** No staging, committing, pushing, pulling, fetching, merging,
  rebasing, branch creation, stash management or conflict resolution.
- **Any batch operation across repositories.** No Fetch All, no Pull All, no Prune All.
- **A composite health score, percentage or traffic light.** Two unpushed commits and a dirty
  lockfile do not add up to anything.
- **An API token, and any credential storage.**
- **A `safe.directory` trust button, and any "trust all" toggle.**
- **Blame, file annotations, and anything that reads inside a file.**
