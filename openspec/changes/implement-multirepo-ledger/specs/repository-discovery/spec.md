# Spec: repository-discovery

Traces to: D3 (two files adapted from the sibling), D4 (the index and the walk, and the walk is the
authority), D5 (a `null` exclude argument), D6 (two index passes), D7 (a repository is a leaf),
D8 (kind decided from files), D9 (one row per working tree), D10 (three guards on the walk),
D16 (cancellation by generation), D20 (a stated row for every degenerate repository), D35 (before,
between and instead of answers), D63 (activation registers and returns), D64 (what provokes a
re-walk), D67 (a candidate inside a known working tree is dropped, whoever found it)

---

## ADDED Requirements

### Requirement: Recursive discovery of git repositories beneath every root

The system SHALL locate every git repository at any depth beneath every open workspace folder and
beneath every absolute path listed in `multirepoLedger.additionalRoots`.

A git repository is a directory holding a `.git` entry — a directory or a file — or a directory that
is itself a bare repository layout (`HEAD`, `config`, `objects/`, `refs/`).

Discovery SHALL use two sources: the editor's own file index and a filesystem walk. The walk covers
every root, the open folders included, and its results are merged with the index's by resolved path.
The index is an accelerator; the walk is the authority, so a repository the index cannot see is
still found, and a repository the walk declines to enter is not shown merely because the index saw
it.

Discovery SHALL spawn no git process. It SHALL be cancellable, and it SHALL NOT run on the
activation path.

#### Scenario: Repositories deeper than one level are found
- **WHEN** a workspace folder contains `work/team-a/service-api/.git`,
  `work/team-a/service-web/.git` and seven further repositories at similar depth
- **THEN** discovery SHALL return all nine
- **AND** each SHALL carry the absolute path of the working tree — the directory containing `.git`,
  not the path of `.git` itself

#### Scenario: A root that is itself a repository
- **WHEN** a path in `multirepoLedger.additionalRoots` contains `.git` directly
- **THEN** discovery SHALL return exactly one repository, that path
- **AND** SHALL NOT return anything below it

#### Scenario: A repository both sources found appears once
- **WHEN** a repository lies beneath an open workspace folder
- **AND** that same folder is also listed in `multirepoLedger.additionalRoots`
- **THEN** the list SHALL show exactly one row for it
- **AND** the header's `showing N of M` SHALL count it once

#### Scenario: Discovery needs no git
- **WHEN** `git` is not on `PATH`
- **THEN** discovery SHALL still return every repository beneath every root
- **AND** every row SHALL show its repository name and its kind marker
- **AND** the board SHALL show one explained state for the missing `git` rather than a failure per
  row

#### Scenario: Nothing is read while the activation path is open
- **WHEN** `activate` returns
- **THEN** no directory SHALL have been read, no file SHALL have been opened and no process SHALL
  have been spawned
- **AND** the first walk SHALL begin only after `activate` has returned

---

### Requirement: The editor index is queried with two globs and no exclude argument

The system SHALL query `vscode.workspace.findFiles` twice — with `**/.git/HEAD` for repositories
whose `.git` is a directory, and with `**/.git` for the three shapes in which `.git` is a file — and
SHALL pass `null` as the exclude argument in both calls.

`null` is the only correct value. Omitting the argument applies the editor's default `files.exclude`,
which contains `"**/.git": true`, so the search returns nothing, always, and says nothing about it.
Each pass SHALL be capped with `maxResults`, which is a guard against paging an unbounded path list
into the extension host and not a limit on how many repositories the board shows.

Because the query carries no excludes, the extension SHALL apply its own directory-name exclusion
list and `multirepoLedger.exclude` to every path the index returns.

#### Scenario: The editor's default excludes do not hide repositories
- **WHEN** `files.exclude` carries its default entry `"**/.git": true`
- **THEN** discovery SHALL still return every repository beneath the open folders
- **AND** the list SHALL NOT be empty while repositories exist

#### Scenario: The index does not manufacture repositories inside a git directory
- **WHEN** a repository's git directory contains `worktrees/wt-feature/HEAD` and `modules/sub/HEAD`
- **THEN** the index passes SHALL yield exactly one candidate for that repository
- **AND** neither `<repo>/.git/worktrees/wt-feature` nor `<repo>/.git/modules/sub` SHALL appear as a
  repository of its own

