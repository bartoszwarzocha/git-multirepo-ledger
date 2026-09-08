# Design — implement-multirepo-ledger

## Context

Multirepo Ledger reads a directory full of git repositories and shows the state of every one of them
at a glance, without opening any of them. Two views in one Activity Bar container: a list on top,
three lines per repository; a history pane below it, driven by the selected row. Everything the
extension runs is a read.

`openspec/project.md` states the premise as *"VS Code's Source Control view knows only the
repositories inside the open folders, and it answers one question about them: which files are
dirty."* A 46-agent research sweep on 2026-09-07 checked that against VS Code's own source,
GitLens's source, both settings schemas and the Marketplace query API, and **refuted it**. The
corrected premise is below, and correcting `project.md` is part of this change. A premise a
reviewer can disprove in ten seconds is worse than no premise.

**What core already shows.** The built-in git extension scans **workspace folders only**;
`git.autoRepositoryDetection` defaults to `true` and `git.repositoryScanMaxDepth` defaults to `1`,
so a folder of repositories opened as the workspace folder already has every one of its immediate
children in the Source Control view. `git.scanRepositories` **explicitly rejects absolute paths**
— `Absolute paths not supported in "git.scanRepositories" setting.` — which is a deliberate
refusal by the VS Code team, not an oversight. Core also ships a hidden-by-default **Repositories**
view whose rows render the git extension's `statusBarCommands`: the branch name with `*`, `+` and
`!` markers, and a `{behind}↓ {ahead}↑` sync figure, both as visible text. What core hides by
default is the *dirty count*: `scm.providerCountBadge` defaults to `'hidden'`. And the
**Source Control Graph** pane ships **on by default**, with a repository picker, doing
commit → changed files → native diff. (No version is named for that, deliberately: the research
established that it ships on by default and did not establish when it started to, and the argument
needs only the former.)

**What GitLens already shows.** `discoverRepositories(folders: readonly WorkspaceFolder[])`, with
`gitlens.advanced.repositorySearchDepth` defaulting to `git.repositoryScanMaxDepth`, i.e. `1` — but
GitLens also subscribes to `vscode.git`'s SCM open and close events **with no folder filter**, and
its own source comments say so: unrelated repositories, siblings, and repositories outside any
folder are surfaced by that path. **"GitLens only sees repositories in the workspace" is false and
must not be asserted.** Its collapsed `RepositoryNode` already carries branch, upstream
ahead/behind and a last-fetched age. Its Repositories view is off by default and renders each
repository `Expanded` into roughly eight children — a wall to collapse, not a list to expand.

**What the directory-as-the-unit walk already is.** Occupied. `alefragnani.project-manager`
(7,522,313 installs) and `felipecaputo.git-project-manager` (1,504,828 installs) both recursively
scan configured absolute base folders for `.git`. They show **no git state**. The only true form of
the claim is: *nothing takes the directory as the unit and shows state.*

**What is left, stated exactly.** Four things, and nothing else:

1. **The last commit's subject and date on a per-repository row.** Verified absent from core's
   row, its tooltip and its children, and from GitLens's repository node. Among the dedicated
   multi-repository status tools outside the editor it appears in `gita` alone.
2. **Sorting a repository list by last commit.** Core offers discovery time, name or path;
   GitLens offers discovered, last-fetched or name. **Nobody sorts by last commit.**
3. **Repositories nested deeper than one level below an open folder, or in directories not open
   at all.** The flat case is not a gap — core and GitLens both find it. This is the whole of the
   discovery advantage and the documents claim no more.
4. **Open PR/MR counts per repository without a paid plan.** GitLens's Launchpad is Pro-gated.

Items 1 and 2 are one idea: the last-commit line is what makes the sort legible, and the sort is
what turns a list into a board. Both fields fall out of the `for-each-ref` the row read already
runs, so together they cost nothing.

**And the honest half.** Twenty-seven Marketplace extensions claim multi-repository scope,
fourteen updated in the last three months, **none above roughly 760 installs**; the closest direct
competitor, `Chuck-Studio.multi-repo-manager`, has 81. The two seven-figure neighbours succeed as
pure navigation with no state layer. No feature request for this shape was found in
`microsoft/vscode`; the two nearest open issues — #312377 "Show only changed/dirty Git
repositories" (27 reactions) and #168820 "Sort Source control repositories by number of changes"
(25 reactions, open since 2022) — both ask for filtering and sorting *inside* the existing Source
Control view. **The gap is real and the demand is unproven.** Nothing in this design leans on a
demand argument, because there is not one to lean on.

The extension is therefore structured as a discovery layer and a one-process row read feeding two
webview surfaces, with a review-state overlay that ships disabled and can be deleted without the
rest noticing.

## Goals

- **Put the last commit on the row and order the list by it.** Date and subject, on every row,
  with no expansion; most recently committed first by default. This is the difference; everything
  else supports it.
- **Find every repository under a root**, at any depth, in directories the editor has never
  opened, and classify what kind of repository each one is before spawning anything.
- **Read a row in one git process**, with dirty state as an opt-in second tier, so the cost of the
  board is a function of the repository count and not of the size of any repository.
- **Say how old the answer is.** A divergence figure is measured against a remote-tracking ref that
  is only as fresh as the last fetch, so the row says when that was, and says nothing rather than
  "up to date" when it cannot say.
- **Make the click do something real.** Selecting a row fills a history pane with a dated commit
  list and ref chips; selecting a commit expands the list of files it changed.
- **Lead somewhere from every row.** Open the folder in a new window, show it in Source Control,
  open a terminal there, copy the path, open the remote in a browser.
- **Show review state beside local state**, batched by owner, off by default, and silent rather
  than wrong when it cannot be established.
- **Degrade into sentences.** No commits, detached HEAD, mid-rebase, no remote, bare, shallow, git
  refusing the directory, a repository that never answers, no git on `PATH` — each is a stated row
  carrying its reason. No row is blank, and no count the extension has not established renders as
  zero.
- **Never block.** Nothing on the activation path, rows render as each repository resolves, every
  read is cancellable, and a superseded answer is dropped rather than merged.

## Non-Goals

- **Graph lanes are deferred to a later change.** No merge lanes, no tracks, no ASCII graph in v1.
  This was asked for and then withdrawn on the evidence: VS Code ships a Source Control Graph
  pane on by default, so lanes are the least differentiated work available and are a week on their
  own, most of it edge cases (lane assignment and reuse, octopus merges, a frontier carried across
  a page boundary, a parent outside the rev set). In a narrow sidebar the lane column also takes
  its width from the commit subject, which is the field the project exists to show. D38 is the
  decision; D44 is the commitment that makes the later change additive rather than a migration.
- **The native per-file diff, and the `FileSystemProvider` it requires, are deferred.** Not an
  omission: the `git:` URI scheme resolves only for repositories the built-in git extension has
  opened, which is exactly the set this extension exists to look outside of, so a real diff needs
  this extension to own a read-only provider over `git cat-file` — and that drags in missing blobs
  after `gc`, submodule paths whose "blob" is a commit id in another repository, mode-only changes
  that render as no change, and LFS pointers that diff as pointer text, silently and plausibly.
  D39 is the decision and names what must be true for it to come back.
- **Not a git client.** No staging, committing, pushing, pulling, merging, rebasing, conflict
  resolution, branch creation or blame. The extension hands off to the tools already installed.
- **No batch operation across repositories.** No Fetch All, no Pull All, no Prune All. Every
  neighbouring tool has them and that is how the read-only boundary erodes, one button at a time
  (D54).
- **No credential of any kind.** No token setting, no `SecretStorage`, no reading `GH_TOKEN`.
  Whatever authentication exists is authentication the user established with `gh` or `glab` in
  their own shell (D61).
- **No `safe.directory` trust button, and no "trust all" toggle.** Ever (D19).
- **No composite health score, percentage or traffic light.** Two unpushed commits and a dirty
  lockfile do not add up to anything (D29).
- **No telemetry, no update check, no analytics, no extension-owned HTTP client** (D65).
- **No virtual workspaces and no untrusted workspaces** (D66).
- **Not a search surface, and not per-file history.** `git log --follow -- <path>` from a changed
  file is a good feature and a different one; it needs its own rev set, its own paging and its own
  way back (D47).

## Decisions

### D1. Module boundaries, and the direction every import runs in

```
  src/
    discovery/
      search.ts        the filesystem walk for `.git`, adapted from the sibling
      vscodeSearch.ts  the editor's own index, adapted from the sibling
      kind.ts          plain / worktree / submodule / bare / shallow, decided from files
      roots.ts         workspace folders + `multirepoLedger.additionalRoots`, deduplicated
      cache.ts         what the last walk found, keyed by stamp
    model/
      types.ts         Repository, RepoState, ForgeCount, SortMode, FilterMode
      keys.ts          `pathKey`, `normalizePath`, `isPathInside` — copied from the sibling
      state.ts         `statesOf(read)`: the closed state set, computed once for every consumer
      row.ts           every field of the three lines as text, and which field yields when narrow
      relative.ts      unix seconds -> "3d ago", in English, and when that wording next changes
      order.ts         `sortRepositories`: the four modes, the three ranks, the path tie-break
      filter.ts        `filterRepositories`, the filter labels, the sentences an empty result prints
      tally.ts         the header chips, their counts and their sentences
      board.ts         `buildBoard(model, options)`: rows in final order plus header, in one object
      actions.ts       `actionsFor(row)`, including which actions are absent
      remoteUrl.ts     a remote URL -> host, owner, project, and the browser URL
    read/
      refs.ts          the one-process row read and its parser
      status.ts        the opt-in dirty read
      gitdir.ts        HEAD state, operation markers, shallowness, FETCH_HEAD age
      capability.ts    the `--include-root-refs` result, remembered for the session
      schedule.ts      concurrency, generations, cancellation
    history/
      log.ts           one `git log` per page
      parse.ts         the record parser and its resynchronisation rule
      rawdiff.ts       the combined `--raw --numstat -z` parser
      chips.ts         `%D` -> ref chips, classified by full ref name
    forge/
      plan.ts          repositories -> the set of batched queries, keyed by (host, owner)
      github.ts        `gh` invocation and result mapping
      gitlab.ts        `glab` invocation and result mapping
      overlay.ts       the cache, the four states, and the rule against inventing a count
    view/
      listView.ts      the `WebviewViewProvider` for `multirepoLedger.repositories`
      listHtml.ts      the page, the patch protocol, the content security policy
      historyView.ts   the `WebviewViewProvider` for `multirepoLedger.history`
      historyHtml.ts   the same, for the history pane
      handoffs.ts      the five row commands, each a VS Code call `actionsFor` already decided
    util/
      git.ts fsx.ts log.ts    copied from the sibling
    controller.ts      wiring, watchers, settings, the passes
    extension.ts       activation and nothing else
```

The direction is one-way and short enough to state in full. `util` depends on nothing in the
project. `model` depends only on `util`, and on nothing that spawns a process or opens a file.
`discovery`, `read`, `history` and `forge` depend on `model` and `util` and never on each other.
`view` depends on `model` alone: it renders text it is handed and decides nothing. `controller.ts`
depends on all of them, and nothing depends on `controller.ts`. `extension.ts` depends on
`controller.ts` and on nothing else in the project.

Three of those edges are absences rather than conveniences. **`forge` may not depend on `read`**
and `read` may not depend on `forge`: the review count is an overlay keyed by repository path,
joined in the controller, so a forge failure has no route by which to change a local fact and the
entire `forge/` directory can be deleted with the extension still compiling, discovering, reading
and rendering. **`view` may not depend on `read`, `history` or `forge`**, because the moment a
renderer can start a read it becomes the place where "what to fetch next" is decided, and that
decision then has no test. And **every judgement lives in `model/`** — which field yields when the
sidebar is dragged narrow, what an unreadable repository is called, how the four sort orders break
ties, what the header counts, which actions a row does *not* offer.

Rejected: putting the label logic next to the code that produces the data, so `read/refs.ts`
returns rendered strings. That reads well for about a week, and then the row's narrow-width
behaviour is decided in a file that imports `node:child_process` and can only be tested by spawning
git, so it stops being tested.

Rejected, and this is where two drafts of this document disagreed: putting the pure view logic
under `view/` — `view/row.ts`, `view/order.ts`, `view/board.ts` — with only `view/listView.ts`
importing `vscode`. It is a defensible layout and it makes D2 unenforceable, because the lint rule
that keeps `vscode` out of the pure modules can then no longer be a directory rule. The judgements
live in `model/` and `view/` holds only renderers.

The test that keeps this honest is the sibling's: `buildBoard` is called with a hand-built model
and its output asserted field by field. If a label, an order or a filter can only be checked by
launching an extension host, it is in the wrong file.

**Spawn count: 0.** Choosing a module layout costs no process.

### D2. Exactly four places may import `vscode`, and lint enforces it

`vscode` may be imported by `extension.ts`, `controller.ts`, anything under `view/`, and
`discovery/vscodeSearch.ts` — which exists as a separate file from `discovery/search.ts` precisely
so the walk stays importable without an extension host. Nowhere else.

The rule is written as an eslint `no-restricted-imports` override scoped to `src/**` with those
four paths excepted, so `npm run lint` checks it on every commit and in CI.

Rejected: holding the line by convention, on the grounds that everyone here already agrees with it.
What goes wrong is specific and has a delay fuse. Tests are `node --test "src/**/*.test.ts"` with
no extension host, so a test file can only load a module whose entire import graph is free of
`vscode`. The first time a pure module reaches for `vscode.workspace.getConfiguration` to read a
setting it could have been passed, every test that transitively imports it stops loading — and the
failure surfaces as an import error in a test nobody touched, days later, in a file unrelated to
the change that broke it. A lint rule fails in the file that broke it, in the same commit, with the
rule's name attached.

**Spawn count: 0.**

### D3. Three files are copied from the sibling verbatim and two are adapted, and the adaptation changes more than a string

