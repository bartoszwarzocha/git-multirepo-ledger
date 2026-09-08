# Spec: commit-history

Traces to: D37 (the history pane is a webview), D38 (graph lanes are out of v1), D39 (the native
per-file diff is out of v1), D40 (one `git log` per page), D41 (record framing and
resynchronisation), D42 (the rev set), D43 (unpushed commits marked from the parent list), D44
(`%P` is read from day one), D45 (ref chips classified by full ref name), D46 (one `diff-tree` per
expansion), D47 (clicking a file opens the working copy), D48 (paging), D49 (a superseded read is
cancelled and the pane clears first), D50 (a stated pane for every degenerate repository).
Cross-cutting: D1 and D2 (module boundaries, and the four places that may import `vscode`), D13
(the pinned child environment), D15 (the per-process timeout), D17 (operation markers), D18
(`FETCH_HEAD` proves an attempt), D34 (selection), D36 (content security policy, theming and
keyboard), D55 (the forge layer is an overlay), D63 (activation), D65 (every outbound path).

---

## ADDED Requirements

### Requirement: The pane SHALL show the history of the selected repository and of nothing else

The system SHALL render commit history for exactly the repository selected in the
`multirepoLedger.repositories` list, SHALL name that repository in the pane, and SHALL NOT select a
repository on its own initiative.

A selection restored from a previous window is a selection, not a read: the read behind it fires
when the history view first becomes visible, never while VS Code holds the activation path open.

#### Scenario: Nothing has been selected
- **WHEN** the extension has activated and no row has ever been selected
- **THEN** the pane SHALL render a state saying that no repository is selected
- **AND** the system SHALL NOT spawn any git process for the pane

#### Scenario: Selecting a row names the pane before anything is read
- **WHEN** the user selects the row for `D:\work\indexer`
- **THEN** the pane SHALL name that repository
- **AND** it SHALL do so before the first git process for it is spawned

#### Scenario: A restored selection costs nothing on the activation path
- **WHEN** a window is reopened with a stored selection and the history pane collapsed
- **THEN** no git process SHALL be spawned for that selection during activation
- **AND** the first page SHALL be read only when the history view first becomes visible

#### Scenario: Re-selecting the same repository reads nothing
- **WHEN** the already-selected row is selected again and the pane is not in an error state
- **THEN** no git process SHALL be spawned
- **AND** the rows and scroll offset already on screen SHALL be unchanged

#### Scenario: Re-selecting a repository whose read failed retries it
- **WHEN** the already-selected row is selected again and the pane is showing a failed read
- **THEN** the system SHALL read the first page again

#### Scenario: A repository nested inside another shows only its own commits
- **WHEN** the selected repository lies inside the working tree of another discovered repository
- **THEN** the page SHALL be read at the selected repository's own path
- **AND** no commit reachable only from the enclosing repository SHALL appear in the pane

---

### Requirement: A page SHALL be read with one git process, in a form no user configuration can change

The system SHALL read each page of commits with exactly one process, of this shape:

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

The exact command SHALL be written to the extension's log, so that what produced a page can be
read back and run by hand. Every flag exists to make the output independent of configuration the
extension cannot see, and each is observable by setting that configuration and reading the pane.

#### Scenario: One process per page
- **WHEN** the first page of a repository's history is read
- **THEN** exactly one git process SHALL be spawned
- **AND** the log SHALL record the full argument list of that process

#### Scenario: A user who has turned decoration off still gets classified chips
- **WHEN** the repository or the user's global git configuration sets `log.decorate=false`
- **THEN** every ref chip SHALL still be classified from its full ref name
- **AND** a tag named `main`, a local branch named `main` and a remote-tracking `origin/main` SHALL
  render as three distinguishable chips

#### Scenario: Abbreviated commit ids do not shorten the parsed field
- **WHEN** the repository sets `log.abbrevCommit=true` or a short `core.abbrev`
- **THEN** every record SHALL still carry the full object id
- **AND** no record SHALL be discarded by the object-id check of the parser

#### Scenario: A legacy log output encoding does not corrupt subjects
- **WHEN** the repository sets `i18n.logOutputEncoding` to a non-UTF-8 encoding
- **THEN** commit subjects SHALL render with their characters intact

#### Scenario: Signature verification output never reaches a row
- **WHEN** the repository sets `log.showSignature=true`
- **THEN** no row SHALL contain signature verification text
- **AND** no record SHALL be discarded because of it

#### Scenario: A configured upstream ref that is not on disk does not fail the page
- **WHEN** the branch has an upstream configured whose remote-tracking ref has never been fetched
- **THEN** the page SHALL render the commits reachable from `HEAD`
- **AND** the process SHALL NOT fail with an ambiguous-argument error

#### Scenario: A branch and a directory with the same name
- **WHEN** the repository contains both a branch named `docs` and a directory named `docs`, and
  `docs` is the upstream ref or `HEAD`
- **THEN** the page SHALL show that branch's commits
- **AND** SHALL NOT show a history filtered to the directory