#### Scenario: The second pass is what finds a `.git` file
- **WHEN** a linked worktree's `.git` is a file holding a `gitdir:` line
- **THEN** the `**/.git` pass SHALL return it
- **AND** the `**/.git/HEAD` pass SHALL NOT

#### Scenario: A bare repository is invisible to the index and found by the walk
- **WHEN** a bare repository at `<root>/mirror.git` sits beneath a scanned root
- **THEN** neither index pass SHALL return it
- **AND** the walk SHALL return it
- **AND** its row SHALL carry the `bare` marker

#### Scenario: An index result inside an excluded directory name is dropped
- **WHEN** the `**/.git/HEAD` pass returns `<folder>/node_modules/some-package/.git/HEAD`
- **THEN** that repository SHALL NOT appear on the list
- **AND** SHALL NOT be counted in any header tally

#### Scenario: No workspace folder is open
- **WHEN** no workspace folder is open
- **THEN** the index SHALL return nothing and that SHALL NOT be treated as a failure
- **AND** discovery SHALL still return every repository beneath `multirepoLedger.additionalRoots`
- **AND** no error SHALL be raised

#### Scenario: An index pass reaches its result cap
- **WHEN** an index pass returns as many paths as its `maxResults` cap allows
- **THEN** the cap SHALL be written to the log with the count
- **AND** the list SHALL state that the search did not see everything
- **AND** the list SHALL NOT present its repository count as the complete count under that root

---

### Requirement: Additional roots from configuration

The system SHALL accept a list of absolute directory paths in `multirepoLedger.additionalRoots` and SHALL
include every repository found at or beneath each of them, whether or not the path lies inside an
open workspace folder.

A configured path that does not exist SHALL be reported once in the extension's output channel and
SHALL NOT prevent the remaining roots from loading. A configured path that is a symbolic link or a
junction SHALL be resolved with `realpath` and walked, because a path the user typed is a statement
of intent and refusing it would break the ordinary `~/src -> /Volumes/work` layout. The built-in
directory-name exclusion list SHALL NOT apply to a directory the user named.

#### Scenario: A root outside the workspace is scanned
- **WHEN** `multirepoLedger.additionalRoots` contains `D:\work\clones`, which holds twelve repositories
- **AND** no workspace folder is open
- **THEN** the list SHALL show twelve rows

#### Scenario: A configured path that does not exist
- **WHEN** a configured additional root does not exist on disk
- **THEN** the output channel SHALL record that path once, naming it
- **AND** every repository beneath every other root SHALL still appear
- **AND** no error dialog SHALL be shown

#### Scenario: A configured root that is a link is followed
- **WHEN** a configured additional root is a symbolic link or a junction pointing at a directory of
  repositories
- **THEN** discovery SHALL return the repositories beneath the resolved directory

#### Scenario: A configured root whose name is on the exclusion list
- **WHEN** a configured additional root is `D:\build`, and `build` is on the built-in directory-name
  exclusion list
- **THEN** discovery SHALL walk it
- **AND** SHALL return the repositories beneath it

#### Scenario: One configured root contains another
- **WHEN** `multirepoLedger.additionalRoots` contains both `D:\work` and `D:\work\clones`
- **THEN** every repository SHALL appear exactly once

---

### Requirement: Finding a `.git` ends the walk of that subtree

The walk SHALL treat a repository as a leaf: it SHALL NOT descend into a `.git` directory, and it
SHALL NOT descend into the working tree of a repository it has just found.

This is what makes the walk's cost a function of the number of directories above the repositories
rather than of what is inside them, and working trees are exactly where `node_modules`, `target`,
`.venv` and `dist` live. A repository the walk therefore declines to enter is reachable in one line
of settings by naming it, or its parent, in `multirepoLedger.additionalRoots`.

#### Scenario: A vendored repository inside a working tree is not returned
- **WHEN** a discovered repository contains `node_modules/some-package/.git`
- **THEN** discovery SHALL NOT return that inner repository
- **AND** the outer repository SHALL have exactly one row