**Copied close to verbatim** from `E:\AI\openspec-ledger\src\`:

| File | What changes |
|---|---|
| `src/util/git.ts` | The comment block, rewritten to argue this project's case. Nothing else. |
| `src/util/fsx.ts` | Nothing. |
| `src/util/log.ts` | The channel name. |
| `src/model/keys.ts` | Nothing. `pathKey`, `normalizePath`, `isPathInside` and `pathsEqual` are the same helpers. |

Rejected: sharing these four files through a package both extensions depend on, which is the answer
every instinct gives and which `CLAUDE.md` already records as rejected with the user. What goes
wrong is a publishing coupling: a fix to `git.ts` that one extension needs becomes a version bump,
a release and a dependency update in the other, and the other's next release then carries a change
nobody there asked for. Two Marketplace extensions maintained by one person do not need a third
artefact with its own version history between them. Copied, they drift — and when they drift they
drift visibly, in a diff, which is the failure mode that can be seen.

Rejected: a git submodule or a subtree holding the shared files, as the cheap middle. It is the
same coupling with worse ergonomics: a contributor cloning either repository gets an incomplete
checkout unless they know to ask for it, and the extension's whole premise is that a submodule is
a thing people forget to initialise.

That copy brings three guards, and they are guards rather than tuning constants — each names a
failure it prevents rather than a speed it achieves: a **10 s per-process timeout** so a repository
on an unreachable mount cannot hang the extension host, a **32 MiB output cap** with a `truncated`
flag so a pathological repository cannot buffer without bound, and a `GitMissingError` thrown only
when `git` is absent from `PATH`, because that is a different kind of fact and it disables the
whole extension rather than one row.

**Adapted:** `src/discovery/search.ts` and `src/discovery/vscodeSearch.ts`. Four changes, and only
the first is the string:

1. The needle changes from a directory named `openspec` to an entry named `.git` — and `.git` is a
   member of the sibling's `DEFAULT_EXCLUDED_DIRS`. It has to come out of that list. Left in, the
   walk descends past every repository in the directory and finds none of them, and the extension
   ships empty with no error anywhere.
2. `.git` may be a **file** rather than a directory: a linked worktree, a submodule working
   directory and a `--separate-git-dir` repository all have `.git` as a file holding a `gitdir:`
   line. The sibling's `isDirectory` test alone misses three of the five repository kinds, so the
   walk tests for either and resolves the pointer (D8).
3. Finding a `.git` means **not descending into it and not descending into its working tree either**
   (D7). The sibling stops at a hit for a different reason and the reasoning does not transfer;
   D7 argues this one on its own terms.
4. `vscodeSearch.ts` changes its glob and, more importantly, its second argument (D5).

Rejected, for the adaptation: writing both walkers from scratch against this project's needs rather
than adapting the sibling's, on the grounds that four changes to a copied file is most of a rewrite
anyway. What goes wrong is invisible and slow. The sibling's walk carries a depth stop that logs
its numbers, a directory bound that is a file-handle guard, a dirent-based refusal to follow links
and a `listDirectories` that swallows an unreadable directory rather than aborting — four behaviours
that were paid for once and would each have to be rediscovered here, most likely after a bug report
rather than before one. Adapting keeps them, and keeps the two files close enough that a fix found
in either can be read across.

**Spawn count: 0.**

### D4. Discovery runs the editor's index and a filesystem walk, and the walk is the authority

Two sources, because they cover different halves of the problem. `vscode.workspace.findFiles` runs
against the editor's own file index, outside the extension host, is cancellable, and — in its own
words — "will return no results if no workspace folders are opened". It can therefore only ever
answer for the open folders. `multirepoLedger.additionalRoots` points, by definition, outside them; it is
the setting this extension exists for, since the point is to answer across repositories the user is
*not* currently working in. A walk is not optional.

The index answers first and the list paints from it. The walk runs over every root — the open
folders as well as the additional ones — and its results are merged in by resolved path. The index
is an accelerator and the walk is the authority: when `findFiles` is fast the board appears sooner,
and when it is slow, disabled, or structurally blind to a repository (D6), nothing is lost but the
first paint.

"The walk is the authority" is a statement about *coverage* — the walk finds what the index cannot.
It is not a licence for the index to add what the walk deliberately refuses: the index runs with no
excludes at all (D5) and therefore reaches inside working trees, which D7 prunes on purpose. **D67
is the rule that reconciles the two**, and it applies to the merged set rather than to either
source, so a candidate is judged the same way whichever found it.

Rejected: the index alone. It cannot see `additionalRoots`, it cannot see a bare repository, and it
returns nothing in a window with no folder open — which for this extension is a normal window, not
an edge case.

Rejected: the walk alone. The sibling rejected that for the workspace half and the reasons still
hold: the index is already warm, it honours cancellation natively, and it does its work in another
process.

Be precise about what discovery buys, because a reader can check it. A directory opened as a
workspace folder is already scanned by the built-in git extension, and GitLens discovers the same
set through SCM events. Discovery here buys exactly two things: repositories nested **deeper than
one level** below an open folder, and repositories in directories **not open at all**. Nothing
else.

**Spawn count: 0.** Discovery is filesystem and index work; not one git process is spawned to find
a repository.

### D5. The index search passes `null` for the exclude argument, because the editor's own default excludes hide `.git`

`findFiles(include, exclude, maxResults, token)` documents its exclude parameter as: "When
`undefined`, default file-excludes (e.g. the `files.exclude`-setting but not `search.exclude`) will
apply. When `null`, no excludes will apply." VS Code's default `files.exclude` contains
`"**/.git": true`. So the obvious call — omit the argument, or merge the user's exclude settings
into one glob as the sibling's `vscodeSearch.ts` carefully does — finds **nothing, always, and
silently**. `null` is the only value that works.

The cost is that the search traverses directories the user has hidden. That is compensated on the
results rather than in the query: the extension applies its own directory-name exclusion list (D10)
to every path that comes back, and `multirepoLedger.exclude` removes a named repository from the board
entirely.

Rejected: merging `files.exclude` and `search.exclude`, as the sibling does. It is the right thing
there — an `openspec` directory is never hidden by a default exclude — and it is structurally fatal
here.

Rejected: merging them but dropping the patterns that would exclude `.git`. Deciding whether an
arbitrary user-authored glob excludes a given path is not a one-line test, and getting it wrong
reintroduces exactly the silent-empty failure, which is the worst failure available: a board that is
confidently empty.

**Spawn count: 0.**

### D6. Two index passes, one for each shape a `.git` takes, and bare repositories belong to the walk

- **Pass A, `**/.git/HEAD`** — ordinary repositories. Verified: `findFiles` genuinely reaches inside
  `.git` when the glob names it explicitly. The glob does not match `.git/worktrees/<name>/HEAD` or
  `.git/modules/<name>/HEAD`, because the segment immediately before `HEAD` must be `.git`, so this
  pass returns one hit per ordinary repository and nothing else.
- **Pass B, `**/.git`** — `findFiles` returns files, never directories, so this pattern matches
  exactly the cases where `.git` is a file: a linked worktree, a submodule, and a repository created
  with `--separate-git-dir`. It can never return a `.git` directory, so the two passes do not
  overlap.

A bare repository has no `.git` at any path and is invisible to both. Rejected: a third pass on
`**/HEAD`. It matches every file named `HEAD` anywhere in the workspace, of which there are many, so
it would page in a large result set to learn a rare fact. Bare repositories are found by the walk,
which is running anyway, or by being named in `additionalRoots`.

Each pass is capped with `maxResults`. The cap is a guard against paging an unbounded path list into
the extension host, not a limit on how many repositories the board will show; reaching it is written
to the log with the count and stated on the list, because a board that silently stops at a cap is a
board that lies about being complete.

**Spawn count: 0.**

### D7. Finding a `.git` ends the walk of that subtree

The walk never descends into a `.git` directory, and it does not descend into the working tree of a
repository it has just found either. A repository is a leaf.

Pruning at the repository is what makes the walk's cost a function of **the number of directories
above the repositories** rather than of the size of the repositories themselves — and working trees
are precisely where `node_modules`, `target`, `.venv` and `dist` live. A directory of twenty clones
is walked to depth one and stops. It is also the honest reading of what a nested `.git` means: to
git, a directory inside a working tree that contains a `.git` is either a submodule — which the
superproject records in `.gitmodules`, readable at zero process cost (D9) — or untracked junk it has
been told to ignore. Neither case wants the walk to go looking.

Rejected: recording the hit, skipping the `.git` entry, and carrying on through that directory's
other children so that no nested repository is ever missed. This was the other draft of this
document and it is wrong for a bounded reason: it makes discovery's cost scale with the *contents*
of the repositories rather than with how many there are, which is backwards for a board whose unit
is the repository, and it is the failure that produces "hangs on startup" reviews. Microsoft ships
`git.repositoryScanIgnoredFolders` because they measured that walk and flinched; the cheaper answer
is not to enter the tree at all.

Rejected: descending only into directories that are `.gitignore`d, or only two levels, or only when
the working tree is small. Each is a threshold, each would have to come from somewhere, and a
repository the walk declines to enter is reachable in one line of settings by naming it in
`additionalRoots`.

**Spawn count: 0.**

### D8. Repository kind is decided from files, before any process is spawned

Every classification below is four file reads at most, and all of it happens before the row read
chooses its arguments (D11).

| What the walk or the index sees | Resolves to | Kind |
|---|---|---|
| `.git` is a directory | that directory | ordinary |
| `.git` is a file, and the directory it names contains `commondir` | the shared common directory | **linked worktree** |
| `.git` is a file, the directory it names is a complete repository (`HEAD`, `config`, `objects/`, `refs/`) with no `commondir`, and it sits under an ancestor repository's `.git/modules/` | that directory | **submodule** |
| the same, but not under a `.git/modules/` | that directory | ordinary, with a separate git directory |
| no `.git` at all, and the directory itself holds `HEAD`, `config`, `objects/` and `refs/` | itself | **bare** |

Verified on git 2.52.0.windows.1: a linked worktree's `.git` file read
`gitdir: <main>/.git/worktrees/wt-feature` — an **absolute** path — and that directory contained
`commondir`, `gitdir`, `HEAD` and `index`. A submodule's `.git` file read `gitdir: ../.git/modules/sub`
— a **relative** path — and that directory was a complete repository carrying `core.worktree` in its
config. Absolute versus relative is therefore *not* the discriminator; both forms occur and either
may appear in either role. The presence of `commondir` is the discriminator, because a linked
worktree is the only one of these that shares another repository's object store and ref namespace.

Shallowness is the fifth marker and is one more `stat`: `<gitdir>/shallow` exists.

Rejected: `git rev-parse --is-bare-repository --git-common-dir --show-superproject-working-tree`,
one process per candidate. It answers the same question and answers it correctly, at the price of
doubling the spawn count of the entire board to learn what four `stat` calls already know. Spawn
count is the budget; a fact available from the filesystem is never bought with a process.

Rejected: distinguishing a submodule from a separate-git-dir repository by the `core.worktree` entry
in its config. `submodule add` writes it today, but it is a config value a user may set for their own
reasons, and misclassifying an ordinary repository as a submodule hides it behind an opt-in (D9)
with nothing on screen to say so. The `<ancestor>/.git/modules/<...>` path shape is the layout git
itself creates, and it is checked against an ancestor already known to be a repository.

**Spawn count: 0.**

### D9. One row per working tree: a linked worktree is its own row, a submodule is its own row and is off by default

"Is a repository nested inside another one row or two" is settled by asking what a row is. A row is
a working tree with a HEAD of its own, so:

- **A linked worktree found under a scanned root gets its own row**, marked `worktree`. It has its
  own HEAD, its own working-tree state and its own divergence. Verified: `for-each-ref` run inside a
  linked worktree marks *that* worktree's branch with `*` and lists the main repository's branches
  unmarked, so the row is honest with no extra work. Folding it into the main repository's row would
  show one HEAD for two checkouts, which is the exact confusion worktrees exist to prevent.
- **A submodule gets its own row**, marked `submodule`, behind a new setting
  `multirepoLedger.includeSubmodules`, default `false`. Because D7 prunes, submodules are not found by
  *walking* — but they are emphatically found by the *index*, because pass B is `**/.git` with no
  excludes (D5, D6) and an initialised submodule's `.git` is precisely a file with that name. D67
  is what removes them again, and without it this setting's default would be a lie on every
  workspace holding an initialised submodule. They are read instead from the superproject's
  `.gitmodules`, one file, zero processes. Off by
  default for two reasons: a superproject with thirty submodules floods a board whose entire value is
  that it fits on one screen, and a submodule's HEAD is normally pinned by the superproject's commit,
  so its state is not independent news.
- **A submodule listed in `.gitmodules` whose directory holds no `.git` is not initialised**, and
  gets no row. There is nothing on the machine to read, and a placeholder row would spend the
  board's scarcest resource on a repository that is not there.
- **Two repositories nested by accident** — an unrelated clone inside a working tree — are two rows,
  but only when the inner one is reachable without descending into a working tree, which means the
  user named it or its parent in `additionalRoots`. The index would otherwise return it, for the
  same reason it returns submodules; D67 removes it, and the `additionalRoots` case is D67's one
  exception.

Rejected: one row per object store, folding worktrees into their main repository. Rejected: showing
submodules by default.

**Spawn count: 0.**

### D10. Three guards on the walk, and none of them is a performance setting

**1. Depth: `multirepoLedger.maxDepth`, default 32, minimum 1, with no value meaning "unlimited".** With
D7 pruning at every repository, depth is not what keeps the walk cheap, so it does not have to be
small to be useful. It is a stop against a symlink cycle the dirent check misses and against a root
that turns out to be a home directory. `mgitstatus`, whose entire job is scanning a directory of
repositories, defaults to depth 2, and `git.repositoryScanMaxDepth` defaults to 1. Both are
defensible where they are — a shell tool invoked on a path the user just typed, and a
per-workspace-folder scan the user did not ask for — and both are wrong for a board that claims to
show every repository under a root, because **a repository missing from the board produces no
evidence that it is missing.** A slow scan announces itself; an incomplete one does not. The
manifest's description of the setting already says exactly this, and that framing is the point of
the setting.

Rejected: an unbounded mode, on the reasoning that the user named the directory so they meant all of
it. A root turns out to be a home directory, or a network mount, or contains a junction to its own
ancestor, and the extension walks until something gives — and the review that follows says it hangs
on startup, which is a review no amount of later correctness recovers from.

**2. Links are never followed, and real paths are remembered.** Descent is decided from the
`readdir(dir, { withFileTypes: true })` dirent, and a link is not a directory. Verified on Windows,
where the realistic cycle risk is a junction rather than a symlink: Node reports a junction as
`isSymbolicLink() === true` and `isDirectory() === false`, so the sibling's `listDirectories` already
refuses to enter it. A set of visited real paths catches the rest, so a cycle terminates rather than
merely being bounded. A root the **user named** is different: it is resolved with `realpath` and
walked, because refusing a link the user pointed at would break the ordinary `~/src -> /Volumes/work`
layout, and a path the user typed is a statement of intent.

**3. A directory budget per root.** A generous cap on directories visited, whose only job is to turn
"the user pointed this at `C:\`" into a reported condition rather than a hang. Reaching it is logged
with the count and the first unsearched directory, exactly as the sibling logs a depth stop, and it
is stated on the list.

Alongside the guards, the sibling's built-in name exclusion list, minus `.git`, whose entry now
means "stop here" rather than "skip this" (D3). Like the sibling's, it applies to what the walk
**descends into** and never to a directory the user named, so a repository living under an excluded
name is still reachable by naming its parent in `additionalRoots`. It is not a setting:
`multirepoLedger.exclude` already removes a repository by path, which is the case users actually have,
and a second, subtly different exclusion mechanism is a second thing to get wrong.

**Spawn count: 0.**

### D11. The row read is one process, and its arguments are chosen by a file already read

Before any process is spawned, the prelude has already read the git directory for D8: `HEAD`, the
operation markers (D17), `shallow`, and the mtime of `FETCH_HEAD` (D18). `HEAD` then decides the
command.

**Case A — `HEAD` contains `ref: refs/heads/<name>`.**

```
  git for-each-ref \
    --format='%(HEAD)%1f%(refname)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(contents:subject)' \
    refs/heads/<name>
```

Zero rows and exit 0 means the branch is unborn: the row says `<name> · no commits yet`.

**Case B — `HEAD` contains a raw object id** (detached, or mid-rebase, D17).

```
  git for-each-ref --include-root-refs --format='<same format>' HEAD
```

**Case C — the prelude could not read `HEAD`.** The command that needs no prior knowledge:

```
  git for-each-ref --include-root-refs --format='<same format>' refs/heads/ HEAD
```

**Both gotchas from the research are real and were re-verified on git 2.52.0.windows.1.** The
pattern alone is not enough: `HEAD` as a bare pattern *without* `--include-root-refs` **returns
nothing, and exits 0** — `for-each-ref`'s pattern matching is literal or up to a slash, so `HEAD`
cannot match `refs/heads/main`, and there is no root ref in the search space to match either. That
signature matters beyond the flag: **zero rows plus exit 0 is the same signature this decision
assigns to an unborn branch**, so the broken command shape does not fail, it lies, and every
detached repository would render `no commits yet`. The flag alone is not enough either:
`--include-root-refs` with *no* pattern also returns `AUTO_MERGE`, `ORIG_HEAD` and every
remote-tracking ref. With both, and only with both, the output is `HEAD` plus the local branches
and nothing else.

Why A and B rather than C for every row: branch count came off the row (D23), so every branch the
broad command formats is a commit object opened to fill a field nothing displays. Scoping the
pattern makes the cost of a row read **independent of how many refs the repository has**, which is
the whole difference between an ordinary row and a row on a repository carrying a thousand refs —
`for-each-ref`'s cost scales with the number of refs it formats, which is the structural finding
the research established. Case C remains the authority: the file read is an optimisation, the
command is what decides, and cases A and B return the refname, which confirms the file was read
correctly.

Reading the output. The row bearing `*` in `%(HEAD)` is HEAD's row. Verified: when a branch is
checked out, `*` is on its `refs/heads/` row and the `HEAD` row's marker is blank; when HEAD is
detached, `*` is on the `HEAD` row and no branch carries it; when HEAD names an unborn branch there
is no `HEAD` row at all and no branch carries `*`, even when other branches exist. Those three
signatures are distinct, and each is corroborated by the `HEAD` file the prelude read.

Delimiters are `%1f` between fields and the newline between records. Rejected: `|`, which the
research's exploratory command used. A commit subject may contain any character, verified with the
subject `fix a|b parsing and %(weird) chars`, which the pipe-delimited form splits in the wrong
place. The newline is safe because `%(contents:subject)` folds a wrapped first paragraph onto one
line — verified: a message whose first paragraph spanned two lines came back space-joined.

`%(upstream:track,nobracket)` rather than the bracketed default (one less thing to strip) and rather
than `%(upstream:trackshort)`, which collapses the answer to `>`, `<`, `<>` or `=` and throws away
the counts the row shows. Verified forms: empty (in sync, or no upstream), `ahead 1`, `gone`.

`%(committerdate:unix)`, never `%(committerdate:relative)`: git words the relative date and git
translates it (D25). The words on the row are the extension's.

**Spawn count: 1 per repository per refresh, in cases A, B and C alike.**

### D12. The capability probe is the first read that needs the flag, not a ping at startup

`--include-root-refs` is present on git 2.52; the version that introduced it is not established. The
research said to probe it once at startup. That is right in substance and wrong in placement:
`for-each-ref` **cannot run outside a repository**, so there is nowhere to probe at startup that is
not already a repository read. The probe is therefore the read itself. Run case B or C as written
and, if git exits **129** with ``error: unknown option `include-root-refs'`` on stderr — the
verified signature — record for the rest of the session that the flag is unavailable and re-read
that one repository with the fallback.

- **Attached** (case A) is unaffected: it never uses the flag, so the great majority of rows cost
  one process on any git.
- **Detached, old git**: `git log -1 --format='%h%x1f%ct%x1f%s'`. One process, and nothing is lost
  — verified, a detached `HEAD` row carries empty upstream fields, because a detached HEAD has no
  upstream to report.
- **Case C on old git**: `git for-each-ref --format='<same>' refs/heads/` plus
  `git log -1 --format='<...>'`. **Two processes, and the only path in the design that costs two.**
  That is the correct trade for an extension that runs on machines its author will never see: one
  repository pays one extra process, once, on a git old enough to need it.

Rejected: parsing `git --version` and comparing. The introduction version is exactly the fact that is
not established, so the comparison would be a guess dressed as a check; and vendor and Windows builds
do not all number the same way. Asking git what it supports by asking it to do the thing is the only
answer that cannot be wrong.

Rejected: a dedicated probe process run inside the first discovered repository before the board
starts. It is one more process, it delays the first row by exactly the thing it is measuring, and it
tells you nothing the first real read would not have told you a moment later.

**Spawn count: 0 extra on modern git. On old git, +1 for the first read that needed the flag, then
the fallback shape thereafter.**

### D13. The child environment is pinned, so nothing being parsed can be translated or interactive

Every git child inherits a deliberately narrowed environment.

- **`LC_ALL=C`, `LANGUAGE=`.** The ahead/behind wording in `%(upstream:track)` and every `fatal:`
  message git emits are marked for translation. The development machine has no translations
  installed, so the failure cannot be demonstrated there — which is the reason to pin the locale
  rather than to test one locale and conclude.
- **`GIT_OPTIONAL_LOCKS=0`.** The environment form of `--no-optional-locks`, verified equivalent. As
  a flag it must precede the subcommand (D14) and it was written the wrong way once already; as an
  environment variable the ordering bug is unrepresentable. The flag is still written, correctly
  placed, because it documents the intent at the call site — but the variable is what makes a future
  misplacement harmless instead of silent. It is also what keeps the watcher loop closed: without
  it, `git status` may refresh and rewrite `.git/index`, which is a file this extension watches
  (D64), so the read would fire the watcher that schedules the read.
- **`GIT_TERMINAL_PROMPT=0`.** Nothing in the row read touches the network, but a read must never be
  able to block on a credential prompt with no terminal to type into, and the forge layer and every
  read added later inherit this rule by inheriting the runner.
- **No shell** (`shell: false` in the sibling's `runGit`, which carries user-controlled paths in its
  arguments), `windowsHide: true`, and no pager, because git only pages when stdout is a terminal
  and here it is a pipe.

Rejected: inheriting the ambient environment unchanged, on the grounds that it is what the user gets
in their own shell. It is, and that is the problem: the extension parses this output, and the user's
shell does not.

**Spawn count: 0.** This is how children are spawned, not an extra one.

### D14. Dirty state is an opt-in second read, for visible rows only, and the flag placement is load-bearing

```
  git --no-optional-locks status --porcelain=v2 --branch
```

**`git status --porcelain=v2 --no-optional-locks` exits 129** with
``error: unknown option `no-optional-locks'`` — verified. It is a git-level option and must precede
the subcommand. Written the wrong way, every dirty read fails and every row falls into the
"repository did not answer" path, which looks like a broken extension rather than a misplaced flag.
D13 sets the environment variable as well for exactly this reason.

It is opt-in, off by default, and it is the only read that asks. Everything else on the board costs
one process whose work is proportional to the repository count; this one walks the working tree, so
its cost is proportional to the number of tracked and untracked files, and on a large tree or a
network share it is the read that makes the board feel slow. The two costs are orthogonal —
`for-each-ref` scales with ref count, `status` with file count — so neither is universally the cheap
one and the only real lever is how many processes are spawned. The row is complete and useful
without it, so it ships off and says what it would add (D30).

It is second-tier: the board renders every row from the tier-one read first, and dirty state is
filled in behind it, for **visible rows only**. There is exactly one exception, and D31 owns it:
while the `dirty` sort mode is selected the read runs for **every** repository, because a sort key
that exists only for the rows currently on screen orders the first screenful and freezes the rest —
an off-screen row never acquires a key, so it never becomes visible, so it is never read. That
exception costs one process per repository and the view says so when the mode is chosen. It is
never run for a bare repository or any
repository without a working tree — `status` there exits 128 with
`fatal: this operation must be run in a work tree`, verified — and the kind is already known at zero
cost from D8, so the process is not spawned to discover that it cannot succeed.

Untracked mode is the default, `normal`, which reports an untracked directory once rather than every
file inside it. Rejected `-uno`: it hides new files, and a row that omits them degrades to a **wrong
impression** rather than to "I don't know", which is the wrong side of the line this project draws.
Rejected `-uall`: it pays per file to produce a glyph.

`--branch` is kept for `# branch.oid`. If it does not match the object id tier one reported, the
repository moved between the two reads, and the row is re-read rather than patched with a dirty
count belonging to a different commit. Verified: in a repository with no commits,
`# branch.oid (initial)` and exit 0, so the empty case is distinguishable without a second thought.

Dropped from the research's earlier command: `--show-stash`. The stash count is not on the row, and
a field the row does not show is not worth a line of output to parse.

Between the tiers the dirty position on the row is **empty, not `0`**. A count the extension has not
established never renders as zero.

**Spawn count: +1 per visible repository, only while `multirepoLedger.dirtyState.enabled` is true; +1 per
*discovered* repository while the `dirty` sort mode is selected (D31).**

### D15. Concurrency is derived from the runtime, bounded by two guards, and overridable