---

### Requirement: Every git child of this pane SHALL run under the pinned environment

The system SHALL spawn the pane's git children with `LC_ALL=C`, `LANGUAGE=` empty,
`GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, with no shell, no pager and hidden windows.

#### Scenario: A repository path containing shell metacharacters
- **WHEN** the selected repository's path contains a space and an `&`
- **THEN** the page SHALL be read correctly
- **AND** no part of the path SHALL be interpreted as a command

#### Scenario: A page read cannot block on a prompt
- **WHEN** any git child of the pane would otherwise ask for a credential or open a pager
- **THEN** it SHALL fail or return instead of waiting
- **AND** the pane SHALL state the failure rather than remaining blank

---

### Requirement: Rows SHALL be ordered by committer date and SHALL show it

The system SHALL render commits in the order git emits them under `--date-order`, SHALL show the
committer date on the row, and SHALL name both dates in the tooltip when the author date differs.

`--date-order` guarantees that no parent is emitted before all of its children, which is what makes
the marking in the unpushed requirement below exact.

#### Scenario: A rebased branch reads as a dated list
- **WHEN** the branch was rebased this morning and its commits were authored months ago
- **THEN** each row SHALL show the committer date
- **AND** the dates down the list SHALL NOT jump backwards and forwards

#### Scenario: Both dates are available where they differ
- **WHEN** a commit's author date and committer date differ
- **THEN** the row's tooltip SHALL name both, labelled

#### Scenario: A parent never appears above its own child
- **WHEN** a commit in the page carries a committer date earlier than its own parent's, because a
  clock was wrong or the history was rewritten
- **THEN** the parent SHALL NOT be rendered above the child

#### Scenario: The author name is what the terminal shows
- **WHEN** the repository has a `.mailmap` that maps the author of a commit
- **THEN** the row SHALL show the mapped name, as `git log` does in the user's own terminal

#### Scenario: The author name is the field that yields at narrow widths
- **WHEN** the sidebar is dragged narrow enough that the row cannot hold every field
- **THEN** the author name SHALL be dropped first
- **AND** the committer date and the subject SHALL keep their width

---

### Requirement: The rev set SHALL be HEAD plus the upstream ref, and nothing wider

The system SHALL walk `HEAD` together with the upstream ref of the current branch when there is
one, and SHALL NOT walk `--all` or `--branches`.

The upstream ref name is already known from the row read, so naming it costs no extra process.

#### Scenario: The commits the row said were behind are in the page
- **WHEN** the row reports the repository is behind by three commits
- **AND** the user selects that row
- **THEN** those three upstream commits SHALL appear in the page

#### Scenario: Other local branches do not crowd the page
- **WHEN** the repository has twenty local topic branches whose tips are not reachable from `HEAD`
  or from the upstream ref
- **THEN** none of those tips SHALL appear in the page

#### Scenario: No upstream
- **WHEN** the current branch has no upstream configured
- **THEN** the page SHALL be read from `HEAD` alone
- **AND** the pane SHALL render without an error

---

### Requirement: Records SHALL be framed so that no commit message can desynchronise the parse

The system SHALL terminate records with NUL, separate fields with `0x1F`, put the subject last, and
split each record into exactly seven parts with the seventh taken verbatim to the record's end.

A record whose first field is not a valid object id — the exact hexadecimal length the repository
uses — SHALL be discarded with a log line, and parsing SHALL continue at the next NUL.

#### Scenario: A subject containing a tab
- **WHEN** a commit's subject is `subject with<TAB>tab`
- **THEN** the row SHALL show that subject with the tab intact
- **AND** every following commit SHALL still render correctly

#### Scenario: A subject containing the field separator
- **WHEN** a commit's subject contains a `0x1F` character
- **THEN** the row SHALL show the whole subject including that character
- **AND** the parse SHALL NOT treat it as a field boundary

#### Scenario: A malformed record costs one row, never the pane
- **WHEN** a record arrives whose first field is not an object id of the repository's hash length
- **THEN** that record SHALL be discarded and logged
- **AND** every other commit in the page SHALL render

#### Scenario: A separator in an author name does not shift the stream
- **WHEN** a commit's author name contains a `0x1F` character
- **THEN** at most that one row SHALL be wrong
- **AND** every following commit SHALL render with its own fields

#### Scenario: The parser runs without an extension host
- **WHEN** `npm test` runs
- **THEN** the record parser's tests SHALL execute under `node --test`
- **AND** SHALL NOT require an extension host to load the module under test

---

### Requirement: Commits that exist only on this machine SHALL be marked, and an unestablished count SHALL NOT render as zero

The system SHALL mark, in the page, every commit reachable from `HEAD` and not from the upstream
ref, deriving the marking from the parent list already in the record and the ordering guarantee of
`--date-order`, at no additional process cost.

Where no upstream ref took part in the walk there is nothing to mark, and the pane SHALL say
nothing about unpushed commits rather than reporting none.

The marking state — the set of hashes established as being on the upstream, and whether the upstream
tip has been emitted yet — SHALL persist across every page of the selected repository, and SHALL be
discarded when the selection changes and whenever the pane reloads from the first page. Pages are
read one process each with an offset, so a parser that starts each page empty has, on page two,
never seen the upstream tip: every record is emitted after a tip it did not see, with no child in
that page to have marked it, and the marking would then mark the whole page unpushed.

#### Scenario: Three local commits are marked, and only those three
- **WHEN** the branch has three commits its upstream does not have, and every one of them is on the
  first page
- **THEN** exactly those three rows SHALL carry the unpushed marker
- **AND** the marked set SHALL match `git log HEAD --not <upstream> --format=%H`

#### Scenario: The second page of a repository whose upstream tip was on the first
- **WHEN** the upstream tip was emitted on page one and the user loads page two
- **THEN** no row on page two SHALL carry the unpushed marker
- **AND** the marked set over both pages together SHALL match
  `git log HEAD --not <upstream> --format=%H` restricted to the commits fetched
- **AND** the marking SHALL NOT be re-derived by spawning a further process

#### Scenario: A reload discards the carried state
- **WHEN** the pane reloads from the first page because a fetched page repeated a commit already
  shown
- **THEN** the marking SHALL be derived again from the reloaded walk
- **AND** SHALL NOT carry a set established during the walk that was abandoned

#### Scenario: A merge in the history does not fool the marking
- **WHEN** the history between the upstream tip and `HEAD` contains a merge, so that the first *N*
  rows of the dated walk are not the *N* commits ahead
- **THEN** the marked set SHALL still be exactly the commits reachable from `HEAD` and not from the
  upstream ref

#### Scenario: No upstream means no marker and no zero
- **WHEN** the current branch has no upstream configured
- **THEN** no row SHALL carry an unpushed marker
- **AND** the pane SHALL NOT render `0 unpushed`, `0 ahead`, or any other count of a thing it has
  not established

#### Scenario: Detached HEAD means no marker and no statement
- **WHEN** `HEAD` is detached
- **THEN** no row SHALL carry an unpushed marker
- **AND** the pane SHALL say nothing about unpushed commits

#### Scenario: An upstream ref that is not on disk means no marker
- **WHEN** the configured upstream ref was dropped from the walk because it does not exist
- **THEN** no row SHALL carry an unpushed marker
- **AND** the pane SHALL NOT claim that every commit is pushed

#### Scenario: Marking costs no second process
- **WHEN** a page is rendered with unpushed markers on it
- **THEN** the log SHALL show one process for that page and no other

---

### Requirement: The pane SHALL state the age of the evidence behind its divergence, and SHALL NOT claim currency

The upstream ref on disk is as old as the last fetch, so the system SHALL qualify the marking with
the age of the last fetch **attempt** when `FETCH_HEAD` exists, SHALL say nothing when it does not,
and SHALL never assert that the repository is current.

#### Scenario: FETCH_HEAD exists
- **WHEN** `<gitdir>/FETCH_HEAD` exists with an mtime of two days ago
- **THEN** the pane SHALL say that a fetch was last attempted two days ago
- **AND** SHALL NOT say `up to date`, `in sync` or `fetched`

#### Scenario: FETCH_HEAD is absent after a clone
- **WHEN** `<gitdir>/FETCH_HEAD` does not exist
- **THEN** the pane SHALL say nothing about fetch freshness
- **AND** SHALL NOT say `never checked`

#### Scenario: The pane never freshens the answer itself
- **WHEN** the pane renders a divergence caveat
- **THEN** the system SHALL NOT run `git fetch`, `git fetch --dry-run` or `git ls-remote`

---

### Requirement: Ref chips SHALL be classified by full ref name and ordered by the question they answer

The system SHALL build chips from the decoration field of each record, splitting the list on a
comma followed by a space, and SHALL classify each entry by its full ref name:

| Form | Chip |
|---|---|
| `HEAD -> refs/heads/x` | one chip, `HEAD → x` |
| `HEAD` alone | detached HEAD |
| `refs/heads/x` | local branch |
| `refs/remotes/<remote>/x` | remote branch, shown as `<remote>/x` |
| `refs/remotes/<remote>/HEAD` | suppressed |
| `tag: refs/tags/x` | tag |
| anything else | other ref, short name shown, full name in the tooltip |

Chips SHALL be ordered HEAD, local branches, remote branches, tags, then other refs, alphabetically
within each group, independently of the order git emitted them in.

#### Scenario: A branch tip on a fresh clone
- **WHEN** a commit decorates as `HEAD -> refs/heads/main, refs/remotes/origin/main,
  refs/remotes/origin/HEAD`
- **THEN** the row SHALL show one `HEAD → main` chip and one `origin/main` chip
- **AND** SHALL NOT show a chip for `refs/remotes/origin/HEAD`

#### Scenario: A tag and a branch of the same name
- **WHEN** a commit carries both `refs/heads/main` and `tag: refs/tags/main`
- **THEN** the row SHALL show two chips that can be told apart as a branch and a tag

#### Scenario: A ref name containing a comma
- **WHEN** a commit carries a branch named `feature,wip`
- **THEN** the row SHALL show one chip named `feature,wip`

#### Scenario: An unrecognised ref is shown, not dropped
- **WHEN** a commit carries `refs/notes/commits`, `refs/stash` or a Gerrit `refs/changes/*` ref
- **THEN** the row SHALL show it as an other-ref chip with its short name
- **AND** its full ref name SHALL be available in the tooltip

#### Scenario: Detached HEAD
- **WHEN** the decoration field of a commit is the bare token `HEAD`
- **THEN** the row SHALL show a detached-HEAD chip

#### Scenario: A narrow pane collapses chips but never the HEAD chip
- **WHEN** the pane is narrow enough that the chips do not fit their share of the row
- **THEN** the overflowing chips SHALL collapse into a single `+N` chip whose contents are
  available on hover and on keyboard focus
- **AND** the HEAD chip SHALL remain visible
- **AND** the subject SHALL NOT be shortened to make room for a chip

#### Scenario: Rows keep one height
- **WHEN** a commit carries more chips than fit on one line
- **THEN** the chips SHALL NOT wrap onto a second line
- **AND** every commit row SHALL keep the same height as every other

---

### Requirement: Selecting a commit SHALL expand the list of files it changed, read with one process

The system SHALL read an expanded commit's changed files with exactly one process — `diff-tree`
with `-r -M --root --no-commit-id --raw --numstat -z` for an ordinary commit — and SHALL keep at
most one commit expanded at a time.

#### Scenario: Expanding a commit
- **WHEN** the user selects a commit row in the pane
- **THEN** exactly one git process SHALL be spawned
- **AND** the row SHALL expand into a list of the files that commit changed, each with a status, a
  path and a churn figure

#### Scenario: Expanding a second commit collapses the first
- **WHEN** a commit is expanded and the user selects another commit
- **THEN** the first commit SHALL collapse
- **AND** at most one expanded file list SHALL be on screen

#### Scenario: Re-expanding a commit reads nothing
- **WHEN** a commit that has already been expanded during this selection is expanded again
- **THEN** no git process SHALL be spawned
- **AND** the same file list SHALL be shown

#### Scenario: Collapsing reads nothing
- **WHEN** an expanded commit is collapsed
- **THEN** no git process SHALL be spawned

#### Scenario: A repository's first commit
- **WHEN** the expanded commit is a root commit with no parents
- **THEN** its files SHALL be listed as additions
- **AND** the pane SHALL NOT show a commit with an empty file list

#### Scenario: Expanding is reachable from the keyboard
- **WHEN** focus is on a commit row and the user presses Enter or Space
- **THEN** that commit SHALL expand

---

### Requirement: The changed-file list SHALL be exact about renames, binaries, modes and emptiness

The system SHALL render a rename as one row, SHALL name a binary file as binary rather than
counting its lines, SHALL state a mode-only change as a mode change, and SHALL distinguish a commit
that changed nothing from a read that did not complete.

No figure in this list is a placeholder: a churn count is rendered only where added and deleted
lines were actually reported.

#### Scenario: A rename is one row
- **WHEN** the expanded commit renamed `big.txt` to `moved.txt`
- **THEN** the list SHALL show one row reading `big.txt → moved.txt`
- **AND** SHALL NOT show a deletion and an addition

#### Scenario: A rename in a repository that has renames turned off
- **WHEN** the repository sets `diff.renames=false` and the commit renamed a file
- **THEN** the list SHALL still show one rename row

#### Scenario: A path containing a tab or a space
- **WHEN** the expanded commit touched `src/a<TAB>b.ts`
- **THEN** the list SHALL show that path verbatim
- **AND** SHALL show it identically whether or not `core.quotePath` is set

#### Scenario: A binary file
- **WHEN** the expanded commit changed a binary file
- **THEN** its row SHALL say `binary` where a churn figure would be
- **AND** SHALL NOT say `+0 −0`

#### Scenario: A mode-only change
- **WHEN** the expanded commit changed only a file's mode, leaving its content identical
- **THEN** its row SHALL state the mode change, for example `mode 100644 → 100755`
- **AND** SHALL NOT say `+0 −0` and SHALL NOT be omitted from the list

#### Scenario: A commit that changed nothing
- **WHEN** the expanded commit is an empty commit and the process succeeded with no records
- **THEN** the pane SHALL state that this commit changed no files

#### Scenario: A truncated expansion is a failure, not a short list
- **WHEN** the output of the expansion passes the runner's byte cap and is reported truncated
- **THEN** the pane SHALL state that the file list was truncated, with the exact command to run
- **AND** SHALL NOT present the rows it did parse as a complete list
- **AND** SHALL NOT show a total number of changed files

#### Scenario: A commit that touched more files than the pane renders
- **WHEN** a successful expansion parsed more records than the pane's row bound
- **THEN** the pane SHALL render the bounded number of rows and a `+N more` line
- **AND** *N* SHALL be counted from records actually parsed

---

### Requirement: A merge's changed-file list SHALL name the parent it was computed against

The system SHALL compute a merge's file list against one parent, defaulting to the first, SHALL
state in the pane which parent the list is against, and SHALL let the user choose another parent.

#### Scenario: Expanding a merge
- **WHEN** the user expands a commit with two parents
- **THEN** the file list SHALL be computed against the first parent
- **AND** the pane SHALL state which parent it is against
- **AND** the list SHALL NOT be labelled simply "files changed"

#### Scenario: Choosing the other parent
- **WHEN** the user picks the second parent of an expanded merge
- **THEN** exactly one further git process SHALL be spawned
- **AND** the pane SHALL restate which parent the new list is against

#### Scenario: Identifying a merge costs nothing
- **WHEN** a page contains merges
- **THEN** the system SHALL identify them from the parent list already in each record
- **AND** SHALL NOT spawn any process to discover that a commit is a merge

#### Scenario: A merge is never rendered as a blank expansion
- **WHEN** the user expands a merge
- **THEN** the pane SHALL either show a file list against a named parent, or state that the merge
  changed nothing against the parent it names
- **AND** SHALL NOT show an expansion that says neither

#### Scenario: A merge whose tree equals the parent it was compared against
- **WHEN** the expansion of a merge succeeds and returns no records, as it does for a merge resolved
  entirely in favour of that parent
- **THEN** the pane SHALL state that the merge changed no files against the named parent
- **AND** SHALL offer the merge's other parents
- **AND** SHALL NOT render the empty result as a failed read

---

### Requirement: Clicking a changed file SHALL open its current working copy, and the pane SHALL say so

The system SHALL open the file's current working-tree copy in an editor tab, SHALL state once per
expanded list that this is what it does, and SHALL disable the action with its reason where it
cannot apply.

This is the whole of the click in this version. The native per-file diff is out of scope, and the
requirement below states what that means in terms a reviewer can check.

#### Scenario: Opening a file from a repository the editor has never opened
- **WHEN** the user clicks a changed file of a repository that is not in any workspace folder
- **THEN** that file's current working-tree copy SHALL open in an editor tab

#### Scenario: The pane says what the click does
- **WHEN** a commit's file list is expanded
- **THEN** the list SHALL carry one caption saying that clicking opens the file as it is now, not
  as it was in this commit
- **AND** that caption SHALL appear once for the list, not on every row

#### Scenario: A file the commit deleted
- **WHEN** a row is a deletion, so there is no working copy
- **THEN** the action SHALL be disabled with that reason shown on the row
- **AND** SHALL NOT be silently inert

#### Scenario: A renamed file offers the new path
- **WHEN** a row is a rename
- **THEN** the action SHALL open the new path

#### Scenario: A bare repository has no working copy to open
- **WHEN** the selected repository is bare
- **THEN** the action SHALL be unavailable for every row
- **AND** the pane SHALL state the reason once, not once per row

#### Scenario: The context menu on a changed file
- **WHEN** the user opens the context menu on a row of the file list
- **THEN** it SHALL offer to copy the repository-relative path, to reveal the file in the Explorer,
  and to run `git show <full hash> -- <path>` in a terminal opened at the repository

---

### Requirement: The pane SHALL contain no graph lanes and SHALL open no diff editor

The system SHALL render the history as a dated list with no lane column, no track and no ASCII
graph, and SHALL NOT open a diff for a changed file in this version.

The parent list is nevertheless parsed and retained, because it is what identifies an unpushed
commit and what identifies a merge, and because the later change that adds lanes must not have to
change the read, the record layout or the parser.

#### Scenario: No lanes anywhere
- **WHEN** any page of any repository is rendered
- **THEN** no lane, track or graph column SHALL be drawn
- **AND** the system SHALL NOT run `git log --graph`

#### Scenario: No diff machinery is registered or used
- **WHEN** the extension is running
- **THEN** it SHALL NOT construct a `git:` URI
- **AND** SHALL NOT register a `FileSystemProvider` or a `TextDocumentContentProvider`
- **AND** SHALL NOT run `git cat-file`

#### Scenario: The parent list is read from day one
- **WHEN** a page is read
- **THEN** the logged command SHALL show a format carrying the parent list
- **AND** merge identification and unpushed marking SHALL both be answered from it without a
  further process

---

### Requirement: Pages SHALL be sized from the pane and bounded by guards, never by a measured constant

The system SHALL derive the first page size from the number of fixed-height rows that fit the pane
and an overscroll factor, SHALL clamp that value between a floor and a ceiling, and SHALL use
`multirepoLedger.history.pageSize` instead when it is set above zero.

The floor and the ceiling are guards: the floor stops a pane collapsed to a sliver from spawning a
process to fetch two commits, and the ceiling stops a pane dragged to the height of an unknown
display from asking for a page nobody chose.

#### Scenario: The setting overrides the derivation
- **WHEN** `multirepoLedger.history.pageSize` is set to a value above zero
- **THEN** that value SHALL be the page size

#### Scenario: Zero means derive from the pane
- **WHEN** `multirepoLedger.history.pageSize` is `0`
- **THEN** the page size SHALL be derived from the pane's own geometry

#### Scenario: A pane collapsed to a sliver
- **WHEN** the pane is dragged so short that fewer rows fit than the floor
- **THEN** the page size SHALL be the floor

#### Scenario: More is asked for two ways
- **WHEN** the end of the fetched list comes into view
- **THEN** the next page SHALL be requested
- **AND** an explicit control to load more SHALL also be rendered at the end of the list and SHALL
  be reachable from the keyboard

#### Scenario: A further page costs one process
- **WHEN** the user asks for the next page
- **THEN** exactly one git process SHALL be spawned
- **AND** the commits already on screen SHALL remain

#### Scenario: No git process is left alive between pages
- **WHEN** a page has finished rendering
- **THEN** no git child SHALL remain running for the selected repository

#### Scenario: The retained-commit cap is reached
- **WHEN** the number of commits held for the selected repository reaches the configured cap
- **THEN** the pane SHALL state that it is showing the most recent commits and SHALL stop offering
  more
- **AND** SHALL NOT simply stop responding to a request for more

---

### Requirement: History moving underneath a page SHALL be detected rather than rendered

The system SHALL keep the set of commit ids already shown for the current selection, and SHALL
reload from the first page rather than appending when a fetched page contains one of them.

A truncated page is a failed page: the system SHALL NOT treat it as the end of history.

#### Scenario: A commit lands between two pages
- **WHEN** a commit is made in a terminal after page one was rendered and before page two is
  fetched
- **AND** page two contains a commit id already shown
- **THEN** the pane SHALL reload from the first page
- **AND** no commit SHALL appear twice in the list

#### Scenario: A truncated page
- **WHEN** the output of a page read passes the runner's byte cap and is reported truncated
- **THEN** the pane SHALL state that the page failed, with the exact command
- **AND** SHALL NOT render the parsed commits as the end of history

#### Scenario: Pages are not carried between repositories
- **WHEN** the user selects a different repository and later selects the first one again
- **THEN** the first repository's pages SHALL be read again
- **AND** the pane SHALL NOT render commits fetched before the selection changed

---

### Requirement: The pane SHALL state what it is doing while an answer is still being fetched

The system SHALL never render an empty box while work is outstanding: a pane waiting for its first
page, a list waiting for a further page, and an expanded commit waiting for its file list SHALL
each say so.

#### Scenario: The first page of a newly selected repository
- **WHEN** a repository is selected and its first page has not arrived
- **THEN** the pane SHALL render a loading state naming that repository

#### Scenario: A further page in flight
- **WHEN** the next page has been requested and has not arrived
- **THEN** the commits already fetched SHALL remain on screen
- **AND** the end of the list SHALL state that more is being read

#### Scenario: An expansion in flight
- **WHEN** a commit has been expanded and its file list has not arrived
- **THEN** the expanded block SHALL state that the file list is being read
- **AND** SHALL NOT render an empty list

#### Scenario: A read that does not answer in time
- **WHEN** a page or an expansion does not answer within the per-process timeout
- **THEN** the pane SHALL state that it did not answer, with the exact command and a way to retry
- **AND** SHALL NOT clear commits already on screen and SHALL NOT go blank

---

### Requirement: A superseded history read SHALL be cancelled, and the pane SHALL clear before the new answer arrives

The system SHALL clear the pane to a loading state naming the newly selected repository before any
process for it is started, SHALL kill the in-flight child, and SHALL discard output arriving from a
superseded selection whether or not the kill succeeded.

The ordering is the requirement. The failure being prevented is one repository's commits sitting
under another repository's name.

#### Scenario: Selecting a second repository while the first is still reading
- **WHEN** repository A's first page is in flight and the user selects repository B
- **THEN** the pane SHALL clear and name B before any process for B is spawned
- **AND** A's child SHALL be killed
- **AND** no commit of A SHALL be rendered under B's name

#### Scenario: Output that was already in the pipe
- **WHEN** a superseded read's output arrives after the selection changed, because the kill came
  too late or failed
- **THEN** that output SHALL be discarded
- **AND** SHALL NOT be merged into the pane

#### Scenario: An expansion is cancelled with its repository
- **WHEN** an expanded commit's file list is in flight and the user selects another repository
- **THEN** that read SHALL be cancelled and its output discarded

#### Scenario: The board is not cancelled by a selection
- **WHEN** the user selects a repository while rows in the list are still being read
- **THEN** those row reads SHALL continue
- **AND** rows SHALL keep filling in behind the selection

---

### Requirement: Visibility, refresh and disposal SHALL each have a stated effect on the pane

The system SHALL re-render from what it already holds when the pane is hidden and revealed, SHALL
re-read the first page after a window reload, SHALL leave the pane alone when the board refreshes,
and SHALL kill every in-flight child on disposal.

#### Scenario: Hiding and revealing the pane
- **WHEN** the history view is collapsed and then expanded again
- **THEN** no git process SHALL be spawned
- **AND** the commits already fetched SHALL be rendered again, with the previous scroll offset

#### Scenario: Reloading the window
- **WHEN** the window is reloaded and the history view becomes visible
- **THEN** the previous selection SHALL be restored
- **AND** its first page SHALL be read again

#### Scenario: Refreshing the board
- **WHEN** the user invokes the refresh command from either view's title
- **AND** the selected repository is still present at the same path
- **THEN** the pane SHALL keep its selection, its fetched pages and its scroll offset
- **AND** SHALL spawn no history process

#### Scenario: The selected repository disappears
- **WHEN** the selected repository is deleted, excluded or absent from the next scan
- **THEN** the pane SHALL state which repository is gone and why it is no longer shown
- **AND** SHALL NOT silently empty

#### Scenario: Closing the window
- **WHEN** the extension is deactivated or the view disposed
- **THEN** every in-flight history child SHALL be killed
- **AND** no process SHALL outlive the window

---

### Requirement: Every degenerate repository SHALL have a stated pane, and most SHALL cost no process

The system SHALL decide the pane from facts the row read and the filesystem walk already hold
wherever it can, and SHALL NOT spawn a read that is known in advance to fail.

#### Scenario: A repository with one commit
- **WHEN** the selected repository has exactly one commit
- **THEN** the page SHALL be one row
- **AND** expanding it SHALL list its files as additions

#### Scenario: A repository with no commits
- **WHEN** the selected repository's `HEAD` names a branch that does not exist yet
- **THEN** the pane SHALL state that there are no commits yet, naming the repository
- **AND** no git process SHALL be spawned
- **AND** the pane SHALL NOT say that the repository could not be read

#### Scenario: A bare repository
- **WHEN** the selected repository is bare
- **THEN** the page SHALL be read and rendered as for any other repository
- **AND** the pane SHALL note that the repository is bare
- **AND** the action that opens a working copy SHALL be unavailable, with the reason stated once

#### Scenario: A bare repository with no commits
- **WHEN** the selected repository is bare and has no commits
- **THEN** the pane SHALL state that there are no commits yet
- **AND** no git process SHALL be spawned

#### Scenario: A repository mid-rebase
- **WHEN** the selected repository has `rebase-merge/` with `head-name`, `msgnum` and `end`
- **THEN** the pane SHALL render a banner above the commit rows naming the branch being rebased and
  the step, and stating that the rows below are the history of the commit being rebased onto
- **AND** that banner SHALL be visible while commit rows are on screen, not only when the list is
  empty
- **AND** the target SHALL be named by the short object id that was read, never by a branch name
  resolved from it

#### Scenario: A repository mid-rebase whose marker files are not where they were
- **WHEN** the operation marker files cannot be read
- **THEN** the pane SHALL drop the banner and render the detached-HEAD chip
- **AND** SHALL NOT guess an operation or report an error about the marker files

#### Scenario: A repository with a detached HEAD
- **WHEN** the selected repository has a detached `HEAD`
- **THEN** the page SHALL be read and rendered
- **AND** the current commit SHALL carry a detached-HEAD chip
- **AND** no unpushed marker and no statement about unpushed commits SHALL appear

#### Scenario: A shallow repository
- **WHEN** the selected repository is a shallow clone and the oldest fetched commit has no parents
  in the record
- **THEN** the pane SHALL state that the history is shallow
- **AND** SHALL NOT present that commit as the repository's first commit

#### Scenario: A repository with no remote
- **WHEN** the selected repository has no remote configured
- **THEN** the page SHALL be read from `HEAD` alone and rendered
- **AND** no remote-branch chip, no unpushed marker and no fetch-age statement SHALL appear

#### Scenario: A repository git refuses to read
- **WHEN** the row for the selected repository already reports that git refused it for dubious
  ownership
- **THEN** the pane SHALL repeat that reason with the repository's path
- **AND** SHALL NOT spawn a read that will fail the same way
- **AND** SHALL NOT offer to make git trust the directory

#### Scenario: A repository that could not be read for any other reason
- **WHEN** the row for the selected repository reports that it is unreadable
- **THEN** the pane SHALL repeat that reason and the path
- **AND** no git process SHALL be spawned

---

### Requirement: Degenerate environments SHALL each produce a stated pane rather than a wrong one

The system SHALL state, once, when `git` is not available, SHALL survive a filesystem that answers
slowly or not at all, and SHALL render the same history whether or not the forge tools exist.

#### Scenario: No git on PATH
- **WHEN** `git` is not on `PATH`
- **THEN** the pane SHALL state that once and offer the extension's log
- **AND** no git process SHALL be spawned for the pane

#### Scenario: A repository on an unreachable mount
- **WHEN** the selected repository sits on a network share that stops answering
- **THEN** the read SHALL be abandoned at the per-process timeout
- **AND** the pane SHALL state that the repository did not answer, with the command and a way to
  retry
- **AND** the extension host SHALL remain responsive

#### Scenario: Neither gh nor glab is installed
- **WHEN** neither forge tool is on `PATH`
- **THEN** the pane SHALL render exactly as it does when they are present

#### Scenario: The forge layer is off, or on but unauthenticated
- **WHEN** `multirepoLedger.forge.enabled` is `false`, or is `true` against a host no forge tool is
  authenticated for
- **THEN** the rendered history SHALL be identical in both cases
- **AND** no forge failure SHALL change any fact the pane states about commits

---

### Requirement: The pane SHALL be a webview whose caveats render above a non-empty list

The system SHALL contribute `multirepoLedger.history` as a webview view, SHALL attach no `viewsWelcome`
block to it, and SHALL render its caveats as part of the page rather than as a tooltip, a view
description or a row in the list.

#### Scenario: The manifest declares the pane a webview
- **WHEN** `package.json` is read
- **THEN** the `multirepoLedger.history` view SHALL declare `"type": "webview"`
- **AND** no `viewsWelcome` entry SHALL name that view

#### Scenario: Two caveats at once, above rows
- **WHEN** the selected repository is mid-rebase and the list has reached its retained-commit cap
- **THEN** both statements SHALL be visible at the same time as the commit rows
- **AND** neither SHALL be rendered as a selectable row in the list of commits

---

### Requirement: The pane SHALL be themed from editor variables, reachable without a mouse, and unable to reach the network

The system SHALL serve the pane under a content security policy of `default-src 'none'` with nonced
style and script and nothing else, with no local resource roots, SHALL take every colour from a
`--vscode-*` variable, SHALL give the commit list one tab stop with arrow-key movement inside it,
and SHALL validate every message arriving from the page against a known set before acting on it.

#### Scenario: The policy admits nothing else
- **WHEN** the pane's HTML is served
- **THEN** its policy SHALL declare no `img-src`, no `font-src` and no `connect-src`
- **AND** the page SHALL be unable to issue a network request

#### Scenario: Keyboard reach
- **WHEN** the user moves focus into the pane with the keyboard
- **THEN** the commit list SHALL take one tab stop
- **AND** the arrow keys SHALL move focus within it
- **AND** the control that loads more commits SHALL be reachable without a pointer

#### Scenario: State is never carried by colour alone
- **WHEN** the pane is rendered in a high-contrast theme
- **THEN** every marked state, including an unpushed commit, SHALL carry a word or a glyph as well
  as a colour

#### Scenario: An unrecognised message from the page
- **WHEN** the page posts a message that is not in the known set — for example one stored by an
  older build
- **THEN** the system SHALL ignore it and log it
- **AND** SHALL NOT act on it

---

### Requirement: The pane SHALL write nothing and SHALL reach the network on no path

The only git subcommands this capability runs are `log` and `diff-tree`, both preceded by
`--no-optional-locks`. The system SHALL run nothing else on behalf of the pane.

#### Scenario: The subcommand set is closed
- **WHEN** the extension's log is read after a session of browsing history
- **THEN** every git invocation made by the pane SHALL be `log` or `diff-tree`
- **AND** each SHALL carry `--no-optional-locks` before the subcommand

#### Scenario: Nothing the pane does changes a repository
- **WHEN** any pane action is taken — selecting a repository, paging, expanding a commit, choosing
  another parent of a merge, opening a file
- **THEN** no ref, index, object or configuration file in any repository SHALL be written

#### Scenario: Reading history fires no watcher
- **WHEN** a page or an expansion is read
- **THEN** no file the extension watches SHALL be modified by that read
- **AND** the read SHALL NOT cause another pass to be scheduled

---

## Open against design

- **The in-flight state of a page after the first.** D49 decides the first page's loading state and
  D48 decides that a Load more control exists, but neither states what the pane shows while a
  *further* page is being read. Written here as the design implies — the fetched rows remain and the
  end of the list says more is being read — on the same rule D35 states for the list.
- **The in-flight state of an expansion.** D46 decides the process, the caps and every rendered
  outcome, but not what the expanded block shows between the click and the answer. Written here as a
  reading state inside the block, again by D35's rule.
- **Retry on a failed page or expansion.** D15 grants a timed-out *row* a retry and D48 requires a
  failed page to be stated with its command, but no decision grants the pane itself a retry
  affordance. Written here as one, because a stated failure with no way to ask again leaves the pane
  dead until the selection is changed and changed back.
- **Neither paging setting is in the manifest yet.** D48 names both —
  `multirepoLedger.history.pageSize` and `multirepoLedger.history.maxRetainedCommits` — and `package.json`
  contributes neither. They are referred to here by their function as well as their id, and the
  manifest work belongs in `tasks.md`, which schedules it in the phase that needs them.