#### Scenario: An unrelated clone inside a working tree is not returned, by either source
- **WHEN** a discovered repository contains `vendor/other-project/.git`
- **AND** that repository lies beneath an open workspace folder, so the editor's index reaches it
- **THEN** the list SHALL NOT show a row for `vendor/other-project`
- **AND** no such row SHALL appear at any point and later disappear

#### Scenario: An initialised submodule beneath an open folder gets no row by default
- **WHEN** a repository beneath an open workspace folder has an initialised submodule at
  `<repo>/sub`, so the `**/.git` index pass returns `<repo>/sub/.git`
- **AND** `multirepoLedger.includeSubmodules` is `false`
- **THEN** the list SHALL show one row, for the superproject
- **AND** SHALL NOT show a row marked `submodule` at any point during the pass

#### Scenario: Naming the inner repository makes it appear
- **WHEN** `multirepoLedger.additionalRoots` gains `<repo>\vendor\other-project`, or `<repo>\vendor`
- **THEN** the list SHALL show two rows, one for each repository
- **AND** each row SHALL state its own HEAD

#### Scenario: The git directory's internals are never repositories
- **WHEN** a discovered repository has `.git/modules/sub` and `.git/worktrees/wt-feature`
- **THEN** neither SHALL appear as a row

#### Scenario: A directory of clones with large working trees does not exhaust the walk
- **WHEN** a root holds twenty repositories, each with tens of thousands of directories inside its
  working tree
- **THEN** the list SHALL show twenty rows
- **AND** the walk SHALL NOT report reaching its directory budget
- **AND** the walk SHALL NOT report stopping at its depth bound

---

### Requirement: Repository kind is decided from the filesystem before any process is spawned

The system SHALL classify every candidate from files alone, at zero process cost, before the row
read chooses its arguments:

| What discovery sees | Resolves to | Kind |
|---|---|---|
| `.git` is a directory | that directory | ordinary |
| `.git` is a file, and the directory it names contains `commondir` | the shared common directory | linked worktree |
| `.git` is a file, the directory it names is a complete repository with no `commondir`, and it sits under an ancestor repository's `.git/modules/` | that directory | submodule |
| the same, but not under a `.git/modules/` | that directory | ordinary, with a separate git directory |
| no `.git`, and the directory holds `HEAD`, `config`, `objects/` and `refs/` | itself | bare |

A `gitdir:` pointer SHALL be resolved whether it is written as an absolute or a relative path,
because both forms occur and neither form identifies the kind. Shallowness is a further marker:
`<gitdir>/shallow` exists.

A kind marker SHALL be shown on line 3 only when the repository is not an ordinary one.

#### Scenario: An ordinary repository carries no kind marker
- **WHEN** a discovered repository's `.git` is a directory
- **THEN** line 3 SHALL carry no kind marker

#### Scenario: A linked worktree is identified by `commondir`
- **WHEN** a candidate's `.git` file names a directory containing `commondir`
- **THEN** the row SHALL carry the `worktree` marker

#### Scenario: A submodule is identified by the path git itself creates
- **WHEN** a candidate's `.git` file names a complete repository with no `commondir`
- **AND** that directory sits under an ancestor repository's `.git/modules/`
- **THEN** the repository SHALL be classified as a submodule

#### Scenario: A separate git directory is not a submodule
- **WHEN** a candidate's `.git` file names a complete repository with no `commondir` that is not
  under any `.git/modules/`
- **AND** that repository's config carries `core.worktree`
- **THEN** the repository SHALL be classified as ordinary
- **AND** SHALL NOT be hidden behind the submodule setting

#### Scenario: A bare repository is identified by its layout
- **WHEN** a directory holds `HEAD`, `config`, `objects/` and `refs/` and has no `.git`
- **THEN** the row SHALL carry the `bare` marker
- **AND** the uncommitted-changes read SHALL never be attempted for it, whether or not that read is
  enabled

#### Scenario: A shallow clone is marked
- **WHEN** `<gitdir>/shallow` exists
- **THEN** the row SHALL carry the `shallow` marker

#### Scenario: An ordinary directory is not a repository
- **WHEN** a directory beneath a root has no `.git` and none of the bare layout
- **THEN** discovery SHALL NOT return it
- **AND** SHALL NOT report an error for it