The number of repository reads in flight is `os.availableParallelism()` — which accounts for CPU
affinity, unlike `os.cpus().length`, and is present in the Node the extension host ships at the
declared engine — falling back to `os.cpus().length`, clamped between a floor and a ceiling, and
overridden entirely by `multirepoLedger.concurrency` when it is set above zero.

- **The floor** exists because the work is process startup and waiting on the filesystem, not
  computation. A machine that reports one available CPU — a container with a quota, a constrained
  remote — must not read a hundred repositories one at a time.
- **The ceiling** exists because every unit in flight is a child process holding handles and, on a
  network share, an outstanding request. Unbounded fan-out is how an extension turns a slow disk into
  an unresponsive machine.

Neither is a measurement. Both are named constants whose comment states the failure they prevent, and
both are irrelevant the moment the user sets the setting. **No number from any machine appears in the
derivation.** The walk keeps its own separate bound on directories read at once, copied from the
sibling, which is a file-handle guard and not a CPU figure.

Rejected: a fixed concurrency. Whatever it was would be right on one machine.

Rejected: unbounded concurrency with the OS as the limiter. The OS's limiter is exhaustion, and the
symptom is a window that stops repainting.

Timeouts are **per process, not per board** — the sibling's `runGit` default of 10 s, copied along
with the runner. A repository that has not answered is a stated row — *"did not answer in 10 s"*,
carrying the exact command and a retry — never a disappearance and never a blank. A ref-heavy
repository is the slow row; D11's scoping removes most of that exposure, and case C, the one form
that cannot be scoped, is the one that most needs its own timeout to fall back on. The 32 MiB cap in
`runGit` is the matching guard against unbounded output, and a truncated result is reported as
truncated rather than read as complete.

**Spawn count: 0.** The derivation reads `os.availableParallelism()` and a setting; it spawns
nothing itself. What it governs is how many of D11's and D14's processes are in flight at once.

### D16. Cancellation is by generation, and a superseded answer is dropped rather than rendered

Every discovery-and-read pass carries a generation number and an `AbortSignal`. A refresh, a change
to `workspace.workspaceFolders`, a change to any `multirepoLedger.*` setting that affects what is read or
which repositories are shown, and disposal of the view all abort the current generation and open the
next. The signal goes into `runGit`, which kills the child — the sibling's runner already does this —
and into the walk, which stops between two directories and returns what it has, because a cancelled
discovery is discarded by its caller anyway.

Results arriving with a stale generation are **dropped at the boundary, not merged**. This is the
rule that prevents a board mixing rows read before a folder change with rows read after it, which is
the failure that produces a list nobody can explain.

**Clicking a different repository does not cancel the board.** The list read and the history read are
separate generations, because a user selecting a row is a statement about the history pane and not
about the other rows; the board keeps loading behind the selection. What happens to the in-flight
*history* read is D49, and it is a different answer for a good reason.

Rejected: cancelling everything on selection, so there is one generation to reason about. It stops
the board loading because the user looked at a row, which is the opposite of what a status board is
for.

On `deactivate` and on disposal of the view, the generation is aborted and every child killed.
Nothing outlives the window.

**Spawn count: 0 for the cancellation itself.**

### D17. Mid-operation state comes from marker files that are not in `gitrepository-layout`, so their absence is silence

Verified on git 2.52 by driving each operation into its stopped state and listing the git directory:

| Files under the git directory | State |
|---|---|
| `MERGE_HEAD` (with `MERGE_MODE`, `MERGE_MSG`, `AUTO_MERGE`) | merging |
| `rebase-merge/` with `head-name`, `msgnum`, `end`, `onto` | rebasing, step `msgnum` of `end` |
| `rebase-apply/` with `head-name`, `next`, `last`, and **no** `applying` | rebasing, apply backend |
| `rebase-apply/` with `applying` | applying patches (`git am`) |
| `CHERRY_PICK_HEAD` | cherry-picking |
| `REVERT_HEAD` | reverting |
| `BISECT_START` (with `BISECT_LOG`, `BISECT_NAMES`, `BISECT_TERMS`) | bisecting |

Two things the row must not do with them. First, `head-name` is the branch **being rebased** —
`refs/heads/main` in the verification — not the branch being rebased **onto**; `onto` holds a raw
object id, not a name. So the row reads `rebasing main 1/3`, and if it names the target at all it
names the short object id it actually read. Rejected: resolving that id to a branch name, which is a
second process and, when several refs point at the same commit, a guess.

Second, none of these files appears in `gitrepository-layout(5)`. They are stable in practice and
they are implementation detail. Absence therefore means "not in that state" and never an error, and a
combination the extension does not recognise leaves line 3 showing the HEAD it read. This matters
more than it looks: during a rebase `HEAD` is detached, so without `head-name` the row would say
`detached at <sha>` — true, and useless. These files are what buy the useful sentence, and the code
says so in a comment.

Rejected: `git status --porcelain=v2` for this. Mid-operation state is *entirely absent* from
porcelain v2, so the second-tier read cannot answer it even when it is on.

**Spawn count: 0.**

### D18. `FETCH_HEAD` proves an attempt, so the row never claims a fetch succeeded and never says "up to date"

What the file proves: `<gitdir>/FETCH_HEAD`'s mtime is the last time a fetch **ran**. What it does
not prove: that the fetch reached the remote (it is touched, and truncated to zero bytes, on
failure), that anything changed (a no-op fetch touches it), or that no fetch has ever happened —
verified, it is **absent after a fresh clone** and appears only after an explicit `git fetch`, and it
can be suppressed entirely with `--no-write-fetch-head`.

The rule that follows. When the file exists, the row may say `checked <relative age>` and nothing
stronger — never "up to date", "in sync" or "fetched". When it is absent, the row says **nothing** in
that position, and the tooltip says why. Silence is the correct answer to "when did you last hear
from the remote" when there is no evidence, and this is exactly why the evidence age is the field
that yields first in a narrow sidebar (D24).

The consequence is stated once in plain UI text rather than implied: the divergence on the row is
measured against the remote-tracking refs on disk, so it is as old as the last fetch. The research
demonstrated the failure it prevents — a repository that was truly ahead 1 and behind 1 reads as
ahead 1 until something fetches.

Rejected: fetching to freshen the caption. `git fetch --dry-run` downloads the entire payload despite
its name, and a real fetch writes refs, takes locks and touches the network; the read-only boundary
is not crossed to fill in an age.

Rejected: `git ls-remote` as a cheap probe. It is the cheapest network probe there is, and it is
still the network, once per repository, unprompted, on a board that ships every network feature
disabled. If remote freshness ever ships it belongs beside the forge layer, off by default and
batched, not smuggled into the row read.

Rejected: rendering `never checked` when the file is absent. It is false immediately after a clone,
which is the commonest case of an absent `FETCH_HEAD` — a repository that is perfectly current.

**Spawn count: 0.**

### D19. Dubious ownership is reported with git's own remedy, and there is no trust button

When git refuses a repository whose ownership it does not trust it exits 128 and its message names
the config key `safe.directory`. Detection keys on that token, not on the English sentence around it:
a config key is not translated, and translated builds exist. D13's pinned locale makes this belt and
braces rather than a single point of failure.

The row reads **"not readable — git refused: dubious ownership"** with the path, and offers to copy
the exact command:

```
  git config --global --add safe.directory <path>
```

The extension never runs it, and never passes `-c safe.directory=<path>` in its own invocations.

Rejected: a "Trust this repository" action that adds that argument, or writes the config itself. One
argument makes the row work, and it deliberately defeats a control that exists to stop a repository
sitting in a directory somebody else can write from executing attacker-controlled configuration —
`core.fsmonitor`, `core.pager`, `core.hooksPath` and aliases among it, all of which are commands. An
extension whose entire premise is reading repositories the user has *not* opened is the worst
possible place to keep that switch, because the user has not looked at these directories. The honest
alternative costs the same row and the same click, moves the decision to the user's own shell where
the whole sentence is in front of them and their shell history records that they made it, and defeats
nothing.

Rejected, permanently: a "trust all" toggle. It is not a setting and will not become one.

**Spawn count: 0.** The refusal is the failure of a read already counted.

### D20. Every degenerate repository has a stated row, and most of them cost no process at all

| State | How it is known | Extra processes | What the row says |
|---|---|---|---|
| `git` not on `PATH` | one `git --version` per session, cached, as in the sibling | 1 per session | one explained state for the whole board; no rows are invented |
| No commits (unborn branch) | `HEAD` names a branch; the read returns zero rows, exit 0 | 0 | line 3 reads `main`; line 2 reads `no commits yet` — never a date, and never blank |
| Detached HEAD | `HEAD` holds a raw object id | 0 | `detached at 7c86ebf` |
| No remote, or no upstream | `%(upstream:short)` empty | 0 | the dimmed words `no upstream`; divergence renders **nothing**, never `↑0 ↓0` |
| Upstream gone | `%(upstream:track)` is `gone` | 0 | the dimmed word `gone` |
| Mid-merge, rebase, cherry-pick, revert, bisect, `am` | marker files (D17) | 0 | line 3 carries the operation instead of the branch |
| Bare | no `.git`; the layout test in D8 | 0 | `bare` marker; the dirty read is never attempted |
| Shallow | `<gitdir>/shallow` exists | 0 | `shallow` marker; the history pane says the history *ends*, not that it *ended* |
| Dubious ownership | exit 128 and `safe.directory` in stderr (D19) | 0 | `not readable — git refused: dubious ownership`, with the path |
| Never answers | the per-process timeout (D15) | 0 | `did not answer in 10 s`, with the command and a retry |
| Git directory unreadable | the prelude fails, so case C runs; if that fails too | 0 | git's own first line of stderr, verbatim |

The rule all of these are instances of, stated once and enforced everywhere: **no row is blank, and
no count the extension has not established renders as zero.** A zero is a claim.

Rejected: dropping a repository that cannot be read, so the board only contains rows it can fill.
A row that vanishes is indistinguishable from a repository that was never there, and the count of
unreadable repositories is the one thing a status board must never be quiet about (D30).

**Where the unborn row's words go, settled once.** Three drafts of these documents rendered it three
ways, so it is fixed here and every other document quotes this: **line 3 carries the branch name
alone — `main` — and line 2 carries `no commits yet`.** Line 2 is the commit line, so the absence of
a commit is a fact about line 2 and belongs there; and D35 gives every other unfilled line 2 a
stated word (`reading…`), so an empty line 2 would be the one thing on the board with no stated
meaning. Rejected: `main · no commits yet` on line 3 with line 2 blank, which is the shape an
earlier draft of this table carried — it puts the news on the state line and leaves the line the
extension exists for saying nothing. Rejected: the words on both lines, which is what a reader gets
if the two halves are settled independently, and which says the same thing twice on a row whose
scarcest resource is width.

**Spawn count: 0 beyond the reads already counted** — every row in this table is decided from the
one process of D11, the filesystem, or a failure of a process already counted. The one exception is
the first row, which is the single `git --version` per session named in its own column.

### D21. The repository list is a webview, because a `TreeItem` has two text slots and the row has seven fields

A `TreeItem` offers `label`, `description`, one icon and a tooltip, all on one line. The row this
extension exists to draw is three lines: an identity line with a right-aligned dimmed trailing field,
a commit line whose subject must truncate at the end while the fields beside it do not truncate at
all, and a state line carrying two or three short markers. Nothing in the tree API expresses "this
field ellipsises, that one holds its width, that one disappears entirely" — the editor decides
truncation, and what it truncates first is `description`, wholesale.

Rejected: one `TreeItem` per repository with child items for lines 2 and 3. This is the shape GitLens
uses in its Repositories view, whose rows default to `Expanded` and produce roughly eight children
each. Twenty repositories become sixty-plus nodes and a column of disclosure triangles: a wall to
collapse rather than a list to scan, which is the opposite of the thing being built.

Rejected: `TreeItemLabel` with `highlights`. Highlights are character ranges inside one label; they
do not add a line and they do not right-align anything.

Rejected: putting lines 2 and 3 in a `MarkdownString` tooltip. A tooltip answers about one row at a
time, and a board that must be hovered twenty times is twenty context switches again.

What the webview costs, stated here rather than discovered later: no native keyboard list behaviour,
no native context menu without `data-vscode-context`, no `reveal`, no built-in type-to-filter box, no
virtualisation. D32, D33, D36 and D51 pay each of those back explicitly; a cost that is not paid back
somewhere below is a cost this decision got wrong.

No virtualisation ships in v1. The DOM holds one node per repository, and D22 makes an arriving
answer touch exactly one of them, so the cost of a busy board scales with answers landing rather than
with rows present. If a directory ever makes that hurt, the row is already a self-contained unit
keyed by path and windowing can be added without touching the model.

**Spawn count: 0.**

### D22. The page is rendered once per generation and patched per repository, never re-rendered per answer

The sibling assigns `webview.html` wholesale on every model change, which is right there because the
model rebuilds as a single event. Here, answers arrive one repository at a time across a set with no
upper bound, so wholesale assignment would happen once per repository: the scroll position resets,
focus leaves whatever the user was on, and the page script re-runs, all of it several times a second
during a scan.

So: the extension assigns `webview.html` once per generation — a fresh discovery, a sort change, a
filter change, a theme-driven reload. Everything after that is `postMessage`. A tier-one answer sends
one patch keyed by `data-path`; the page rewrites that row's three lines and nothing else. A
tier-two dirty answer sends a smaller patch touching one span. Re-ordering sends a permutation,
applied as a single reinsertion pass under D32's rules.

Rejected: a rendering framework in the webview to make re-rendering cheap. It is a runtime dependency
in a project that has none, for a page whose entire dynamic surface is three text nodes per row.

Consequence, and the reason this decision sits before the layout ones: because the page persists
across answers it can hold state the extension does not need to know about — scroll position, which
row has focus, whether the pointer is inside the list — and D32 depends on exactly that.

**Spawn count: 0.**

### D23. The three lines, field by field

**Line 1** — `<name>` · `↑2 ↓1` · `<dirty glyphs>` · `<checked 3h ago, dimmed, trailing>`

The name is the repository directory's base name and it wins every width contest on this line. When
two repositories on the board share a base name — common in a directory holding `client/api` and
`server/api` — the name slot renders the nearest distinguishing ancestor segment ahead of it, dimmed:
`client/api`. Rejected: rendering the full path always, which is unreadable in a sidebar; rejected:
never disambiguating, because two rows that read identically are worse than one row that reads long.

Divergence and dirty glyphs are fixed-width runs of a few characters and never truncate; D26 and D27
own what they say. The evidence age trails, right-aligned, dimmed, and D24 owns the fact that it is
the field that disappears.

**Line 2** — `<relative date>` · `<subject>`

This is why the extension exists. Neither core's Source Control row nor GitLens's repository node
carries the last commit's date and subject without expanding, and nobody sorts by it; line 2 and D31
are one idea, not two features. The date is fixed-width and leads. The subject takes the rest and
truncates at the **end**, with the full subject in the row's tooltip. Rejected: middle-truncation.
`fix: correct the … in the parser` eats the verb, which is the only word in a commit subject that is
reliably load-bearing.

**Line 3** — `<HEAD state>` · `<kind marker>` · `<PR/MR count, when enabled>`

The HEAD state is `main`, or `detached at 7c86ebf`, or `rebasing main 1/3`. A repository with no
commits shows its branch name here like any other and states the absence on line 2, for the reason
D20 settles. It
replaces what the original sketch called "branches": a branch **count** is dropped, because no
surveyed tool — gita, gr, mgitstatus, mani, mu-repo, GitHub's organisation board, GitKraken
Workspaces — carries one as a per-repository column, and the reason is that the number answers no
question. Twelve branches and two branches call for the same action, which is none.

The kind marker renders only when the repository is not a plain one: `worktree`, `submodule`, `bare`,
`shallow`. A plain repository shows nothing there, so the marker's presence is itself the signal.

The PR/MR count renders only when the forge layer is on and this repository's query answered.
`2 PR` on a GitHub remote and `2 MR` on a GitLab one, because the two forges name the thing
differently and picking one word makes the row wrong on the other host. **The term is not
pluralised**, and that is a decision rather than an oversight: the unpluralised form does not have
to change shape at a count of one, so `1 PR`, `2 PR` and `0 PR` are one fixed-width run the eye
reads as a column rather than three shapes it has to parse. This form is the one D57's table uses,
and it is the only one — an earlier draft of this paragraph wrote `2 PRs`, which left a reviewer
checking a row against the design with two answers. A query that failed renders
its reason, dimmed. It never renders `0` unless the query succeeded and the answer was zero (D57).

Every field carrying text from a repository is HTML-escaped on its way into the page and wrapped in
`<bdi>`. Escaping handles markup; it does not handle U+202E and the rest of the bidi override set,
which a commit subject can carry and which can visually reorder the remainder of the line — including
making one row's text appear to belong to another. C0 and C1 control characters are replaced with
U+FFFD, and each field is isolated. A cloned repository is somebody else's text arriving in our page,
and it is treated that way.

**Spawn count: 0.** Every field on all three lines comes from the one process of D11, the opt-in
process of D14, or the filesystem.

### D24. The evidence age is the only field that disappears, and it is the only one whose absence means "I don't know"

At narrow widths the yield order is fixed: the evidence age is hidden entirely; then the subject
truncates; then the HEAD state truncates; the name truncates last and never vanishes; the divergence
run, the dirty glyphs and the kind marker never yield at all.

The rule behind that order is not "least useful first". It is that **the field which yields is the
one whose absence degrades to "I don't know", never to a wrong impression.** Hiding the evidence age
leaves the reader knowing they do not know how fresh the comparison is — which is the honest state
anyway (D18). Hiding a divergence figure, a dirty glyph or a kind marker would instead leave a row
that reads as clean, in sync and ordinary. That is a wrong impression, and a status board that
produces one has failed at the only thing it does.

The field is hidden, not truncated: `checked 14mo…` is worse than nothing. In CSS this is a container
query on the row, with the threshold expressed in `ch` as the sum of the name's minimum legible
width, the fixed-width runs beside it, and the widest form this field can take. That is a formula
over the row's own content and the theme's own font, **not a pixel count from anybody's screen.**

The word is `checked`, not `fetched`, for D18's reason.

Rejected: shrinking every field proportionally, which produces three truncated fields instead of one
missing one, and leaves the reader unsure which of them they are misreading.

**Spawn count: 0.**

### D25. Relative dates are computed here, not asked of git

The row read takes `%(committerdate:unix)` and the extension turns it into `just now`, `12m ago`,
`3h ago`, `2d ago`, `5w ago`, `7mo ago`, `3y ago`. The history pane uses the same formatter on `%ct`,
so one rule covers both surfaces.

Rejected: `%(committerdate:relative)` and `--date=relative`, which git localises to the machine's own
locale. Every user-facing string in this extension is English, so on a machine where git speaks German
the row would read `vor 3 Tagen · fix: correct the parser` — half a line in each language, from a
formatting choice nobody made.

Rejected: `Intl.RelativeTimeFormat` against `vscode.env.language`, which is the same mismatch
approached from the other side. The rest of the row is English regardless of the display language; a
date that follows the display language would be the one localised token in an English sentence.

Two consequences worth stating. A timestamp in the future — a skewed clock, a rewritten committer
date — renders as `just now`, with the absolute local timestamp in the tooltip: a row reading
`in 3 days` is read as a bug in the extension, and it very nearly always is a bug in somebody's
clock. And because a relative date goes stale without any git read, the page schedules its next
recomputation for the exact instant at which the *nearest* visible row would change its wording,
which is computable from that row's timestamp. That is one timer derived from the data on screen,
rather than a polling interval somebody picked.

The tooltip always carries the absolute local date and time, because two relative dates cannot be
compared precisely against each other.

**Spawn count: 0.**

### D26. Divergence renders nothing at zero, and `no upstream` and `gone` are words, not silence

`↑2 ↓1` when both are non-zero, `↑2` or `↓1` when one is, and **nothing at all** when both are zero.

Rejected: `↑0 ↓0`, `=`, or a green tick. Twenty rows of zeros is twenty pieces of furniture the eye
has to step over to find the two rows that are not zero, and the whole value of the board is that the
exceptions are the only marks on it. Silence is only safe because a row that has not answered yet is
in a *stated* reading state (D35) with its own line 2: the row carries whether it has answered, so a
field never has to imply it.

Ahead leads. The built-in git extension writes the pair the other way round, `{behind}↓ {ahead}↑`, and
matching a neighbour's convention is normally worth something — but the tally header leads on
unpushed work (D30), and a header chip that filters to "these three have work only on this machine"
must land on rows whose first figure is that same number. A header and a row that read in different
orders make the click feel like it went somewhere else.

The glyphs are never the only channel: the tooltip spells both figures out — "2 commits here are not
on `origin/main`; 1 commit on `origin/main` is not here" — so the arrows never have to be learned, and
a high-contrast theme that flattens colour loses nothing.

`no upstream` and `gone` render as their own dimmed words. Both are facts about the branch, not
absences, and both change what the reader would do next: one means push has nowhere to go, the other
means the remote branch was deleted underneath them. Rejected: `%(upstream:trackshort)`, whose `>`,
`<`, `<>`, `=` alphabet is compact and throws away the counts, which are the actionable part.

**Spawn count: 0.**

### D27. Dirty state borrows the three characters the editor already shows, and never a number

When the second-tier read is on, dirtiness renders as `*` for working-tree changes, `+` for staged
changes and `!` for conflicts.

These are not invented. They are the markers the built-in git extension already puts in its own
status-bar text in the same window, so a reader who has used VS Code for a week can already read
them. Rejected: a second glyph vocabulary for the same three facts, which is a second thing to learn
for no gain.

Rejected: a changed-file count. Core's own judgement is visible in the default —
`scm.providerCountBadge` is `'hidden'`, so the count is off out of the box while the markers are on.
A count also invites arithmetic across rows — "14 here, 3 there" — that means nothing, because
porcelain v2 counts entries, not units of review.

**And a number nobody shows is a number nobody may sort by.** An earlier draft had the `dirty` sort
mode order the board by exactly the entry count this paragraph refuses to display, which produces
two rows both bearing `*` in an order the reader cannot account for from anything on screen —
the same failure as a composite score (D29), arrived at from the other direction. D31 therefore
orders that mode by a **rank read off the glyphs themselves**, so the order is explained by the row.

While the second-tier read is off, the glyph slot renders nothing for every row, uniformly, and the
header states once that uncommitted changes are not being read (D30). That is what makes the empty
slot unambiguous: the ambiguity between "clean" and "not asked" is resolved globally by a visible
control, not row by row. While the read is on but a particular row's answer has not landed, that
row's slot carries a dimmed placeholder, because there the ambiguity is genuinely local.

**Spawn count: 0 beyond D14's opt-in read.**

### D28. Compact density folds the row; it does not drop anything

Twenty repositories at three lines each is sixty lines before the history pane gets any room, and the
two views share one container.

`multirepoLedger.rowDensity` takes `comfortable` (default, three lines, the shape the requirement asks for)
and `compact`. Compact merges lines 1 and 3 into one: name, divergence and dirty glyphs on the left;
HEAD state, kind marker and PR/MR count dimmed on the right. Line 2 survives untouched. Two lines per
row, and **nothing removed.**

Rejected: dropping line 3 in compact mode. A user with many repositories is exactly the user who will
leave compact on permanently, and line 3 is where a detached HEAD and an interrupted rebase live.
Hiding an interrupted rebase in the mode that many-repository users adopt is hiding it from the only
people it happens to.

Rejected: a one-line mode. One line cannot carry the last commit's date and subject, and that line is
the entire differentiator; a mode that drops it is a worse version of the Source Control view.

Rejected: switching density automatically above some repository count. The threshold would be a
number from one machine's directory, and worse, the row would change shape underneath the reader as a
background scan discovered its twenty-first repository. Density is a preference and lives in settings,
with a toggle in the view title that writes the setting so the choice survives a reload.

**Spawn count: 0.**

### D29. A closed set of states, a set per row, and no score

The vocabulary is: `clean`, `dirty`, `unpushed`, `behind`, `detached`, `mid-operation`, `no-upstream`,
`unreadable`. Nothing else. A repository carries a *set* of these, not one of them — dirty and behind
and detached is an ordinary Tuesday — and one pure module, `model/state.ts`, decides that set for
every consumer.

Rejected: a composite health score, a percentage, or a traffic light. The sibling deliberately has
none, for a reason that applies here with more force: a score is a claim that these facts are
commensurable, and they are not. Two unpushed commits and a dirty lockfile do not add up to anything,
and once they are added up the reader has to reverse the arithmetic to find out what to do — which
means opening the row, which is the context switch the board exists to remove.

Rejected: a free-form status string per repository. It cannot be filtered, counted, sorted or tested,
and it drifts into eight phrasings of the same state.

The set being closed is what makes D30's tallies countable, D31's ordering definable and D33's filters
exhaustive, and it is what lets one unit test enumerate every state a row can be in. It also forces
every state to have a word or a glyph rather than only a colour, which is what makes the row survive a
high-contrast theme. Two surfaces computing the same judgement separately will eventually disagree,
and a reader who sees a warning in the header and a calm row beneath it stops trusting both.

**Spawn count: 0.**

### D30. The tally header is a row of filters, and a count that cannot be clicked is decoration

Above the list sits a compact chip per state that earned one: `↑3 unpushed`, `2 behind`, `2 dirty`,
`1 rebasing`, `1 unreadable`. Clicking a chip filters the list to those repositories; clicking the
active chip clears the filter, so one control both narrows and widens. Each chip's tooltip and
accessible label is the full sentence — *"3 repositories have commits that are not on the
remote-tracking refs on this machine"* — and when a filter is active that sentence is printed under
the chips, on its own line, because that is the moment it is worth the width and because the active
filter should be stated rather than merely implied by a shorter list.

**That sentence is worded against the evidence, and an earlier draft was not.** It said "commits
that exist only on this machine", which is the natural phrasing and is a claim nothing local can
make: the ahead figure comes from `%(upstream:track)`, measured against a remote-tracking ref that
is only as fresh as the last fetch (D18). A user who pushed from a second clone, or whose colleague
pushed the same commits, has a stale `origin/main` and a row that reads ahead — and the old sentence
then asserted those commits exist nowhere else, which is false and cannot be falsified from disk.
The `behind` chip was already worded this way ("behind what was last fetched from their remote") and
the two now match. The row's own `checked <age>` caption is what dates the claim.

**A state earns a chip when a reader would want to see all of them at once and then do something.** By
that test:

- `unpushed` earns one, and leads. It is the question the header exists to answer.
- `behind` earns one, worded against what was fetched — "behind what was last fetched from their
  remote" — never against the remote itself, which nothing local can speak for (D18).
- `dirty` earns one only while the second-tier read is on.
- `mid-operation` earns one, and when the count is 1 the chip names the operation (`1 rebasing`)
  instead of the category.
- `unreadable` earns one. It is the count that says the board is incomplete, which is the one thing a
  status board must never be quiet about.
- `detached` does not. It is a legitimate steady state — a worktree pinned at a tag, a deliberate
  checkout — and a count of it prompts nothing.
- `no-upstream` does not. A scratch repository or a local-only tool is supposed to have none, and a
  chip counting them nags about a decision the user already made.
- `clean` does not. "Seventeen repositories are fine" is the absence of news, and it would take a slot
  from the chips that are news.

A chip with a count of zero does not render. A chip whose count the extension could not establish does
not render either — same code path, same rule.

**While the generation is still reading, every chip is a lower bound, and the header says so.** Rows
exist from discovery (D35), long before git answers, so on a two-hundred-repository board the chips
are computed from whatever has landed. Left unqualified, `3 unpushed` beside a hundred and ninety
unread rows is a lower bound rendered as a count — the exact failure D56 refuses for a forge answer,
and D30 does not get to inherit a weaker rule than the network layer. So while any discovered
repository in the current generation has not answered, the header carries, dimmed, on the same line
as the chips, `<answered> of <discovered> read`, and the sentence under an active filter carries it
too. When the generation completes the line disappears and the chips are counts.

Rejected: suppressing the chips until every row has answered. It empties the header for exactly the
span in which the board is most interesting to look at, and on a directory with one repository on an
unreachable mount it empties it for ten seconds, or for good. Rejected: rendering the chips
unqualified and letting the busy indicator imply the rest. The busy indicator says work is
happening; it does not say that the number beside it is smaller than the answer, and a reader who
clicks `3 unpushed` and gets three of an unknown number has been told something untrue by
omission.

When no chip has a count the header is not blank, because a blank header reads as "not loaded yet". It
renders one sentence naming what was checked — `Nothing here is unpushed, behind or unreadable.` — and
appends, dimmed, `Uncommitted changes are not being read.` when the second-tier read is off. That
sentence is also the permanent home for the fact D27 depends on.

Rejected: a chip per state with a total that adds up. The sets overlap, so the chips cannot partition
the list, and a header that looks like it partitions invites the reader to subtract.

Rejected: counts without the click. That is the decoration this decision is named for: a header that
says three repositories have unpushed work and then makes the reader find them by eye has moved the
work rather than done it.

**Spawn count: 0.**

### D31. The default sort is most-recently-committed, and that is half the differentiator

The built-in git extension sorts by discovery time, name or path; GitLens sorts by discovered,
last-fetched or name. **Nothing sorts by last commit.** Line 2 is what makes that sort legible and the
sort is what turns a list of repositories into a board, so they are one idea. This is not a preference
with a default; it is the point, and it is what the first paragraph of the proposal claims.

Four modes:

- `recent` (default) — HEAD's committer date, newest first.
- `name` — the base name, `localeCompare`, which is the mode for a reader who knows what they are
  looking for.
- `divergence` — ahead plus behind, descending; ties broken by ahead descending, because work that
  exists only here is more urgent than work that exists only there.
- `dirty` — by the **glyph rank** `!` (conflicts) above `*`+`+` above `*` above `+` above clean,
  descending, with the entry count as an internal tie-break inside a rank and `pathKey` after it.
  Not by the raw entry count: D27 refuses to *show* that number, and ordering the board by a number
  the board does not show leaves two rows both bearing `*` in an order the reader cannot account
  for. The rank is legible from the glyphs already on the row, so the order explains itself.

  Two things follow that an earlier draft got wrong, and both are the mode's whole feasibility.
  Selecting `dirty` **turns the second-tier read on** if it is off, and says so, because a mode whose
  key does not exist orders by nothing. And selecting it **lifts D14's visible-rows restriction for
  as long as it is selected**: the read runs for every discovered repository, not for the rows on
  screen. Under the three-rank rule a repository with no dirty answer has no key and sorts into rank
  2, below every answered row — so with the visible-rows rule in force it never becomes visible,
  never gets read, and never acquires a key, and the mode orders the first screenful and freezes
  the rest of the board permanently. The cost is stated where it is chosen: one `status` process per
  repository, which is the board's most expensive read, incurred because the user asked this
  particular question. Rejected: dropping the mode instead, which is the cheaper fix and which the
  user settled against — dirtiness is one of the four modes.

Every mode ends in the same tie-break: the case-folded absolute path, via the `pathKey` helper copied
from the sibling. Rejected: the name as the tie-break — two repositories can share one, and a name tie
would let them swap places between two passes over identical data.

Three ranks, ahead of any mode's key:

1. Repositories with a key, ordered by the mode.
2. Repositories with **no** key for this mode, by path. A repository with no commits has no committer
   date; one with no upstream has no divergence figure. Neither sorts as zero. A repository with no
   commits sorting to the top of "most recently committed" would be a lie about which repository moved
   last, and sorting it to the bottom among the ordinary ones would hide it; it goes into a group
   whose rows say `no commits yet` on line 2, so its position is explained by its own text.
3. Unreadable repositories, last, by path. Burying them is only acceptable because D30 puts their
   count in the header with one click to reach them, and this decision depends on that one.

The mode lives in `workspaceState`, not in settings: a sort order chosen for the afternoon is not a
preference, and writing it to `settings.json` would put a diff in the user's dotfiles for a click.

**Spawn count: 0.**

### D32. A row changes position at most once per generation, and never while the pointer or focus is in the list

The sort key for the default mode does not exist until a repository has answered, so ordering is a
live problem, not a rendering detail.

The invariant: **a row moves at most once per generation — at the moment its answer arrives and it
leaves the unanswered group for its true place.** Before that it sits in rank 2 of D31, visibly
unanswered. After that it does not move again unless the user changes the sort, the filter, or
triggers a rescan.

That invariant alone is not enough, because "at most once" can still be under the pointer. So the page
holds re-ordering while the pointer is inside the list or while any row has keyboard focus, queues the
pending permutation, and applies it on `mouseleave` or on blur. There is no timing constant anywhere
in this: the condition is literally the thing being protected against — a row must not move under the
pointer — expressed as the pointer's own presence. Keyboard focus is included for the same reason with
more force: reordering under a focused row moves the focus with it, and the user's next arrow key goes
somewhere they did not choose.

Rejected: re-sorting on every arriving answer. The list churns for the whole scan and clicking anything
during it is a lottery.

Rejected: withholding the list until every answer is in. It contradicts the rule that nothing waits for
everything, and one repository on a network share would hold the whole board.

Rejected: a settle timer. Every value for it is a number from one machine's disk, and the failure it is
meant to prevent is stated more directly by the pointer condition anyway.

Scroll position and the focused row survive every re-order, because D22 keeps the page rather than
replacing it.

**Spawn count: 0.**

### D33. Two filters that compose, and the text one exists because D21 gave up the tree's filter box

**State filter** — one at a time, set by a header chip, cleared by the same chip.

**Text filter** — one input in the header, case-insensitive substring, matched against the repository's
name, the last-commit subject, and the *rendered text of line 3*. Rejected: fuzzy matching, which needs
a relevance ranking, and a ranking fights the sort mode that D31 established as the whole point of the
surface.

Matching against line 3's rendered words is worth its own sentence, because it is what closes the gap
D30 deliberately left. `detached`, `rebasing`, `no upstream`, `worktree`, `submodule` and `shallow` earn
no header chip — they prompt no bulk action — but a reader who wants them can type them and they are
found, with no additional UI and no additional vocabulary. This works only because the UI language is
English and the rendered words are therefore stable, which is the same premise D25 rests on.

The two compose with AND. When either is active the header says `showing N of M`; `M` is the number of
repositories discovery found, which the extension did establish, so that figure is honest in a way the
counts in D30 are careful about.

An empty result is a stated answer, never a blank pane: "No repository is unpushed", "No repository
matches *api*", each with the click that clears it — and it is the same click that set it, so the way
back is where the way in was.

`multirepoLedger.exclude` is not a filter and must not be confused with one. An excluded repository is not
walked, not read, not counted in any tally and not present in `M`. Filtering is momentary and states its
effect; exclusion is permanent and silent, which is why it lives in settings and not in this header.

Both filters live in `workspaceState`, for D31's reason.

**Spawn count: 0.**

### D34. Selection is by path, is restored lazily, and is never made on the extension's own initiative

The list has one selected row and it drives the history pane. Selection is keyed by absolute path, so it
survives a re-order, a filter change and a rescan.

**No row is selected automatically, ever.** Selecting spawns a `git log`, and spawning one because the
view happened to open is work the user did not ask for, on a path where the rule is that nothing runs
during activation.

The previous selection *is* restored from `workspaceState` — but the read behind it fires when the
history view first becomes visible, not when the extension activates. A window reopened on a collapsed
history pane costs nothing.

Rejected: selecting the first row so the pane is never empty. It spends a process, on startup, on a
repository the user did not choose, to avoid an empty state that D50 makes informative anyway.

If the selected repository is gone at the next scan — deleted, renamed, newly excluded — the history
pane says so rather than silently emptying, because an empty pane is indistinguishable from a pane that
is still loading.

The keyboard contract separates focus from selection deliberately: arrow keys move focus only, Enter or
Space selects. Rejected: selection-follows-focus, which spawns a `git log` for every row the user arrows
past.

**Spawn count: 0 for the selection itself; the pane's first page is D40's 1 process.**

### D35. Before, between and instead of answers

**Before any git answer.** Discovery is filesystem work and answers long before git does, so rows exist
as soon as it names them: real name on line 1, `reading…` on line 2, nothing on line 3, in rank 2 of
D31. Rejected: showing nothing until the first git answer, which makes a cold start look broken while
hiding the one fact already known; rejected: skeleton shimmer bars, which are an animation standing in
for a name the extension already has.

**While discovery is still walking with nothing found.** The busy bar from the sibling — a two-pixel
indeterminate strip, with `prefers-reduced-motion` handled — plus "Looking for repositories…".
Indeterminate because there is no denominator: nobody knows how many directories the walk will see.

**Between generations.** The previous generation's rows stay, dimmed, under the busy bar. They are the
answer to the previous question and they are still worth reading; replacing them with a spinner throws
that away to say something the bar already says.

**Nothing found.** The list renders its own empty state with its own buttons, which post messages rather
than using `command:` URIs — the content security policy admits no navigation at all (D36). It does not
rely on `viewsWelcome`, which binds to tree views.

**A repository that timed out.** The row stays, with its name. Line 2 says `did not answer in time`,
line 3 says nothing, the row joins the `unreadable` set so it is counted in the header and reachable in
one click, and it offers Retry. It is never removed and never zeroed.

**A repository git refused.** D19's row, with D19's action.

Through all of it, one rule holds: **a count the extension has not established never renders as zero.**

**Spawn count: 0.**

### D36. Themed from variables only, keyed by a nonce, and reachable without a mouse

This decision governs both webviews, which is one of the reasons D37 makes the history pane a webview
too: one page skeleton, one policy, one keyboard contract.

**Content security policy.** `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'` and nothing
else, with `localResourceRoots: []`. No `img-src`, because there are no images: every icon is inline SVG
painted with `currentColor`, which is not subject to `img-src` and which takes the row's own state
colour without a second table of colours. No `font-src`, because the page uses
`var(--vscode-font-family)`. No `connect-src`, so the page cannot reach the network even if something in
it tried. Rejected: loading the codicon font, which would need a resource root and gains three glyphs the
row does not need; rejected: emoji, which render as somebody else's artwork at somebody else's size and
differ per platform.

Every message arriving from a page is validated against the known set of modes and actions before it is
acted on. The page is ours, but a webview message still crosses a boundary, and a stored mode from an
older build is exactly the kind of thing that arrives unrecognised.

**Theming.** Every colour is a `--vscode-*` variable with a fallback chain, never a literal except as the
final fallback; `color-scheme: light dark`; the body background is `transparent`, so the sidebar paints
behind the page and the edges do not fight the theme. Lines 2 and 3 sit at `0.92em` against
`--vscode-descriptionForeground`, and the history pane uses the same rhythm so the two views read as one
surface. Colour is never the only channel for a state — D29 forces a word or a glyph for every one of
them — which is what makes the board survive a high-contrast theme.

**Keyboard.** The list is `role="listbox"` with each row `role="option"` and a roving tabindex: one stop
for the whole list, arrows to move within it, Enter or Space to select, the menu key for the actions.
Rejected: a focusable button per row in the natural tab order, which is what the sibling's panel does and
what would put twenty stops between the sidebar and the history pane below. A reader who tabs twenty
times to get past a list turns the extension off, and they are right to.

**Spawn count: 0.**

### D37. The history pane is a webview too, and the tree loses on a narrower argument