#### Scenario: Classification is complete without git
- **WHEN** `git` is not on `PATH`
- **THEN** every row SHALL still carry its correct kind marker — `worktree`, `submodule`, `bare` or
  `shallow` — because none of them was bought with a process

---

### Requirement: One row per working tree

The system SHALL show one row per working tree with a HEAD of its own.

A linked worktree found beneath a scanned root SHALL get its own row. A submodule SHALL get its own
row only while `multirepoLedger.includeSubmodules` is `true`, which defaults to `false`; submodules are
read from the superproject's `.gitmodules`, not found by walking, because the walk stops at the
superproject. A submodule listed in `.gitmodules` whose directory holds no `.git` is not initialised
and SHALL get no row.

#### Scenario: A linked worktree is its own row
- **WHEN** a linked worktree of a discovered repository lies beneath a scanned root
- **THEN** the list SHALL show a row for the main repository and a row for the worktree
- **AND** the worktree's row SHALL carry the `worktree` marker
- **AND** each row SHALL state its own HEAD

#### Scenario: Submodules are absent by default
- **WHEN** a discovered repository has an initialised submodule at `<repo>/sub`
- **AND** `multirepoLedger.includeSubmodules` is `false`
- **THEN** the list SHALL show one row, for the superproject
- **AND** `<repo>/sub` SHALL NOT be counted in `showing N of M` or in any header tally

#### Scenario: Submodules appear when the setting is on
- **WHEN** `multirepoLedger.includeSubmodules` is set to `true`
- **THEN** the list SHALL show a row for `<repo>/sub` carrying the `submodule` marker
- **AND** that row SHALL have been discovered without spawning a process

#### Scenario: An uninitialised submodule gets no row
- **WHEN** `.gitmodules` lists a submodule whose directory holds no `.git`
- **AND** `multirepoLedger.includeSubmodules` is `true`
- **THEN** no row SHALL be shown for it
- **AND** no placeholder or error row SHALL be shown in its place

---

### Requirement: The depth bound is a stop against a cycle, not a performance setting

The system SHALL bound the walk at `multirepoLedger.maxDepth` levels below each root, default `32`,
minimum `1`. No value of the setting SHALL mean "unlimited".

The bound exists so a symlink cycle the directory-entry check misses, or a root that turns out to be
a home directory, cannot make the walk run until something gives. It is not a way to make the scan
cheaper: a repository missing from the board produces no evidence that it is missing, whereas a slow
scan announces itself. When the bound ends the walk, the stop SHALL be written to the log with the
depth, the number of directories left unsearched and the first of them.

#### Scenario: The default reaches a real layout
- **WHEN** a repository sits six levels below a scanned root
- **THEN** discovery SHALL return it under the default `multirepoLedger.maxDepth`

#### Scenario: The bound stops the walk and the log says so
- **WHEN** `multirepoLedger.maxDepth` is `2`
- **AND** a repository sits four levels below a root
- **THEN** discovery SHALL NOT return that repository
- **AND** the output channel SHALL record the depth at which the search stopped, the number of
  unsearched directories and the first of them

#### Scenario: Lowering the bound hides repositories with nothing on the board to say so
- **WHEN** `multirepoLedger.maxDepth` is lowered below the depth of an existing repository
- **THEN** that repository's row SHALL disappear on the next pass
- **AND** the only evidence of it SHALL be the log line recording the stop

#### Scenario: There is no unlimited setting
- **WHEN** the user edits the setting
- **THEN** the schema SHALL refuse a value below `1`
- **AND** no value SHALL disable the bound

---

### Requirement: Links are never followed, and every walk terminates

The walk SHALL decide descent from the directory entry, and a link is not a directory, so a symbolic
link or a junction encountered inside a root SHALL NOT be entered. The walk SHALL additionally
remember the real path of every directory it visits, so a cycle terminates rather than merely being
bounded by depth. A root the user named is the exception: it is resolved and walked.

#### Scenario: A junction pointing at its own ancestor terminates the walk
- **WHEN** a scanned root contains a junction `loop` that points at that root
- **THEN** the walk SHALL terminate
- **AND** SHALL return every repository beneath the root exactly once
- **AND** SHALL NOT report reaching its depth bound because of the junction