With graph lanes out of scope (D38), the `TreeView` case is much stronger than it was and has to be
beaten on its merits. A commit history is a flat, homogeneous list of one-line rows; commits expand into
their changed files, which is a tree's home ground; `TreeItem` supplies virtualisation over an unbounded
list, native selection and keyboard navigation, the built-in find widget, `label` plus a dim `description`
for "date · subject", `TreeItem.command` for the click, `contextValue` for a context menu, and a
`ThemeIcon` with a `ThemeColor` that would mark an unpushed commit perfectly well. All of that is free and
none of it is available in a webview without being rebuilt. **This is a genuine cost and the tree was the
other draft's answer.** Two things defeat it, and neither is the graph.

**The pane has to render statements above a non-empty list.** "Rebasing `feat` onto `7c86ebf` — this is
the history of what it is being rebased onto; 3 commits are not yet replayed." "Last fetch was attempted
2 days ago." "Showing the most recent N commits." "This page was truncated; the list is incomplete." Each
of these is a caveat that makes the rows beneath it mean something different, and each must be visible
*while rows are on screen*. `viewsWelcome` renders only when the tree is empty, which is exactly when none
of these apply. The view title and description hold one short line, already contested by the repository
name. The remaining option is a `TreeItem` pretending to be a banner, which is a fake row the user can
select, expand and click, in a list where every other row is a commit. The mid-rebase case is not
cosmetic: verified, during a conflicted rebase HEAD is detached at the *onto* commit, so `git log HEAD`
returns the history of what is being rebased onto and not the branch the user thinks they are on. A pane
that renders those rows with no explanation is answering a different question than the one asked.

**Ref chips are the pane's only classification, and a tree flattens it.** `--decorate=full` is chosen
(D45) so that a tag named `main`, a local branch named `main` and a remote-tracking `origin/main` are
three distinguishable facts. A `TreeItem` has one icon slot and one dim `description` string, so all three
arrive on screen as the same grey text and the distinction the command-line argument exists to preserve is
thrown away at the last step.

Rejected: a `TreeView` with the caveats moved into a tooltip. A caveat nobody hovers is a caveat nobody
reads, and the rebase banner is precisely the case where the rows are misleading without it.

Rejected: a `TreeView` with the caveats pushed up into the repository row above. That puts the explanation
of the pane in a different view from the pane, and the row is already contested for width by D23 and D24.

**What is given up, and how it is paid back.** Virtualisation, the find widget and native keyboard
handling become this extension's problem. Rows are a fixed height so the list can be windowed at a fixed
offset per row; **at most one commit is expanded at a time** (D46), which keeps height accounting to
"N fixed rows plus at most one variable block"; the pane declares its own keyboard map under D36; and
pages are bounded and capped (D48) so the list is never unbounded in practice. The find widget is simply
lost, and the mitigation is that the pane is not a search surface.

**Consequence for the manifest, which a reviewer will check.** `multirepoLedger.history` is declared today
without a `type`, which makes it a tree, and both `viewsWelcome` blocks are attached to it. It becomes
`"type": "webview"`, and those two welcome blocks — which describe *no workspace* and *no repositories*,
states of the list rather than of the history — stop rendering and move into the list's empty states
(D35). Both panes are then webviews, one rendering model, one policy, and the selection travels between
them as an extension-host message rather than a `TreeView.onDidChangeSelection` event.

**Spawn count: 0.**

### D38. Graph lanes are out of v1

The pane is a dated list. No merge lanes, no tracks, no ASCII graph, no lane column of any kind.

Rejected: drawing lanes computed from the parent list, which is what the user first asked for and what an
earlier draft of this document designed. Three things go wrong with it.

**It is the least differentiated work in the project.** VS Code ships a Source Control Graph pane on
by default, with a repository picker, doing commit → changed files → native diff. Building a second,
thinner graph beside it spends the largest single block of effort in the change on the one surface where
the competition is strongest and already installed. What survives as a differentiator is the last commit
on a per-repository row and the sort by it — neither of which needs a lane.

**Lane layout is a week on its own, and most of that week is edge cases.** Assignment, release and reuse of
lane columns; a merge with more than two parents; a lane that must survive a page boundary as a carried
frontier; a parent that is not in the walk at all because the rev set excludes it or the page ended; a
repository with more concurrent lines of history than there are columns. Each is a correctness problem, not
a polish problem, and a graph whose lanes are quietly wrong is worse than no graph, because it is believed.

**In a narrow sidebar the lanes take width from the field that justifies the extension.** The lane column
is drawn at the left, at a fixed width per lane, before the subject starts. On a sidebar dragged narrow the
subject is what gets truncated, and the subject is the thing this project exists to show.

**What would have to be true for it to come back.** The pane is a webview (D37) and `%P` is in the model
from day one (D44), so the later change is additive: a lane column, a pure `history/lanes.ts` computing a
`LaneRow` from the parent list, and a carried frontier across pages. Nothing about the read, the parse or
the paging changes. It comes back when the pane's other work is finished and either the sidebar is not the
only place the pane runs — an editor-area panel has the width — or the user asks for it after living with
the list.

**Spawn count: 0.** Lanes were never going to be read from `git log --graph`; its ASCII art is not
parseable back into structure. This decision removes a computation, not a process.

### D39. The native per-file diff, and the `FileSystemProvider` it requires, are out of v1

Clicking a changed file does not open a diff editor in v1. What it does instead is D47.

The mechanism is not in doubt, which is why this is a deferral and not an oversight. The `git:` URI scheme
is registered by the built-in git extension as a read-only `FileSystemProvider` whose `readFile` throws
`FileNotFound` for any repository that extension's model has not opened. At the declared engine floor there
is no fallback at all; on newer builds the fallback fires only in an empty window. This extension's entire
premise is repositories outside the workspace **in a window that has a workspace folder**, which is exactly
the set `git:` refuses. So a working diff requires this extension to register **its own** read-only
`FileSystemProvider` on a private scheme, backed by `git cat-file`, returning `Uint8Array`.

That provider is the deferred item, and it is deferred because of what it drags behind it:

- **Missing blobs.** A blob referenced by an old commit can be gone after `gc` in a shallow or partially
  cloned repository, and `cat-file` then fails per file rather than per commit, so the failure has to be
  reported inside an already-open diff editor.
- **Submodule paths.** A submodule entry has mode `160000` and its "blob" is a commit id in another
  repository. `cat-file` in the parent cannot produce content for it, and a diff editor asked to show it
  must say why rather than show an empty pane.
- **Mode-only changes.** Both sides have the same blob id and differ only in mode. A diff editor handed two
  identical byte streams renders *no change*, which is a lie about a commit that did change something.
- **LFS pointers.** A repository using Git LFS stores a short text pointer as the blob. `cat-file` returns
  the pointer, the diff editor renders it as text, and the user sees two different pointer files diffed as
  if they were the content. This one is the worst of the four because it fails **silently and plausibly**.

Rejected: the `git:` scheme, per the mechanism above.

Rejected: calling the git extension's exported `api.openRepository()` to make `git:` work. It dumps every
watched repository into the user's Source Control view. A status board that rearranges the sidebar it is a
guest in is not a status board (D52).

Rejected: a `TextDocumentContentProvider`, which needs no scheme registration and looks like the cheap way
in. It returns a `string`, and its declared content is EOL-normalised, so a file committed with CRLF is
handed to the diff editor with LF, and a commit whose only change is a line-ending change renders as no
change at all. A diff that lies is worse than a diff that is absent.

**What would have to be true for it to come back.** Each of the four cases needs a stated behaviour and a
test: a missing blob names the object id, a submodule row is not clickable and says so, a mode-only change
is rendered as a statement rather than as an empty diff, and an LFS pointer is either resolved or labelled
as a pointer. When those four have answers, the provider is one module and the click target changes from
D47's action to `vscode.diff`. D47's action then moves to the context menu rather than being removed.

**Spawn count: 0 in v1.** The deferred design would have cost at most 2 `cat-file` per opened file.

### D40. One `git log` per page, and this exact command

Hashes, parents, refs, both dates, author and subject come out of a single process.

```
  git --no-optional-locks log
      --no-show-signature
      --decorate=full
      --encoding=UTF-8
      --date-order
      --ignore-missing
      -z
      --format=%H%x1f%P%x1f%D%x1f%at%x1f%ct%x1f%an%x1f%s
      --max-count=<page size>
      --skip=<offset>
      HEAD [<upstream ref>]
      --
```

Every flag makes the output independent of configuration the extension cannot see.

- **`--no-optional-locks` precedes the subcommand.** It is a git-level option:
  `git log --no-optional-locks` exits 128 with `fatal: unrecognized argument`, verified. It is a no-op for
  `log` and it is passed anyway, so that every git command in this extension is visibly non-mutating
  without the reader having to know which subcommands take opportunistic locks (D14).
- **`--decorate=full`, and not for the reason it looks like.** Verified: `%D` is **not** suppressed by
  `log.decorate=false`, `log.decorate=no` or `--no-decorate` — decoration still appears. What `log.decorate`
  controls is the *form*: without `--decorate=full` the same commit yields `HEAD -> main` rather than
  `HEAD -> refs/heads/main`. The chips do not vanish, they become **ambiguous** — a tag named `main`, a
  branch named `main` and a branch literally named `origin/main` all collapse to strings that cannot be told
  apart. `--decorate=full` on the command line overrides a user's `log.decorate=false`, also verified. This
  is recorded because the plausible reason for the flag is the wrong one.
- **`--encoding=UTF-8`,** because `i18n.logOutputEncoding` can make git emit a legacy encoding and the
  runner decodes as UTF-8.
- **`--no-show-signature`,** because `log.showSignature` prepends verification output to each record and the
  extension cannot see that setting. This is a guard, not a verified failure: the repositories used to check
  these commands hold no signed commits.
- **`%H` rather than `%h`,** so `log.abbrevCommit` and `core.abbrev` cannot change the field's length.
  Verified: `%H` under `log.abbrevCommit=true` still yields the full id. D41's resynchronisation rule relies
  on that length.
- **`--ignore-missing`,** so naming an upstream ref that is configured but not present on disk — a
  remote-tracking branch that was never fetched — drops that argument instead of failing the page. Verified:
  without it, git exits 128 with `ambiguous argument`; with it, the walk proceeds on the refs that exist.
- **`--`,** so nothing after the revisions can be read as a pathspec. A branch and a directory can share a
  name.

**Both dates are carried, and the row shows the committer date.** `%at` and `%ct` cost nothing extra in the
same process. The row shows `%ct` — **not** the author date, which is what `git log` prints by default and
what most tools show. Rejected: the author date. The list is ordered by commit timestamp (`--date-order`), so
after a rebase the top of the list would carry author dates from months ago in no useful order, and a dated
list whose dates are not monotonic reads as a broken pane rather than as a rewritten history. Showing the axis
the list is actually sorted on is the only self-consistent choice. The tooltip shows both, named, when they
differ — which is also the only place the pane can explain the rebase. This matches the row read, which takes
`%(committerdate:unix)`, so one rule covers both surfaces.

**`%an` is left subject to `log.mailmap`,** which is on by default: the pane should show the name the user
sees when they run `git log` themselves. Rejected: `--no-mailmap` for determinism, which would make the pane
disagree with the terminal in every project that maintains a `.mailmap`.

**Which field yields width first.** D24's rule applies unchanged here, and in a history row the answer is the
**author name**. The subject and the date hold their width; the chips collapse under D45's own rule; the
author is dropped, and its absence tells the reader nothing false.

**Spawn count: 1 per page. Concurrency: at most one history read in flight at a time, in a single slot
outside the row-read pool,** because there is one pane and one selection, and the pane must not queue behind
a full board refresh — it is the thing the user is looking at.

### D41. Records are NUL-terminated, fields are `0x1F`, and the subject is last

A commit subject may contain a tab, a comma, a quote and a unit separator. A line-oriented or tab-separated
parse of `git log` is wrong on the first repository that has one.

- **Record terminator: NUL**, from `-z`. Verified: `git log -z --format=...` terminates every record with
  NUL, including the last. This is git's own answer to the problem, and it is the same mechanism
  `--raw -z` and `--numstat -z` use in D46, so there is one rule to remember rather than two.
- **Field separator: `%x1f`,** the ASCII unit separator.
- **The subject is the last field, and the split is bounded.** The parser splits each record into exactly
  seven parts, the seventh being the remainder of the record verbatim, so a `0x1F` inside a subject is part
  of the subject rather than a separator.

That last rule is not a precaution, it is a verified requirement.
`git commit -m "$(printf 'before\037after')"` produces a commit whose `%s` is `before<US>after`, and git emits
it unescaped. The claim "no editor emits `0x1F`" is a guess and it is false; the bounded split is a
structural property and it holds regardless.

The five fields before the author name are drawn from constrained alphabets: `%H` is hexadecimal, `%P` is
hexadecimal and spaces, `%at` and `%ct` are decimal digits, and `%D` holds ref names, which
`git check-ref-format` forbids from containing ASCII control characters at all. The only unconstrained field
before the subject is `%an`. A `0x1F` there shifts the split by one, so the tail of the author's name arrives
glued to the front of the subject — a cosmetic error in one row, never a desynchronised stream.

**`%s` cannot contain a newline,** verified: git folds a multi-line subject into one line joined with spaces
and stops at the first blank line. That is a reason the NUL terminator is cheap, not a reason to rely on
newlines — `%B` would break it, and the pane may want the body later.

**Resynchronisation.** A record whose first field is not a valid object id — the exact hex length the
repository uses, 40 or 64 — is discarded with a log line, and parsing continues at the next NUL. Even a
genuinely hostile record costs one row, never the pane. This is unit-tested against fabricated records
containing a tab, a `0x1F`, a NUL and an author name with a `0x1F` in it.

Rejected: newline records with tab fields, which is the shape every quick script uses. Verified broken: a
commit message written as `subject with<TAB>tab` round-trips through `%s` with the tab intact.

Rejected: NUL for both records and fields, read as a flat token stream. It is unambiguous only while the field
count is exact; one malformed record shifts every subsequent commit by one field, and the pane fills with
garbage that looks like data.

**Spawn count: 0.** Parsing is pure; `history/parse.ts` imports neither `vscode` nor `node:child_process`.

### D42. The rev set is HEAD plus the upstream ref, in `--date-order`

The upstream ref name is already known from the row read, so naming it costs no extra process.

Rejected: `HEAD` alone. The row says "behind 3", the user clicks the row to find out what those three are, and
commits the upstream has that HEAD does not are not in HEAD's history. The pane would be structurally unable
to answer the question the row raised.

Rejected: `--all`. A repository with many branches produces a first page consisting mostly of other people's
work in progress, so the commits the row is actually about scroll away. A mirror of a large upstream project
is the ordinary case that breaks it, not an exotic one.

Rejected: `--branches`, as a middle ground. Same failure, smaller: a repository where the user keeps twenty
local topic branches still buries HEAD's recent history.

**`--date-order` rather than the default.** The default walk is a commit-date-ordered queue with no topological
guarantee, so a commit with a skewed clock — a doctored date, a machine with the wrong time, a rewritten
history — can be emitted before its own child. D43's propagation would then mark the wrong commits, and the
later graph change would be asked to draw an edge going upward. `--date-order` guarantees no parent is emitted
before all of its children while otherwise keeping commit-timestamp order, which is exactly the invariant D43
needs and exactly the dated list the user asked for.

Rejected: `--topo-order`. It buys the same guarantee and then reorders commits arbitrarily far from date order
— the one thing a dated list must not do.

**Spawn count: 0 additional.** This decision is arguments to the process of D40.

### D43. Unpushed commits are marked from the parent list, at zero extra cost

The row says "ahead 3" and the pane is where the user goes to find out which three. So the pane marks them.

The rev set is HEAD plus the upstream ref, and `--date-order` guarantees that no parent is shown before all of
its children — git's documented wording for both `--date-order` and `--topo-order`. From that guarantee the
marking falls out with no second process:

1. Mark the upstream tip's hash as *on the upstream* when it is emitted.
2. When a commit marked *on the upstream* is emitted, mark every hash in its `%P` as *on the upstream* too.
3. A commit emitted **before** the upstream tip cannot be an ancestor of it — if it were, the guarantee would
   have emitted the tip first — so it is unpushed. A commit emitted after the tip is unpushed unless a child
   already marked it.

Verified against `git log HEAD --not <upstream>` on a clone with three local commits: the union walk in
`--date-order` emitted exactly those three ahead of the upstream tip, and the propagation reproduced the
reference set exactly.

**The marker state is carried across page boundaries, and without that the rule is wrong on page 2.**
Those three rules are sound within one walk, and D48 reads history one page per process with
`--skip`. Each page is a separate process and a separate parse, so a parser that starts each page
empty has, on page 2, never seen the upstream tip: every record is "after the tip" with no child in
that page to have marked it, and rule 3 marks **all of them** unpushed. That is a confident wrong
marker on every commit in a repository's history past the first page — precisely the class of
failure this design exists to prevent, arriving silently and only after a scroll.

So the marker state is per selection, not per page: the set of hashes established as *on the
upstream*, and the fact of whether the upstream tip has been emitted yet, persist across every page
of the selected repository and are **discarded with the selection** (D49) and whenever the pane
reloads from the first page under D48's `--skip` hazard rule — because a reload re-walks from the
top and a carried set from the abandoned sequence would describe a walk that no longer exists. D38
already knows this shape: a frontier carried across a page boundary is what lane layout needs too,
and this is the same carried state one feature earlier.

Rejected: re-deriving the marking for the whole retained list on every page, from all records held.
It gives the same answer and re-does the work each time, and the retained list is capped (D48) while
the carried state is two small collections that grow with the walk rather than with the render.

Rejected: a second `git log HEAD --not <upstream> --format=%H` to get the authoritative set. It is one more
process per page for a fact already implied by output the pane is parsing anyway, and spawn count is the
budget.

Rejected: taking the ahead count *N* from the row read and marking the first *N* rows. It is wrong the moment
HEAD's history contains a merge, because the first *N* rows of a date-ordered walk are not the *N* commits
reachable from HEAD but not from upstream.

**When nothing can be marked, nothing is marked.** No upstream configured, an upstream ref that
`--ignore-missing` dropped, or a detached HEAD: the pane draws no unpushed markers and says nothing about
them. It never renders "0 unpushed".

And the marking carries D18's freshness caveat unchanged: the upstream ref on disk is whatever the last fetch
left there, so the pane may say how long ago a fetch was *attempted*, only when `FETCH_HEAD` exists; it never
says the upstream is up to date; and when `FETCH_HEAD` is absent it says nothing about freshness rather than
implying currency. Marking three commits as unpushed without that caveat presents a stale answer as an
authoritative one.

**Spawn count: 0.**

### D44. `%P` is read and stored from day one, even though nothing renders it

The parent list is parsed into `Commit.parents` and kept in the model from the first version, although D38
removes the only feature that draws it.

Rejected: dropping `%P` from the format until lanes are built, which is the honest reading of "do not build
what you do not use". Two things go wrong. The parent list is not decoration — **it is what identifies an
unpushed commit (D43) and what identifies a merge (D46)**, both of which ship in v1, so removing it would cost
a second process for each. And the later graph change would then have to change the format string, the record
layout, the field count, the bounded-split arity, the parser's tests and every fixture that encodes a record —
a migration of the read layer to add a rendering feature. Carrying one hexadecimal field that costs nothing in
a process already being spawned is the cheaper side of that trade by a wide margin.

The commitment this makes concrete: **the later graph change adds a lane column and a pure layout module, and
touches nothing in `history/log.ts` or `history/parse.ts`.**

**Spawn count: 0.** `%P` rides in the page read of D40.

### D45. Ref chips come from `%D`, classified by full ref name, ordered by the question they answer

With `--decorate=full`, `%D` yields a list such as
`HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD`.

**The list is split on `", "` — comma followed by space — and that split is exact**, because
`git check-ref-format` forbids a space in a ref name. Rejected: splitting on a bare comma. A comma *is* legal
in a ref name, so a branch called `feature,wip` would be torn in half. The near-miss is recorded because the
obvious split is the broken one.

| Form | Chip |
|---|---|
| `HEAD -> refs/heads/x` | one chip, `HEAD → x` — not two chips, because they are one fact |
| `HEAD` alone | detached HEAD |
| `refs/heads/x` | local branch |
| `refs/remotes/<remote>/x` | remote branch, shown as `<remote>/x` |
| `refs/remotes/<remote>/HEAD` | suppressed |
| `tag: refs/tags/x` | tag |
| anything else | other ref, short name shown, full name in the tooltip |

`--decorate=short` is rejected precisely here, and D40 records the verified reason. `refs/remotes/origin/HEAD`
is suppressed because it is a symbolic ref duplicating whichever branch it points at — verified appearing on
the default branch tip of a fresh clone, alongside `refs/remotes/origin/main` — and it costs a chip slot for no
information. Anything unrecognised — `refs/notes/commits`, `refs/stash`, `refs/replace/*`, a Gerrit
`refs/changes/*`, a bisect ref — is shown as an *other ref*, never dropped: an unknown ref is still a fact about
that commit, and dropping it makes the pane disagree with the terminal.

**Order: HEAD, then local branches, then remote branches, then tags, then other refs; alphabetically within
each group.** That is the order the question is asked in — am I here, what of mine is here, does the server have
it, was it released — and it is deterministic. Rejected: `%D`'s own order. Git's decoration ordering is an
implementation detail of its decoration code and is not documented as stable, so a git upgrade would silently
reshuffle every chip strip in the pane.

**Overflow.** The chip strip has a maximum share of the row width. Chips are laid out in priority order and the
ones that do not fit collapse into a single `+N` chip listing the rest on hover and on focus. Two rules survive
any width: **the HEAD chip never collapses**, because the chip answering "am I here" is the one the reader is
scanning for; and **the subject is never sacrificed to make room for a chip.**

Rejected: wrapping chips onto a second line. It makes rows different heights, and uniform row height is what
lets D37's windowing address rows at a fixed offset; a variable-height list needs a measured-height cache
invalidated on every width change, including a continuous sidebar drag.

Rejected: showing chips only on the rows where they matter — HEAD, the upstream tip, tags. The pane cannot know
which ones matter, and a chip that appears conditionally trains the reader to distrust its absence.

**Spawn count: 0.** `%D` rides in the page read of D40.

### D46. Expanding a commit runs one `diff-tree`, and at most one commit is expanded

Selecting a commit expands, beneath it, the list of files that commit changed, with a status, a path and a churn
figure per file. This is what makes the click do something real without any of D39's machinery.

```
  git --no-optional-locks diff-tree -r -M --root --no-commit-id --raw --numstat -z <commit>
```

and, for a merge, the two-tree form against the chosen parent:

```
  git --no-optional-locks diff-tree -r -M --no-commit-id --raw --numstat -z <parent> <commit>
```

**`--raw` and `--numstat` together in one process is verified**, and the shape of the combined output matters:
git prints the entire raw section first, then the entire numstat section, all NUL-terminated in one stream. The
two are told apart without ambiguity because a raw record's first chunk begins with `:` and a numstat record's
first chunk begins with a digit or `-`; paths are consumed as part of the record that owns them, so the
question only ever arises at a record boundary.

- **`--raw`** gives the status letter and both modes. The status is what distinguishes an addition from a
  modification, and `--numstat` alone cannot: a modification that only adds lines and a newly added file both
  read as *deleted 0*.
- **`--numstat`** gives added and deleted line counts, and is the only one of the two that identifies a binary
  file.
- **`-z`,** because without it git C-quotes any path it considers unusual (`"src/a\tb.ts"`), and *when* it does
  that depends on `core.quotePath`, which differs per user. A parser that forgets to unquote shows the wrong
  path; a parser that unquotes on a machine where quoting is off corrupts a legal one. `-z` removes the
  question. Verified with a path containing a tab.
- **`-M` explicitly**, because `diff.renames` is configuration the extension cannot see. Verified: with
  `diff.renames=false` the same commit reports a delete plus an add; with `-M` on the command line it reports
  one `R089`. Two wrong rows where one right one belongs.
- **`--root`,** so a repository's first commit shows its files as additions. Without it `diff-tree` prints
  nothing for a root commit and the pane shows a commit with no changed files, which reads as a bug rather than
  as a root. Verified.
- **Copy detection (`-C`) is not passed.** Rejected because meaningful copy detection needs
  `--find-copies-harder`, which scans unmodified files and scales with the whole tree. A copy shown as an
  addition is a correct answer that is merely less informative.

**The four cases the list has to get right.**

- **A rename** is one row, `old → new`, not a delete and an add. With `-z` a rename record carries **two**
  NUL-terminated paths in *both* sections: raw emits `:100644 100644 <old> <new> R089` then `big.txt` then
  `moved.txt`; numstat emits `1\t0\t` then `big.txt` then `moved.txt`. A parser that always reads one path
  desynchronises on the first rename and misattributes every file after it. `history/rawdiff.ts` is pure and is
  tested against a fabricated stream containing a rename, a path with a space, a path with a tab, a mode-only
  change, a binary file and a deletion.
- **A binary file** reports `-` for both counts in numstat. The row says **binary** where a churn figure would
  be. It never says `+0 −0`, which reads as "nothing changed" about a file that changed entirely.
- **A mode-only change** appears as status `M` with **identical blob ids and differing modes**, and numstat
  `0 0`. Verified. The row says `mode 100644 → 100755`, again rather than `+0 −0`.
- **A commit that touched thousands of files** is bounded twice, and the two bounds mean different things. The
  runner's 32 MiB cap is a memory guard: when it fires, `runGit` reports `truncated`, and a truncated read is
  rendered as a **stated failure of that expansion** — "the file list was truncated" with the exact command to
  run — never as a complete list. Separately, the pane renders at most a bounded number of rows with a
  `+N more` line, where *N* is counted from records actually parsed. When the read was truncated, no total is
  shown at all.
- **A commit that changed nothing** — an empty commit — produces zero records from a successful process.
  Verified. That is a fact and the pane states it: "this commit changed no files". Zero records from a *failed*
  or *truncated* process is not the same thing and does not render the same way.

**Merges.** `git diff-tree` prints nothing at all for a merge when no parent is given — verified. Rejected:
`--cc` or `-c`. The combined raw format carries N source ids against one destination, which cannot be reduced
to a per-file before-and-after, and it hides files that match one parent, so the list would silently omit
changes. Rejected: hiding the file list for merges — in a repository that does not squash, most commits are
merges, so most of the pane would be dead rows. So a merge's file list is computed against **one parent,
defaulting to the first**, the other parents are selectable, and **the pane states which parent the list is
against**. An unqualified "files changed" for a merge is meaningless, and showing one without saying against
what is misleading rather than merely terse. The parent list comes from `%P` (D44), so identifying a merge costs
no process.

**At most one commit is expanded at a time.** Selecting another commit collapses the first. This is not a UI
preference; it is what keeps D37's windowing tractable — N fixed-height rows plus at most one variable-height
block — and it caps the pane's diff spawns at one in flight, matching D40's one-slot rule. Rejected: multiple
simultaneous expansions, which is what a tree would give free. It makes row offsets a function of every expanded
block above, which needs a measured-height cache invalidated on every width change, including a continuous
sidebar drag.

**Spawn count: 1 per expansion, 1 more each time the user picks a different parent of a merge. Collapsing costs
0. Re-expanding the same commit costs 0** — the parsed list is held for as long as that commit is on screen,
because a commit's file list is immutable.

### D47. Clicking a file opens the working copy, and says that is what it is doing

With the diff deferred (D39), the click still has to lead somewhere. It does three things, in order of how often
they are the right answer.

**Primary: open the file's current working-tree copy** in an editor tab, via `vscode.open` on a `file:` URI
built from the repository's working-tree root and the file's repository-relative path. This works for a
repository the editor has never opened — `vscode.open` takes any file URI — which is precisely the set that
`git:` refused in D39.

**The pane says what it is doing, once.** A caption on the expanded list, not a nag on each row, reads: *opens
the file as it is now, not as it was in this commit*. This is the honest framing and it is a small statement
rather than an apology, because for the ordinary case — a commit from this morning, a file the user is about to
go and change — the current copy is what they wanted anyway.

**When the primary action cannot apply, it is disabled with the reason on the row, not silently inert.** A
deleted file has no working copy. A renamed file offers the new path, not the old. A commit old enough that the
path has since been deleted or moved has none. A **bare repository has no working tree at all**, so the whole
action is unavailable for every row and the pane says so once rather than thirteen times.

**Secondary, on the row's context menu, always available:** copy the repository-relative path; reveal the file
in the Explorer; and **run `git show <full hash> -- <path>` in a terminal opened at the repository**. That last
one is the honest substitute for the diff: it is the same hand-off pattern the repository row actions use, it
costs this extension nothing, and it gives the exact answer the diff would have given to a user who wants it
badly enough to read a terminal.

Rejected: making the click do nothing. A list of file names that cannot be acted on is a list nobody clicks
twice, and it would make the expansion — the one thing the pane's selection does — pointless.

Rejected: opening the file at the revision through a `TextDocumentContentProvider`, as a read-only tab rather
than a diff. It is the same EOL-normalising API rejected in D39, and a file shown with its line endings quietly
rewritten is a wrong answer that looks right.

Rejected: filtering the pane to that file's history, as a `git log -- <path>`. It is a genuinely good feature and
it is a different one: it needs its own rev set, its own paging, its own way back, and `--follow` to survive the
rename this list has just shown. It belongs in a later change.

**When D39's provider lands**, the primary action becomes `vscode.diff` and this action moves to the context
menu. It is not removed: "open the file as it is now" is the right action often enough to keep.

**Spawn count: 0.** Opening a file is a `vscode.open`; the terminal hand-off runs git in the terminal, not in
the extension host.

### D48. Paging is `--max-count` and `--skip`, sized from the pane and never from a machine

History is unbounded, so the pane reads a page at a time.

**The first page is derived from the pane's own geometry**: the number of fixed-height rows that fit the pane,
times an overscroll factor, so one flick of the wheel does not stall. Row height and pane height come from the
webview and change when the user drags the sidebar or the pane divider. Subsequent pages are smaller, because by
then the user is scrolling deliberately rather than landing on a view. The overscroll factor is a property of
scrolling behaviour, not of a machine; **nothing here is a stopwatch reading from any box.**

**`multirepoLedger.history.pageSize` overrides it, with `0` meaning "derive from the pane".** A floor and a ceiling
bound the derived value, and both are guards rather than tuning: the floor stops a pane collapsed to a sliver
from spawning a process to fetch two commits, and the ceiling stops a pane dragged to the full height of an
unknown display from asking for a page whose size nobody chose.

**More is asked for two ways.** A sentinel element at the bottom of the list, observed with
`IntersectionObserver`, requests the next page as it comes into view; and an explicit **Load more** control is
rendered at the end. The button is not redundant: the observer does not fire in a pane that is collapsed or
scrolled programmatically, and the button is the keyboard-reachable path, which a webview must supply for itself
(D37).

**`--skip` has one correctness hazard and it is handled.** If a commit lands between page 1 and page 2 — a
fetch, a commit made in a terminal, a rebase — the offset shifts, and page 2 can repeat or omit a commit. So the
pane keeps the set of hashes already shown; a fetched page containing one of them means history moved
underneath, and the pane **reloads from the first page rather than appending**. Silent duplication in a commit
list is a bug nobody reports and everybody quietly distrusts.

Rejected: holding an open `git log` process per selected repository and reading incrementally. It leaves a child
alive across every selection change, and that child must then either survive the change — leaking one per
repository the user visits — or be killed and restarted, which costs exactly what re-running costs, with a leaked
process as the failure mode instead of a clean one.

Rejected: resuming from the last commit's hash instead of `--skip`. With two revisions in the walk (D42) the
resume point is a frontier, not a hash, and cannot be expressed on the command line. `--skip` re-walks the
earlier commits, which is real work git does again — but process count is the lever this design pulls, and
re-walking inside a process that was going to be spawned anyway does not move it.

**Retained commits are capped by `multirepoLedger.history.maxRetainedCommits`**, as a memory guard against
someone holding page-down through a decade of history. On reaching the cap the pane states that it is showing
the most recent N and stops offering more; it never simply stops responding. It is a guard, not a performance
knob — lowering it hides history, it does not make anything faster — and its description in the manifest says
that rather than describing a speed. The setting is named here because three other documents referred to it
only by its function and so had nothing to declare.

**A truncated page is not the end of history.** `runGit` reports `truncated` when output passes its byte cap, and
the pane surfaces that as a stated failure of that page, with the command. Treating a truncated read as a
complete one would show a root commit where there is none.

**Pages already fetched for a previous repository are dropped, not cached.** Rejected: a per-repository page
cache so switching back is instant. It is stale the moment a commit lands, a pane showing commits a rebase has
already rewritten is worse than a pane that takes a moment, and its memory is unbounded across a watched
directory of unknown size. What is remembered is the selection and the scroll offset.

**Spawn count: 1 per page.**

### D49. A superseded history read is cancelled, and the pane clears before the new answer arrives

Every history read carries the generation of the selection that asked for it. Selecting a different repository
increments the generation, and three things happen in this order:

1. **The pane clears to a loading state naming the newly selected repository, immediately** — before any process
   starts and without waiting for anything. This ordering is the whole point. The worst available failure is the
   previous repository's commits sitting under the new repository's name, and it is the failure that arrives free
   if the pane waits for data before repainting.
2. **The in-flight child is killed** with `ChildProcess.kill`. `git log` and `git diff-tree` are single processes
   with no children of their own, so the Windows caveat about `kill` not reaching a process tree does not apply.
3. **Output from a superseded generation is discarded on arrival, whether or not the kill succeeded.** The
   generation check is the correctness mechanism; the kill is only an economy. A read that has already written its
   bytes into the pipe cannot be un-sent, and a kill can fail for reasons the extension does not control.

An in-flight `diff-tree` for an expanded commit is cancelled the same way, by the same generation, since a commit
belongs to a repository.

Rejected: leaving the previous repository's rows on screen until the new page arrives, so the pane never flickers.
That is exactly the failure in point 1, and it is worse than a flicker because it is silent and plausible.

Rejected: cancelling the board's row reads at the same time. They answer a different question and the user did not
stop asking it (D16).

The remaining transitions, stated so the rules do not read as contradictory:

- **Hiding and revealing the pane re-reads nothing.** The fetched pages live in the extension host and the webview
  re-hydrates from them on `onDidChangeVisibility`.
- **Reloading the window** restores the selection from `workspaceState` and re-reads the first page, because
  history may have moved while the window was closed.
- **Re-selecting the same repository is a no-op**, unless the pane is in an error state, in which case it retries.
- **The selected repository disappearing** — excluded, deleted, or gone on a rescan — clears the pane to a state
  that names why.
- **A refresh of the board does not disturb the pane.** The row read and the history read are in separate
  concurrency slots (D40), and a re-read producing the same repository at the same path leaves the selection, the
  fetched pages and the scroll offset alone.

**Spawn count: 0 for the cancellation itself.** The new selection's first page is D40's 1 process.

### D50. Every degenerate repository has a stated pane, and most of them cost no process at all

The pane never renders a blank box. Every one of these is decided from facts the row read and the filesystem walk
already hold, so in most cases the pane knows the answer before it would have spawned anything.

| Repository | What the pane does | Spawn count |
|---|---|---|
| One commit | Nothing special. The page is one row; `--root` (D46) makes its file list render as additions rather than as nothing. | 1 page, 1 on expand |
| No commits (unborn HEAD) | States *no commits yet*, with the repository name. **The `git log` is never spawned.** | **0** |
| Bare | Reads normally — verified: `git log HEAD` works in a bare clone and decorations are present. The pane notes it is bare, and D47's primary action is unavailable for every row with that reason given once. | 1 page |
| Bare and empty | *No commits yet*, as above. | **0** |
| Mid-rebase | Reads normally, and carries the banner D37 exists for. | 1 page |
| Detached HEAD | Reads normally. `%D` yields the bare token `HEAD` — verified — which D45 renders as a detached-HEAD chip. No upstream, so D43 marks nothing. | 1 page |
| Shallow | Reads normally. The oldest commit in a shallow clone has no parents in `%P` and is not a root; the pane says the history is shallow rather than drawing a root that is not one. | 1 page |
| No upstream | Reads `HEAD` alone. No unpushed marking, and no statement about it. | 1 page |
| Unreadable | The row already says why. The pane repeats that reason and the path, and does not spawn a read that is going to fail the same way. | **0** |
| No git on `PATH` | The board is already in that state; the pane states it once and offers the log. | **0** |

**Why no-commits costs zero processes.** Verified: `git log HEAD` in a repository with an unborn HEAD exits
**128** with `fatal: ambiguous argument 'HEAD'`. Run blindly, that lands in the same error path as a genuinely
broken repository, and the pane would tell a user with a freshly `git init`-ed directory that their repository
could not be read. The row read already knows HEAD is unborn, so the pane decides from that and spawns nothing.
Rejected: spawning it and special-casing the error text, which makes the pane's correctness depend on an error
string that is neither documented nor stable across locales.

The mid-operation banner reads its branch name from `.git/rebase-merge/head-name`, and D17's caveat applies
unchanged: those marker files are not in `gitrepository-layout`, so **their absence degrades silently** — the pane
drops the banner and shows the detached-HEAD chip, which is true either way. It never guesses. The same rule
covers `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `BISECT_START`: read if present, stated if read, silent
if absent.

### D51. Five hand-offs from a row, reachable two ways, decided in one pure module

A click that leads nowhere makes the board an ornament. Every row offers:

- **Open Folder in New Window** — `vscode.openFolder` with `forceNewWindow: true`. Rejected: replacing the current
  folder, which closes whatever the reader is doing and takes the board with it, in an extension whose premise is
  repositories they are *not* working in. Not offered on a bare repository, whose "folder" is a directory of git
  internals.
- **Show in Source Control** — D52.
- **Open in Terminal** — `vscode.window.createTerminal({ name, cwd })`, then `show()`. Rejected:
  `sendText('cd …')` into an existing terminal, which assumes a shell — the string differs across PowerShell, cmd,
  fish and nushell — and assumes a clean prompt. `cwd` is the API that already knows. Rejected: reusing a terminal
  whose shell-integration cwd matches, since shell integration may be off and a wrong match sends the user's next
  command somewhere unexpected.
- **Copy Path** — `env.clipboard.writeText`, native separators, because the destination is a shell on this
  machine. The worktree path, or the git directory for a bare repository.
- **Open Remote in Browser** — D53.

Two additional actions appear only on rows in a failure state: **Retry** on a row that timed out, and **Copy the
`safe.directory` command** on a row git refused (D19).

Reachable by right-click through a `webview/context` menu contribution with `data-vscode-context` on each row, and
by keyboard from the focused row via the menu key, which opens the same list as a quick pick. The context-menu
mechanism is to be confirmed against the declared engine floor before the row markup depends on it; the quick pick
works without it and is the fallback, and because both routes render the same list from `actionsFor(row)`, which
one ships is a rendering detail rather than a design one.

One inline action — Open Folder in New Window — appears on hover, in the sibling's revealed-on-hover pattern, so a
list of thirty rows is not a wall of buttons. It is a mouse affordance only and is not in the tab order: an ARIA
`option` may not contain a focusable child, and everything the button does is in the menu.

`actionsFor(row)` is pure and unit-tested, and it decides *absence* as much as presence: no Open Folder on a bare
repository, no Open Remote when no remote can be named, no Show in Source Control when the git extension is
missing. Rejected: offering every action always and failing at the click. An action that is offered and then fails
is worse than one that was never offered, because the reader has to work out which of the two things broke.

**Spawn count: 0, except Open Remote in Browser, which is D53's 1 process at click time.**

### D52. Adding the repository to Source Control is acceptable as a labelled action, and unacceptable as a side effect

The built-in git extension exports `getAPI(1).openRepository(path)`. Calling it adds that repository to the user's
Source Control view for the rest of the session: it becomes a source-control provider, its files gain decorations,
and the git extension begins watching it.

That is a real change to the user's window, so it happens only when the user asks for it by name, and the name tells
the truth. The extension first checks `api.repositories` for the path. If it is already open, the action is labelled
**Reveal in Source Control** and only focuses `workbench.view.scm`. If it is not, the action is labelled **Show in
Source Control** and its tooltip says it adds the repository to the Source Control view for this window.

Rejected, and this is the decision that matters: calling `openRepository` behind the user's back for every
discovered repository so that `git:` URIs resolve and native diffs work. `git:` URIs resolve only for repositories
the git extension has open, which is exactly the set this extension exists to look outside of — so the temptation is
structural, not incidental. Taking it would silently fill a user's Source Control view with dozens of repositories
they never opened, change what every SCM command acts on, and start a file watcher per repository, all to make a
feature work that v1 has already deferred for other reasons (D39).

Rejected: the internal `git.openRepository` command. It is not contributed API, its signature is free to change, and
a hand-off that breaks on a VS Code update is worse than one that was scoped to the exported API.

If the git extension is absent or disabled, the action is not offered.

**Spawn count: 0.**

### D53. The remote URL is read twice by two different mechanisms, and each is right for its caller

Two drafts of this document disagreed about how to read a remote URL. Both were right about their own caller, and
the resolution is that there are two callers with different requirements.

**For opening a browser — exact, at click time, one process.**

```
  git -C <path> config --get remote.<name>.url