#### Scenario: A linked directory inside a root is not entered
- **WHEN** a directory inside a scanned root is a symbolic link to a directory of repositories
- **AND** neither it nor its target is named in `multirepoLedger.additionalRoots`
- **THEN** those repositories SHALL NOT appear on the list

#### Scenario: The same repository reached two ways appears once
- **WHEN** two scanned roots resolve to paths that both contain the same repository
- **THEN** the list SHALL show exactly one row for it

---

### Requirement: A directory budget turns a mis-pointed root into a reported condition

The walk SHALL stop reading directories under a root once a per-root directory budget is reached.
The budget's only job is to turn "the user pointed this at `C:\`" into something the board states
rather than into a hang.

Reaching the budget SHALL be written to the log with the count of directories visited and the first
unsearched directory, and SHALL be stated on the list.

#### Scenario: A root pointed at a drive root reports rather than hangs
- **WHEN** `multirepoLedger.additionalRoots` contains `C:\`
- **THEN** the walk SHALL stop at the budget
- **AND** the output channel SHALL record the count and the first unsearched directory
- **AND** the list SHALL state that the search stopped before it finished
- **AND** every repository found before the stop SHALL still be shown
- **AND** the list SHALL NOT present its repository count as the complete count under that root

#### Scenario: An ordinary directory of repositories never reaches the budget
- **WHEN** a root holds a few hundred repositories in a flat or shallow layout
- **THEN** the list SHALL show no such caveat

---

### Requirement: Two exclusion mechanisms, one for descent and one for the board

The walk SHALL skip a fixed list of directory names when deciding what to descend into —
`node_modules`, `dist`, `out`, `build`, `target` and the rest of the sibling's list, with `.git`
removed from it, because in this project `.git` means "stop here" rather than "skip this". The list
is not a setting, and it never applies to a directory the user named as a root.

`multirepoLedger.exclude` SHALL remove a named repository from the extension entirely: it is not walked
into, not read, not counted in any header tally, and not present in the `M` of `showing N of M`.
Exclusion is permanent and silent, which is why it lives in settings rather than in the header, where
filtering is momentary and states its effect.

#### Scenario: `.git` is not on the exclusion list
- **WHEN** a scanned root holds twenty repositories
- **THEN** the list SHALL show twenty rows
- **AND** the board SHALL NOT be empty — which is what leaving `.git` on the copied list produces,
  with no error anywhere

#### Scenario: A repository under an excluded directory name is not returned
- **WHEN** a repository exists at `<root>/project/target/vendored-thing/.git`
- **THEN** discovery SHALL NOT return it, from the walk or from the index

#### Scenario: An excluded repository is absent from everything
- **WHEN** `multirepoLedger.exclude` contains the absolute path of a discovered repository
- **THEN** no row SHALL be shown for it
- **AND** it SHALL NOT be counted in `showing N of M`
- **AND** it SHALL NOT be counted in the `unreadable` tally, even when git would have refused it
- **AND** no git process SHALL be spawned for it

---

### Requirement: The list is populated by discovery, before any git process has answered

The system SHALL render every discovered repository as soon as discovery names it, in a pending
state, rather than waiting for a read. Discovery is filesystem work and answers long before git
does, so the name is already known, and showing it is the difference between a directory of two
hundred repositories feeling answered and feeling absent.

#### Scenario: Rows exist before the first read lands
- **WHEN** discovery has named two hundred repositories and no row read has completed
- **THEN** the list SHALL show two hundred rows
- **AND** each SHALL carry its repository name on line 1
- **AND** line 2 SHALL read `reading…`
- **AND** line 3 SHALL be empty rather than showing an invented state

#### Scenario: Walking with nothing found yet never renders a zero
- **WHEN** the walk is still running and no repository has been found
- **THEN** the list SHALL show an indeterminate busy indicator and the words
  `Looking for repositories…`
- **AND** the list SHALL NOT render a repository count of `0`
- **AND** the header SHALL NOT render a tally chip of `0`

#### Scenario: Between generations the previous answer stays
- **WHEN** a new discovery pass starts while rows from the previous pass are on screen
- **THEN** the previous rows SHALL remain, dimmed, beneath the busy indicator
- **AND** SHALL NOT be replaced by a spinner or by an empty pane

#### Scenario: Discovery finished and found nothing
- **WHEN** discovery completes and no repository was found
- **THEN** the list SHALL render its own empty state, with its own actions, rather than a blank pane
- **AND** those actions SHALL be delivered as messages posted by the page rather than as `command:`
  URIs, because the content security policy admits no navigation

#### Scenario: No folder open and no additional root configured
- **WHEN** no workspace folder is open and `multirepoLedger.additionalRoots` is empty
- **THEN** the list SHALL state that there is nothing to scan
- **AND** SHALL offer both ways out: opening a folder, and configuring an additional root
- **AND** no error SHALL be raised

---

### Requirement: What re-runs discovery, and what does not

The system SHALL re-run discovery when a workspace folder is added or removed, when a `multirepoLedger.*`
setting that changes what is scanned or which repositories are shown is changed, and when the user
invokes the Refresh command.

The system SHALL NOT re-run discovery in response to activity inside an already-known repository. A
watcher event on a repository's git directory re-reads that repository and nothing else.

#### Scenario: A workspace folder is added
- **WHEN** a workspace folder is added to the session
- **THEN** discovery SHALL re-run
- **AND** repositories beneath the new folder SHALL appear

#### Scenario: A discovery setting changes
- **WHEN** `multirepoLedger.additionalRoots`, `multirepoLedger.exclude`, `multirepoLedger.maxDepth` or
  `multirepoLedger.includeSubmodules` changes
- **THEN** discovery SHALL re-run
- **AND** the list SHALL reflect the new set of repositories

#### Scenario: A commit made in a terminal does not re-walk
- **WHEN** a watcher event fires for `<repo>/.git/HEAD` and `<repo>/.git/logs/HEAD`
- **THEN** discovery SHALL NOT re-run
- **AND** exactly that repository SHALL be re-read, at one process
- **AND** every other row SHALL keep its text and cost no process

#### Scenario: A file saved in a working tree changes nothing
- **WHEN** a file inside a discovered repository's working tree is saved
- **THEN** no watcher event SHALL fire, because the working tree is not watched
- **AND** discovery SHALL NOT re-run

#### Scenario: Refresh re-walks
- **WHEN** the user invokes the Refresh command
- **THEN** discovery SHALL re-run over every root

---

### Requirement: A superseded discovery is abandoned and its results are dropped

Every discovery pass SHALL carry a generation and an `AbortSignal`. A refresh, a workspace-folder
change, a relevant settings change and disposal of the view SHALL abort the current generation and
open the next. A walk SHALL observe the signal between two directories and SHALL return what it has,
and a result arriving under a stale generation SHALL be dropped at the boundary rather than merged.

#### Scenario: A second pass supersedes the first
- **WHEN** a workspace folder is added while a walk is still running
- **THEN** the running walk SHALL stop
- **AND** its partial result SHALL be discarded rather than merged into the new pass

#### Scenario: A stale answer never reaches the list
- **WHEN** a repository from a superseded generation resolves after the new generation has begun
  rendering
- **THEN** its row SHALL NOT appear
- **AND** the list SHALL contain only repositories from the current generation

#### Scenario: Nothing outlives the window
- **WHEN** the view is disposed, or the window is closed
- **THEN** the walk SHALL stop
- **AND** no further row SHALL be rendered

#### Scenario: Cancelling costs nothing
- **WHEN** a discovery pass is cancelled
- **THEN** no process SHALL be spawned by the cancellation

---

### Requirement: A degenerate environment narrows the answer but never empties the board

#### Scenario: A directory the process cannot read
- **WHEN** a directory beneath a scanned root cannot be read, because of permissions or because it
  vanished between being listed and being opened
- **THEN** the walk SHALL continue
- **AND** every repository found elsewhere SHALL still appear
- **AND** the list SHALL NOT be emptied, and no error dialog SHALL be shown

#### Scenario: A root on a slow or unreachable mount
- **WHEN** one configured root is a network path that is not answering
- **THEN** the repositories already named by discovery SHALL stay on the list
- **AND** the busy indicator SHALL remain while the walk continues
- **AND** no already-rendered row SHALL be removed or replaced by an error state
- **AND** the editor SHALL remain responsive

#### Scenario: No git on PATH
- **WHEN** `git` is absent from `PATH`
- **THEN** discovery SHALL return the same set of repositories it would otherwise return
- **AND** the board SHALL carry one explained state for the whole board
- **AND** no row SHALL be invented, and no count SHALL render as `0`

#### Scenario: No gh and no glab
- **WHEN** neither `gh` nor `glab` is installed, or neither is authenticated for any host
- **THEN** discovery SHALL return exactly the repositories it would otherwise return
- **AND** no repository SHALL be omitted or added because of the forge layer

---

### Requirement: A repository is given a row on the strength of the filesystem alone

The system SHALL give a row to every repository discovery finds, whatever git later says about it.
Whether a repository has commits, where its HEAD points, whether it is mid-operation and whether git
will read it at all are answers from the read, not conditions of discovery. A row that vanishes is
indistinguishable from a repository that was never there.

#### Scenario: A repository with no commits
- **WHEN** a discovered repository's `HEAD` names a branch that does not exist yet
- **THEN** the repository SHALL be discovered and SHALL have a row
- **AND** discovery SHALL classify it exactly as it classifies a repository with commits

#### Scenario: A detached HEAD or a repository mid-rebase
- **WHEN** a discovered repository has a detached `HEAD`, or is stopped mid-rebase
- **THEN** discovery SHALL return it as an ordinary repository
- **AND** the state SHALL be stated by the row rather than by discovery

#### Scenario: A repository whose git directory cannot be read
- **WHEN** a discovered repository's git directory cannot be read
- **THEN** the repository SHALL still have a row carrying its name
- **AND** the reason SHALL come from the read rather than the row being removed

#### Scenario: A repository git refuses
- **WHEN** git refuses a discovered repository for dubious ownership
- **THEN** the repository SHALL still have a row
- **AND** it SHALL be counted in the `unreadable` tally rather than dropped

#### Scenario: The board's count equals what discovery found
- **WHEN** a pass completes with some repositories unreadable and some still reading
- **THEN** the number of rows SHALL equal the number of repositories discovery found, less those
  removed by `multirepoLedger.exclude`
- **AND** no repository SHALL have been dropped for failing to answer

---

## Open against design

These are gaps in `design.md` that this capability needs and no decision closes. Every requirement
above follows what the design implies; none of them invents a decision.

1. **An unreadable directory is silent.** `util/fsx.ts` is copied verbatim (D3) and its
   `listDirectories` returns an empty list when a directory cannot be read, so the walk continues
   and says nothing. No decision states whether a permission wall under a scanned root should be
   reported at all. The requirement above specifies only that the walk continues and the board is
   not emptied.
2. **The caveat is stated on the list for two of the three guards.** D6 says a reached index cap is
   stated on the list, and D10 says the directory budget is; D10's depth stop is only logged, as in
   the sibling. The argument D6 gives — a board that silently stops is a board that lies about being
   complete — applies equally to all three. The spec follows the design literally and marks the
   difference here.
3. **Settled since this file was written: the index can return what the walk would have pruned.**
   D6's passes run with no excludes and therefore reach a submodule or a vendored clone nested
   inside another repository's working tree beneath an open folder — which D7 prunes, and which D9
   says gets a row only when the user named it or its parent in `additionalRoots`. D67 is now the
   rule that reconciles them: a candidate inside a known working tree is dropped whichever source
   found it, with `additionalRoots` as the one exception. The scenarios above are what that rule
   makes true.
4. **The walk's publication granularity is undecided.** D4 says the index paints first and the
   walk's results are merged in; D35 describes the state "while discovery is still walking with
   nothing found". Neither says whether the walk publishes per root as it finishes them, or once at
   the end — which is what decides whether one unreachable root delays the repositories under every
   other root. The scenario above states only what holds either way.
5. **`discovery/cache.ts` is named but not decided.** D1 describes it as "what the last walk found,
   keyed by stamp", and no decision says what is retained between passes or what the stamp is taken
   from. The requirements above specify only the observable half: which events re-walk and which do
   not.
6. **`multirepoLedger.includeSubmodules` is not in the manifest.** D9 introduces it, defaulting to
   `false`; `package.json` currently declares only `additionalRoots`, `exclude`, `maxDepth` and
   `forge.enabled`. The proposal's manifest-change note covers the history view's `type` but not
   this setting.