```

Rejected for this caller: reading `.git/config` from the filesystem. It is free, and it is wrong in precisely the
configurations that need it: `include` and `includeIf` directives put the URL in another file, and
`url.<base>.insteadOf` rewrites it. `git config` resolves both. This is a user-initiated action, so it can afford a
process; the board cannot afford one per row for a fact used on a click.

Which remote: the one HEAD's upstream names, taken from the `origin/main` form already in the row model. Failing
that, `origin` if it exists; failing that, the sole remote if there is exactly one; otherwise the action is not
offered rather than guessing.

**Four shapes produce a URL and nothing else does:** `https://host/owner/repo(.git)`, `http://…`, the scp-like
`git@host:owner/repo.git`, and `ssh://git@host[:port]/owner/repo.git`. All become `https://host/owner/repo`.
Anything else — `file://`, a bare local path, a helper transport, `ext::` — is not opened, and the row says the
remote is not one that can be opened in a browser. This allowlist is a security boundary, not tidiness:
`env.openExternal` will hand a URI to whatever handler the operating system has registered for its scheme, so
passing a remote string through unexamined turns a cloned repository's config into a launcher. Userinfo is stripped
before opening for a second reason: `https://user:token@host/…` is a real and common remote form, and opening it
puts a credential into the browser's history and its address bar.

**For grouping repositories into forge queries — a hint, from the filesystem, at zero process cost.** The forge
layer needs a host and an owner for every repository in order to plan its batched queries (D56), and spending one
process per repository on a feature that is off by default would double the board's budget. So `forge/plan.ts`
parses `.git/config` directly, and **the parse is a hint, not an authority** — stated here rather than discovered
later. Because of `include`, `includeIf` and `insteadOf`, the URL it yields can differ from the one git would use.
The consequence is bounded by construction: a repository grouped under the wrong owner, or under none, ends up in a
query that does not cover it and therefore reports `unknown` (D57). It cannot end up with somebody else's count,
because of D59's keying.

The parse itself is one pure module, `model/remoteUrl.ts` — the most heavily tested module outside the parsers —
shared by `view/handoffs.ts` and `forge/plan.ts`. It lives in `model/` and not in `forge/` because `view` may import
only `model` (D1).

**Spawn count: 1 per click on Open Remote in Browser. 0 for the forge layer's grouping.**

### D54. No batch operation ever runs across repositories

There is no Fetch All, no Pull All, no Prune All, and there will not be one.

Rejected: a fetch-all button, which every neighbouring tool has and which is the single most requested thing a board
like this attracts. Three things go wrong. It **writes**: fetch updates remote-tracking refs and takes locks under
`.git`, so it can race a git command the user is running in a terminal in the same repository, and a status board
that interferes with the work it is reporting on has stopped being a status board. It **touches the network for
every repository at once**, on a connection nobody here has seen, which is D56's rate-limit objection with the
volume turned up. And it is **how the read-only boundary erodes**: once one button writes, the argument against
Pull All is only taste, and the argument after that is about checkout.

The honest replacement is the hand-off, which costs the user one click: open the repository in a terminal, in a new
window, or in Source Control, where the tools that already do this live, where the output is visible, and where the
user is the one who typed it.

This is also why divergence freshness is a displayed fact rather than a problem to be solved (D18). The row can be
behind because nothing has fetched; the answer to that is to say so, not to fetch.

**Spawn count: 0, by construction.**

### D55. The forge layer is an overlay that ships off, and can be deleted

`multirepoLedger.forge.enabled` defaults to `false`, and while it is false neither `gh` nor `glab` is invoked, no
detection runs, and nothing leaves the machine. That is already in the manifest and this decision is what it means:
everything else the Ledger does is a local read, and an extension that starts making network calls on its own
behalf, on a machine and a connection its author cannot see, has made a decision that was not its to make.

The layer is an **overlay**, not a field. The forge result is a map keyed by `(host, owner, project)` and joined onto
the model in the controller; `read/` neither knows nor imports it (D1). Three things follow. A forge failure cannot
alter a local fact — a repository whose PR count is unknown still shows its last commit, its divergence and its HEAD
state, unchanged. The board is useful before the network answers and remains useful if it never does. And `forge/`
can be deleted wholesale and the extension still builds, which is the test of whether the boundary is real.

Rejected: making the review count a property of the repository read, filled in by the same pass. It reads more
simply and it couples a local answer to a network answer, so that a rate limit or an expired credential delays or
empties rows whose local facts were on disk the whole time.

Caching is **in memory only**, per window, keyed by `(host, owner)` with the time it was fetched. Rejected:
persisting the counts to `globalStorageUri` so they survive a reload. That would write the names of the user's
private repositories, and how many reviews are open on them, into a file on disk that the user never asked for, in
order to save one query per owner per window. One query per owner is well inside the budget; the file is not worth
it.

**Spawn count: 0 while the setting is off.**

### D56. Batching by owner is not an optimisation; the per-repository version does not work at all

```
  gh search prs --owner <owner> --state open --limit <n> \
     --json repository,number,title,url,isDraft,updatedAt

  glab mr list --group <group> --state opened --per-page <n> --output json
```

One query per distinct owner, not one per repository.

Rejected: `gh pr list --repo <owner>/<name>` per repository, which is the obvious implementation and the one every
example on the internet shows. GitHub allows **30 search requests per minute**. A directory of forty repositories
exceeds that in the first pass. What the user sees is not an error: it is a board where the first twenty-odd rows
carry counts and the rest carry nothing, with no explanation, which reads exactly like a bug in this extension.
Worse, it is a bug that appears only on directories large enough to be the reason somebody installed it. Batching
turns the query count into a function of how many *owners* a directory spans, which is a small number even when the
repository count is not.

Two consequences that are part of the same decision, because getting them wrong reintroduces the problem in a
quieter form:

**The limit must be raised and then checked.** `gh search prs` defaults to `--limit 30` — thirty *results*, not
thirty repositories. Left at the default, an owner with thirty-one open pull requests silently loses some, and the
repositories that lost them render a *smaller count*, which is a lie rather than a gap. So the limit is set
explicitly, and **when the number of returned rows equals the limit the answer is treated as truncated and every
repository in that namespace reports silence, not a count.** The same rule applies to `glab`'s paging. A lower bound
rendered as a count is the exact failure this extension is being built to avoid.

**The truncation test compares against two limits, not one, because the CLI has a ceiling of its own.** Testing only
"returned rows equals the limit *we asked for*" fails in the one direction that matters: if `gh search` or the search
endpoint applies a maximum below the requested limit, the returned count never equals the request, truncation is
never detected, and every repository in the namespace shows a number that is short — arriving only for the largest
owners, which are the ones with the most to lose. So the answer is treated as truncated when the returned row count
equals the requested limit **or** any limit the CLI reports applying, the requested limit is written to the log beside
the returned count so a short answer is diagnosable from the log alone, and **what the CLI's own ceiling actually is
is a task to establish before a limit is chosen**, not a number to pick and hope about.

**Queries are serialised, not fired in parallel.** They go through one queue that issues them in order. If the CLI
reports a rate limit anyway, the owners not yet answered report silence with that as the stated reason, and nothing
is retried automatically — the next attempt is the user's next explicit Refresh. Rejected: an automatic retry, which
is how an extension turns one throttled minute into a throttled hour.

Whether `gh search prs --owner` accepts several owners in one invocation is **unverified**: the flag is typed
`--owner strings`, so it is a list flag, but whether the underlying search ORs them has not been checked against a
live host and is not being guessed. Until it is checked the implementation issues one query per owner, which is
already inside the budget. That check is a task, not an assumption.

**Spawn count: 1 per distinct owner per refresh, serialised, only while the setting is on.**

### D57. A count is a fact or it is silence, and the type makes zero unrepresentable

```
  type ForgeCount =
    | { kind: 'off' }
    | { kind: 'pending' }
    | { kind: 'known'; open: number }
    | { kind: 'unknown'; reason: ForgeUnknownReason };
```

| State | Row | When |
|---|---|---|
| `off` | nothing at all | The setting is off. No placeholder, no dash, no hole where a feature would go. |
| `pending` | `PR …` / `MR …`, dimmed | A batched query for this owner is in flight. |
| `known` | `3 PR`, and `0 PR` | The query succeeded and returned this many for this repository. **Zero is shown only here.** |
| `unknown` | a dimmed reason: `gh not installed`, `not signed in`, `github.example.com not signed in`, `rate limited`, `answer truncated`, `no remote` | Everything else. |

Rejected: `open: number | undefined`, with the renderer taught to treat `undefined` as "don't show". It is the same
information and it survives exactly as long as the first person who writes `count ?? 0` in a sort comparator, at
which point every repository the extension could not ask about sorts as though it had no reviews open — and sorts
silently, because nothing on screen distinguishes a real zero from an absent one. With the union, that line does not
compile.

The reason travels with the state so the tooltip and the log can name it, and so the header can say *"4 repositories
could not be asked"* rather than folding them into a zero. The project's rule that a count nobody established never
renders as zero is enforced here, once, in the type, rather than in each of the places that render or order a row.

**Spawn count: 0.**

### D58. GitHub and GitLab answer different questions at different prices, and the row says so

GitHub's own organisation board carries a pull-request count per repository; GitLab's project-list API carries no
merge-request count at all. The two forges do not expose the same shape of answer, and pretending otherwise is where
this extension is most likely to lie.

On the GitHub side there is a search that answers "open pull requests across this owner" in one request, and
`gh search prs --owner` exposes it directly. The result rows each name their `repository`, so per-repository counts
fall out of one query, and a repository that appears in no row is reported as having none.

**That last step rests on a coverage assumption, and the assumption is unverified.** Reading "named in no row" as
"has none" is only sound if the query saw every repository on the board that belongs to that owner. GitHub search
returns what the authenticated credential can see, and the research established the rate limit and nothing about
coverage. If a `gh` token lacks the scope to read a private repository the board has a row for, that repository is
named in no row for a second reason entirely, and the established zero this decision grants becomes a confidently
wrong number — on exactly the work repositories a user most wants counted, and produced silently, which is the one
failure D57 spends a whole type preventing. The assumption is therefore recorded as an assumption here, in the Risks
section, and as a task to check against a real host and a deliberately under-scoped credential before the layer
ships. Rejected: restricting the established zero to repositories the result set names, which sounds like the safe
reading and is incoherent — a repository named in the result set has at least one open request, so under that rule
`0` could never render at all and D57's third state would be dead. Rejected: shipping the zero on the assumption
unstated, which is how a silent wrong number gets built on purpose.

On the GitLab side the equivalent is a group-scoped **listing**, not a count. Three differences follow, each with a
stated consequence:

- **It pages.** A listing that hits its page limit yields lower bounds. Handled by D56: at the limit, the whole
  namespace reports `answer truncated` rather than a number.
- **It is scoped to a group.** A project in a personal namespace, and a project sitting outside any group, are not
  covered by a group query at all. Those rows report `unknown` with the reason, and the log names what would have
  answered. They do not report zero, and they do not silently fall back to a per-project query, because that is the
  pattern D56 refuses.
- **The exact flag spelling has not been verified against a real `glab`,** which is not installed on the machine
  this was written on and is not going to be guessed at. The adapter is therefore built so that any non-zero exit,
  any unparseable output and any unrecognised flag resolves to `unknown` with the exit code logged. That is not only
  how a wrong guess fails safely today; it is how a `glab` flag renamed in a future release fails safely in two
  years, which matters more.

Rejected: a uniform interface that hides the asymmetry. `forge/github.ts` and `forge/gitlab.ts` implement the same
narrow contract — given a set of repositories, return a `ForgeCount` for each — but they are allowed to return
`unknown` for different reasons, and `forge/plan.ts` is allowed to know that a GitLab namespace may need a different
grouping key from a GitHub one. A shared abstraction that forced them to look alike would have to invent an answer
on the side that does not have one.

**Spawn count: as D56.**

### D59. The remote decides the adapter, per repository, and the key is `(host, owner)`

The forge is decided per repository, from that repository's own remote URL (D53), and never once for the directory.
A directory may hold personal repositories on `github.com`, work repositories on `gitlab.company.example`, a mirror
with no remote at all, and a fork whose `origin` and `upstream` point at different hosts. Nothing in this extension
may assume one account, one host or one identity.

**The cache key is `(host, owner)`, never `owner` alone, and a query's results are applied only to repositories
whose host matches the host the query ran against.** An answer from `github.com` never populates a row pointing at
`github.example.com`; a `gh` answer never populates a GitLab row. This one invariant is what stops the most plausible
wrong number this extension could produce: a user signed in to `github.com`, with a work repository at an enterprise
host that happens to share an organisation name.

Rejected: keying by owner alone, which is simpler and is the shape the CLIs' own flags suggest. It produces a
confidently wrong count rather than a visible failure, which is the one class of bug this design spends most of its
effort avoiding.

`gh search` exposes no host flag, so a query against a host other than `github.com` runs with `GH_HOST=<host>` in the
child's environment. If `gh` holds no credentials for that host the query fails, and those rows report
`not signed in` naming the host.

When a repository has no remote, or a remote whose host matches no adapter — a self-hosted Gitea, a bare mirror, an
internal Git server — the forge layer reports nothing for it and the **local-only fallback** carries the row:
branches with no upstream, and ahead/behind against whatever upstream exists. That fallback is not a forge state; it
is the ordinary row, and it is what every row looks like when the layer is off.

**Spawn count: 0.**

### D60. Detection is one probe; the query is the authority

Presence is detected once per session, per CLI, and the detection is the first spawn failing with `ENOENT`. It is
cached for the window, so a directory of forty repositories discovers that `glab` is missing once rather than forty
times.

Authentication is **not** probed. The batched query is the probe: it either succeeds, or it fails and the failure is
classified from the exit code and stderr into `not installed`, `not signed in`, `rate limited` or `unknown`, and the
row shows that.

Rejected: gating each query behind `gh auth status`. Three things go wrong, and the first is the one nobody expects.
**`gh auth status` tests the credential against the host** — its own help text says the authentication state of each
account "is tested" — so it is itself a network round trip, which doubles the outbound calls and would have to be
enumerated in D65 alongside the queries it was supposed to protect. Second, it introduces a second failure mode that
contradicts the first: auth status can pass for a host the query never touches, or fail for a host irrelevant to this
directory, and now the extension is refusing to ask a question it could have answered. Third, and most quietly,
**`gh auth status --json` exits zero regardless of any authentication issue** — stated in its own help text — so an
implementation reaching for the machine-readable form to find out *which* host is signed in loses the exit code that
was the whole signal, and reads success out of a failure. Skipping the probe removes all three.

Nothing the extension spawns is ever interactive. Children are spawned with piped stdio and no TTY, so a CLI that
wanted to prompt for a credential cannot; it fails, and the failure becomes `not signed in`. `gh auth login`,
`glab auth login` and every other command that would start a flow are outside the closed set of commands this
extension is permitted to run.

**Spawn count: 0 extra. The detection is the first query, already counted in D56.**

### D61. No token is ever asked for, read, stored or logged

The extension holds no credential of any kind. It does not offer a setting for a personal access token, does not read
`GH_TOKEN`, `GITHUB_TOKEN` or `GITLAB_TOKEN`, does not pass `--show-token`, does not write anything to
`SecretStorage`, and never puts a token in the log. Whatever authentication happens is authentication the user
already established with `gh` or `glab` in their own shell, on their own terms, and it stays inside those tools.

Rejected: an API token setting, which `CLAUDE.md` records as already rejected with the user and which is re-stated
here because it is the thing every review of this feature will suggest. It would work on more machines — no CLI to
install — and in exchange this extension becomes a place a credential lives. It would then need a secure store, a
rotation story, a redaction rule for every log line, and an answer to what happens when the token has more scope than
the feature needs. Delegating to a CLI the user already trusts costs one dependency and removes that entire class of
obligation.

The child inherits the ambient environment, because a CLI that cannot see its own configuration cannot work.
Inheriting is not reading: the extension neither inspects that environment nor writes any part of it anywhere, and
the only variable it ever *sets* for a forge child is `GH_HOST`, which is a hostname.

**Spawn count: 0.**

### D62. Forge queries never ride a watcher event, and never a timer

A forge query is issued when the layer is enabled and the list is first populated, when the user presses Refresh, and
when `multirepoLedger.forge.enabled` is switched on. Nowhere else.

Rejected: refreshing review state on the same watcher pass as everything else, so the row is always current. A local
commit is a burst of file events and says nothing whatever about what is open in review; wiring the two together
means a user working normally in a terminal generates network traffic proportional to how hard they are working,
against a search endpoint with a per-minute limit, and gets rate-limited by their own productivity.

Rejected: a background poll every few minutes. It is a network call the user did not ask for, cannot see, and did not
schedule, made by an extension whose entire other half is a local read. The staleness it removes is small — review
state changes on somebody else's schedule, in minutes and hours — and the cost is that the extension is doing
something on the network at a moment the user is not looking at it. When the count is old, the tooltip says when it
was fetched, which is the honest answer and costs nothing.

**Spawn count: 0 beyond D56's queries at the three stated moments.**

### D63. Activation registers and returns; the budget is a count, and the count is zero

`activate(context)` creates the output channel, installs the log sink, registers the three commands, sets the
`multirepoLedger.state` context key from `workspaceFolders` and the in-memory value of `multirepoLedger.additionalRoots`,
registers the two view providers, constructs the controller, schedules `controller.start()` with
`setTimeout(..., 0)`, and returns. It is declared `: void`, not `async`, so there is nothing for the extension host
to await even if somebody later adds a promise to it. No module in the import graph of `extension.ts` performs I/O at
module scope, because module evaluation is on the activation path too.

**The budget is expressed as a count, not a duration: zero awaited operations, zero spawned processes, zero files
read, zero settings reads that touch disk, while VS Code holds the activation path open.** Rejected: a millisecond
figure. It would be a number from one machine and it would also be the wrong instrument — an activation that reads
nothing is fast on hardware nobody here has seen, and one that reads a directory is slow on hardware somebody does. A
count is checkable by reading twenty lines and does not need a stopwatch to stay true.

After `activate` returns, `controller.start()` runs in this order, and the order is the decision:

1. Resolve roots from the workspace folders and `multirepoLedger.additionalRoots`, deduplicated, with a non-existent path
   logged once and skipped.
2. Probe once for the session that `git` exists, with `git --version`, as the sibling does. **The
   `--include-root-refs` capability is not probed here** — `for-each-ref` cannot run outside a repository, so there is
   nowhere to probe it that is not already a repository read (D12).
3. Walk, and query the editor index, together and cancellably.
4. **Render every discovered repository immediately, in its pending state, before any git process has answered.** The
   list is populated by discovery, not by the read. This is what makes a directory of two hundred repositories feel
   answered rather than absent.
5. Schedule the tier-one row reads at the derived concurrency (D15), patching each row as it lands.
6. Fill dirty state for visible rows only, second-tier and opt-in (D14).
7. Install watchers — after the first pass, so the first pass is not competing with its own events.
8. Only if `multirepoLedger.forge.enabled`, plan and issue the batched forge queries (D56).

`onStartupFinished` is the activation event and is already in the manifest. Rejected: `onView:` on the container,
which would mean the first glance at the board is always a loading state — and the first glance is the entire
product. Rejected: `*`, which activates before the window has finished starting and puts this extension's walk in
contention with the editor's own start-up for the same disk, on machines where that disk is a network mount.

**Spawn count on the activation path: 0. The `git --version` probe is 1 per session, after `activate` returns.**

### D64. Watching watches the git directory, never the working tree

VS Code's own API documentation makes the choice: *"file events from recursive file watchers may be excluded based on
user configuration… it is highly recommended to watch with simple patterns that do not require recursive watchers
where the exclude settings are ignored and you have full control over the events."* A recursive pattern is silently
subject to `files.watcherExclude`, whose default already excludes `**/.git/objects/**`, and which a great many people
have set to `**/.git/**`. A watcher that a user's own unrelated setting quietly disables is worse than no watcher,
because nothing anywhere says the board stopped updating.

So: two **non-recursive** watchers per repository, meaning two patterns containing neither `/` nor `**`.

```
  RelativePattern(Uri.file(gitDir),
    '{HEAD,ORIG_HEAD,FETCH_HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_START,
      index,packed-refs,rebase-merge,rebase-apply}')

  RelativePattern(Uri.file(join(gitDir, 'logs')), 'HEAD')
```

The first covers every fact the row states that lives at the top of the git directory: HEAD moving, a fetch attempt,
the operation markers, the index, and `packed-refs` — which matters because `git gc` and `git pack-refs` move branch
tips out of `refs/heads/` into a single file, so a watcher on `refs/heads` alone would go quiet on exactly the
repositories that have been maintained. The second is the reflog, appended on essentially every operation that changes
what the row says, including a commit on a branch whose ref file is nested under `refs/heads/feature/`.

What is deliberately **not** watched:

- **The working tree.** Not one file of it. A recursive watcher across every discovered repository would duplicate
  what the editor already does for the open folders and extend it to directories the user deliberately did not open;
  it is the largest resource cost available to this extension, and it would buy freshness for the dirty count, which
  is second-tier and opt-in and does not need it. This is the failure mode that produces "hangs on startup" reviews.
- **`refs/**` recursively,** for the reason above: a recursive pattern re-admits `files.watcherExclude`.
- **`.git/objects/**`,** which churns on every fetch and gc and from which nothing on the row is derived.

The accepted consequence, stated rather than hidden: a branch ref updated in a repository with reflogs disabled, and a
rebase advancing from step 1/3 to 2/3 inside `rebase-merge/`, do not fire an event. The row still says *rebasing*,
which is the fact that matters, and the step number catches up on the next event, on window focus, or on Refresh.
Nothing goes stale forever.

Events are coalesced by a single debounce timer for the whole extension, not one per repository. The window is a few
hundred milliseconds: long enough that the dozen writes a single `git commit` makes collapse into one pass, short
enough that a commit made in a terminal appears without the user waiting for it. It is a fixed constant rather than a
setting because no user can sensibly tune it, and it is sized against **the shape of a burst, not against a disk** —
no measurement enters it.

Two passes never overlap. A pass in flight sets a running flag; events arriving during it set a queued flag, and the
queue never holds more than one, so a repository being hammered produces one more pass and not a growing backlog.
Because each event carries its URI, a pass triggered by watcher events is scoped to the repositories whose git
directories those events named; only a workspace-folder change or a settings change provokes a full re-walk.

**Spawn count: the scoped pass costs D11's 1 process per affected repository, and 0 for repositories no event
named.**

### D65. Everything is a local read, and this is every outbound path

There are exactly three ways anything leaves this machine, and two of them require a setting that ships off:

1. `gh search prs …` — only when `multirepoLedger.forge.enabled` is `true`.
2. `glab mr list …` — only when `multirepoLedger.forge.enabled` is `true`.
3. `vscode.env.openExternal(<remote web URL>)` — a user gesture on a row, where the request is made by the user's
   browser and not by this extension.

There is nothing else. No telemetry, no update check, no crash reporter, no analytics, no extension-owned HTTP client
— the bundle has no runtime dependencies and the source contains no `fetch`, no `https` import and no socket.

The set of git subcommands the extension may run is **closed**, and every one of them is local: `--version`,
`for-each-ref`, `config --get`, `status`, `log`, `diff-tree`. Nothing in that list writes, and nothing in it connects.
In particular:

- **`git fetch --dry-run` is never used.** Despite its name it downloads the entire payload; the research measured a
  full transfer identical to a real fetch. An extension that ran it while calling itself read-only would be making
  the largest network request in its repertoire under the name of a simulation.
- **`git ls-remote` is never used either.** It is the cheap network probe, and it is still a network probe, and D18
  and D54 have already decided that the answer to a stale divergence figure is to say so.

Rejected: a "check remotes" command that runs `ls-remote` across the board on demand, on the grounds that a user
gesture makes it acceptable. It is acceptable in principle and it belongs beside the forge layer, off by default and
batched — not smuggled in as a row-level convenience where its cost is invisible.

The forge queries are the only commands that read anything about the user's private work, and they run under
credentials that already exist for exactly that purpose. Their results live in memory for the life of the window and
are written nowhere (D55).

**Spawn count: 0.** This decision spawns nothing; it closes the set of things anything else may spawn, and the
processes it admits are counted where they are decided — D11, D12, D14, D40, D46, D53, D56 and D63.

### D66. Two capability declarations, both of which are refusals

The manifest already declares both, and this is why each is correct rather than merely conservative.

**`untrustedWorkspaces.supported: false`.** This extension spawns `git` inside directories it found by walking. A
repository's own `.git/config` can set `core.pager`, `core.fsmonitor`, `core.hooksPath` and aliases — configuration
that causes git to execute a program the repository controls. Running git in a directory the user has not trusted is
therefore arbitrary code execution, which is precisely the boundary Restricted Mode exists to draw, and precisely the
boundary git's own `safe.directory` check draws for the same reason (which is why D19 refuses to defeat it).

The point generalises: any setting naming the `git`, `gh` or `glab` binary would let a workspace-scoped
`.vscode/settings.json` point this extension at an arbitrary executable. **There is no such setting.** The binaries
are resolved from `PATH` and from nowhere else, and if one is ever added it will be `scope: "application"` so a
workspace cannot supply it.

When trust is withheld the extension does not activate, its container contributes nothing, and the editor's own
Restricted Mode banner explains why. Rejected: printing a second explanation of our own — two explanations in two
different voices is how a user concludes that two things are wrong. When trust is granted, the editor enables the
extension and `activate` runs then, for the first time, taking the ordinary path from D63 — which is why there is no
`onDidGrantWorkspaceTrust` listener and no second start-up code path to keep in step with the first.

**`virtualWorkspaces.supported: false`.** In a virtual workspace there is no local filesystem path: there is nothing
to spawn a process in, no `.git` directory to stat, and no `.git/config` to parse. The whole extension is
`child_process` over real paths plus `node:fs`.

Rejected: declaring `limited` support and rendering rows from a forge API when the workspace is virtual. That is a
different extension wearing this one's name. The row would then mean something different depending on where it was
opened — "last commit on disk" in one window and "last commit the server knows about" in another — and the one thing a
status board cannot afford is a row whose meaning depends on context the reader cannot see.

**Spawn count: 0 in either refused case, because the extension does not run.**

### D67. A candidate inside a known working tree is dropped, whoever found it

**The rule.** A discovery candidate whose path lies inside the working tree of a repository the same
generation has already established is **dropped**, unless the user named that candidate, or an
ancestor of it inside that working tree, in `multirepoLedger.additionalRoots`. It applies to the merged
candidate set — the walk's results and the index's alike — so a candidate is judged the same way
whichever source found it.

**Why it has to exist, and why D7 is not enough on its own.** D7 prunes the *walk* at a repository,
and an earlier draft of D9 said, on the strength of that, that submodules "are not found by
walking" and therefore do not appear. That is true of the walk and false of discovery. D5 removes
**every** exclude from the index query, because the editor's default `files.exclude` hides `.git`
and the search would otherwise return nothing at all. D6's pass B is `**/.git`, which matches a file
named `.git` at any depth — and a file named `.git` at depth is precisely the shape of an
initialised submodule's working directory and of a vendored clone. D4 then merges index results in
by resolved path, and the only filters the discovery layer applies to them are the directory-name
list (D10) and `multirepoLedger.exclude`; neither excludes `<repo>/sub` or `<repo>/vendor/other-project`.

Without this rule, therefore, any workspace folder holding an initialised submodule renders a
`submodule` row while `multirepoLedger.includeSubmodules` sits at its default `false` — a setting
contradicted by its own default — and `<repo>/vendor/other-project` gets a row that D9 says it gets
only when the user names it. Worse, because D4 has the index paint first and the walk arrive later,
the row would **appear and then vanish**, which is a worse outcome than either half.

**When it is evaluated, and why that ordering removes the flicker.** `findFiles` resolves as a
batch, so every ordinary repository the index can see is in hand at the same moment as every nested
candidate: ancestry is decidable among the index results themselves, before the walk has answered,
and the rule is applied there first. It is then re-applied over the merged set when the walk
completes, since the walk can establish an enclosing repository the index never saw — a bare
repository, or one under a root that is not an open folder. A candidate the index admitted only
because nothing had yet established its enclosing repository is removed at that point. The
first-pass evaluation is what keeps that from being visible: the flicker case requires an enclosing
repository that only the walk can find, which is not the submodule case.

**What the rule does not touch.** Submodule rows read from the superproject's `.gitmodules` (D9) are
not candidates from the walk or the index; they are admitted by their own setting, and this rule
does not remove them. A linked worktree is not inside another repository's working tree — it is a
directory of its own, wherever the user put it — so nothing here removes one.

Rejected: applying the extension's excludes to the index *query* rather than to its results, so the
question never arises. D5 forbids it for a checkable reason: `"**/.git": true` is in the editor's own
default `files.exclude`, so any exclude argument other than `null` returns nothing, always, and
silently.

Rejected: letting the index legitimately surface these, on the grounds that D4 calls the walk the
authority for *coverage* and more coverage is better. Coverage is not the same claim as membership.
Taking it would make `multirepoLedger.includeSubmodules: false` false on every workspace holding an
initialised submodule, and would make D9's "only when the user named it" true or false depending on
whether the editor's index happened to reach the directory — which is to say, on whether the
repository was under an open folder rather than under an additional root. A board whose contents
depend on which of two sources found a repository is a board nobody can predict.

Rejected: dropping submodules and keeping vendored clones, on the grounds that only the first has a
setting arguing against it. At the point this rule applies the two are indistinguishable — both are
a `.git` inside another repository's working tree — and telling them apart would cost a `.gitmodules`
read on a path where the answer changes nothing, because D7 declines to enter a working tree for
both of them for the same reason.

Rejected: keeping the candidate and marking its row as nested, so that nothing is hidden. It puts
rows on the board that the walk deliberately refused, in numbers set by whatever is vendored under
`node_modules`, and the board's entire value is that it fits on one screen.

**Spawn count: 0.** The test is a path comparison over paths discovery already holds.

## Spawn count and concurrency, collected

Every operation that touches git, in one table, so a reviewer does not have to assemble it from sixty-seven decisions.

| Operation | Processes | Concurrency |
|---|---|---|
| Discovery: the walk, the index passes, repository kind, shallowness | **0** | walk reads directories at the sibling's fixed bound, a file-handle guard |
| `git` present on `PATH` | **1 per session**, cached | serial, after `activate` returns |
| Row read, HEAD attached (case A) | **1** per repository per refresh | `os.availableParallelism()`, floored, ceilinged, overridden by `multirepoLedger.concurrency` (D15) |
| Row read, HEAD detached (case B) | **1** | as above |
| Row read, `HEAD` unreadable (case C) | **1** | as above |
| Row read on old git, detached, after the D12 probe fails | **1** | as above |
| Row read on old git, case C | **2** — the only two-process path in the design | as above |
| Mid-operation state, evidence age, unborn-vs-detached, repository kind | **0** — all filesystem | n/a |
| Dirty state, opt-in, visible rows only | **+1** per visible repository | the same pool, behind tier one |
| History: first page on selection | **1** | one history read in flight, in a single slot **outside** the row-read pool |
| History: each further page | **1** | as above |
| History: expanding a commit's changed files | **1** | as above; at most one expansion at a time |
| History: a different parent of a merge | **1** | as above |
| History: re-expanding a commit already read | **0** | n/a |
| History: unpushed marking, ref chips, relative dates, merge detection | **0** | n/a |
| History: a repository with no commits, unreadable, or with no git | **0** | n/a |
| Cancelling any read | **0** | n/a |
| Open Remote in Browser | **1** at click time | n/a |
| Open folder / terminal / Source Control / copy path | **0** | n/a |
| Forge queries, only while enabled | **1 per distinct owner per refresh** | one queue, serialised (D56) |
| Watcher-triggered pass | **1 per repository the events named**, 0 for the rest | the row-read pool |

Two rules the table encodes. **Every tuning number in it is derived or is a setting**:
`os.availableParallelism()` with a named floor and ceiling, `multirepoLedger.concurrency`,
`multirepoLedger.history.pageSize` derived from the pane's own geometry. The 10 s timeout, the 32 MiB cap, the depth cap,
the directory budget and the retained-commit cap are **guards** — each named for the failure it prevents, none for a
speed it achieves.

**And what happens to an in-flight read when the user clicks a different repository**: the board's row reads are
**not** cancelled, because the user did not stop asking that question (D16); the history read **is** cancelled, and
the pane clears to name the newly selected repository *before* any process starts, so the previous repository's
commits can never appear under the new repository's name (D49).

## Risks

- **The demand is unproven, and the honest reading is uncomfortable.** Directory-as-the-unit discovery is not
  unoccupied: `alefragnani.project-manager` (7,522,313 installs) and `felipecaputo.git-project-manager` (1,504,828)
  both already scan configured absolute base folders for `.git`. What neither does is show any git state, and that is
  the only true form of the claim. Meanwhile 27 extensions claim multi-repository scope, 14 updated in the last three
  months, and **none is above roughly 760 installs**; the closest direct competitor sits at 81. The two seven-figure
  neighbours succeed as pure navigation with no state layer, which is evidence that people want "open the right
  repository fast" more than "watch all my repositories". And the real competitor is not any of them: it is the
  built-in Source Control view plus the Source Control Graph pane, which ships on by default and already goes
  commit → changed files → native diff with a repository picker. **The gap is real, the demand is unproven, and the
  reason to build it is that its author wants it.** Nothing in the proposal leans on a demand argument, because there
  is not one to lean on.
- **The discovery advantage is narrower than it first looks.** Open a folder of repositories as the workspace folder
  and `git.autoRepositoryDetection` with `git.repositoryScanMaxDepth: 1` finds every one of them; GitLens finds them
  too, and also finds repositories outside any folder through SCM open/close events. The advantage exists for
  repositories nested deeper than one level and for directories not open at all. That is what these documents claim
  and it is all they claim.
- **The forge layer is where this extension will lie if it lies.** Truncated listings rendered as counts, a
  `github.com` answer applied to an enterprise row, a GitLab personal namespace silently reported as zero — three
  plausible bugs, each producing a confident wrong number rather than a visible failure. D57, D58 and D59 are the
  mitigations, and the one that matters most is that the type cannot express an unestablished zero. If the layer still
  misreports in real use it stays off, and the rest of the board is unaffected by design (D55).
- **The GitHub coverage assumption is unverified, and an established zero rests on it.** D58 reads "named in no
  result row" as "has no open pull requests", which is only sound if the search saw every repository on the board
  under that owner. GitHub search returns what the credential can see; a `gh` token without the scope to read a
  private repository produces the same silence as a repository with nothing open, and the row then shows `0` for a
  fact nobody established. It is the same class of failure as a truncated listing rendered as a count, arriving on
  private work rather than on large namespaces. Until it is checked against a real host with a deliberately
  under-scoped credential — a task, not an assumption — this is the most likely place the layer misreports, and D55's
  answer applies: if it does, the layer stays off and nothing else on the board is affected.
- **The CLI's own result ceiling is unverified, and the truncation test depends on it.** D56 treats a returned row
  count equal to the requested limit as truncation. If `gh search` or the endpoint caps results below the request,
  that equality never holds and truncation goes undetected. The test therefore also compares against any limit the
  CLI reports applying, and the ceiling is established by a task before a limit is chosen.
- **`glab` has not been verified.** It is not installed on the machine these documents were written on and its flags
  were not guessed at. Every unverified path in that adapter fails to silence rather than to a number, which is the
  correct failure, but the GitLab feature is not finished until somebody runs it against a real GitLab and a real
  `glab`. That is a task, and `tasks.md` says so rather than implying coverage that does not exist.
- **The `.git` marker files are convention, not contract.** `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `rebase-merge/`,
  `rebase-apply/` and `BISECT_START` are not in `gitrepository-layout(5)`. They are stable in practice and the
  extension reads them, but every read degrades silently on absence: a repository mid-rebase whose markers moved shows
  its HEAD state and no operation, never a wrong one.
- **`--include-root-refs` has an unverified version floor.** It works on git 2.52; when it was introduced was not
  established. It is discovered by the first read that needs it and remembered for the session (D12), falling back to
  a shape that costs one extra process on one repository, once.
- **Watcher count scales with repository count.** Two non-recursive watchers per repository is two OS handles per
  repository, not a tree walk, which is the cheapest shape available — but it is not free, and a directory of several
  hundred repositories is a real number of handles. The mitigations are that nothing recursive is ever registered,
  that the working tree is never watched, and that window focus and manual Refresh are independent paths to a fresh
  board, so a watcher the platform declines to install degrades to slightly staler rows rather than to a dead view.
- **Two webviews is two surfaces the platform does not maintain for us.** Keyboard navigation, virtualisation, the
  find widget and context menus are all reimplemented or given up (D21, D37). The mitigation is that both panes share
  one skeleton, one policy and one keyboard contract (D36), that the history list is bounded by construction (D46,
  D48), and that every judgement either surface renders is decided in a pure module with a unit test (D1) — so what is
  reimplemented is presentation, never a decision.
