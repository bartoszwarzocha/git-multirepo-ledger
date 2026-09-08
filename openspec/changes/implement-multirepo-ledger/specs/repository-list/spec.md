# Spec: repository-list

Traces to: D21 (the list is a webview), D22 (rendered once per generation, patched per repository),
D23 (the three lines, field by field), D24 (the evidence age is the field that yields), D25
(relative dates computed here), D26 (divergence renders nothing at zero), D27 (dirty glyphs, never
a number), D28 (compact folds the row), D29 (a closed state set, no score), D30 (the tally header
is a row of filters), D31 (default sort is most-recently-committed), D32 (a row moves at most once
per generation), D33 (two filters that compose), D34 (selection by path, never automatic), D35
(before, between and instead of answers), D36 (themed from variables, reachable without a mouse).

Also constrained by: D6 (the index cap is stated on the list), D9 (worktree and submodule rows),
D10 (the directory budget is stated on the list), D14 (dirty state is an opt-in second tier), D18
(`checked`, never "up to date"), D19 (dubious ownership), D20 (every degenerate repository has a
stated row), D51 (the row's hand-offs are reachable from the list), D57 (a review count is a fact
or it is silence), D63 (the list is populated by discovery, not by the read).

---

## ADDED Requirements

### Requirement: The list is a webview populated by discovery before any git process answers

The system SHALL render the repository list in the `multirepoLedger.repositories` webview view, and
SHALL render a row for every repository discovery has named before any git process has answered.

The page SHALL be assigned once per generation — a fresh discovery, a sort change, a filter change
or a theme-driven reload — and every change after that SHALL be delivered as a patch addressed to
one repository's row. A row that changes SHALL NOT cause any other row to be re-rendered.

#### Scenario: Rows exist before the first git answer
- **WHEN** discovery names twelve repositories and no row read has completed
- **THEN** the list SHALL show twelve rows, each carrying its repository's real name
- **AND** no row SHALL be blank

#### Scenario: An arriving answer touches one row
- **WHEN** the reader has scrolled the list and one repository's row read completes
- **THEN** only that repository's row SHALL change
- **AND** the scroll position SHALL be unchanged
- **AND** the row that had keyboard focus SHALL still have it

#### Scenario: A sort change re-renders the page
- **WHEN** the reader changes the sort mode
- **THEN** the page SHALL be assigned once
- **AND** the previously selected repository SHALL still be selected

---

### Requirement: Each row renders three lines in a fixed field order

The system SHALL render each repository as three lines:

- **Line 1** — the repository name, then the divergence figure, then the dirty glyphs, then the
  evidence-age caption, dimmed and trailing.
- **Line 2** — the last commit's relative date, then its subject.
- **Line 3** — the HEAD state, then the repository-kind marker, then the review count.

The name SHALL be the repository directory's base name. When two repositories on the board share a
base name, each of their rows SHALL render the nearest distinguishing ancestor segment ahead of the
name, dimmed.

The kind marker SHALL render only when the repository is not an ordinary one, and SHALL be one of
`worktree`, `submodule`, `bare` or `shallow`.

The subject SHALL truncate at its end, never in its middle, and the row's tooltip SHALL carry the
full subject.

The row SHALL NOT render a branch count anywhere.

#### Scenario: An ordinary repository
- **WHEN** a repository is on `main`, two commits ahead of its upstream, and its last commit was
  three hours ago with the subject `fix: correct the offset in the parser`
- **THEN** line 1 SHALL read the name, then `↑2`, then the dirty glyphs, then the dimmed evidence age
- **AND** line 2 SHALL read `3h ago` followed by `fix: correct the offset in the parser`
- **AND** line 3 SHALL read `main`
- **AND** line 3 SHALL NOT carry a kind marker

#### Scenario: Two repositories share a base name
- **WHEN** the board holds `client/api` and `server/api`
- **THEN** each of the two rows SHALL render its distinguishing ancestor segment ahead of `api`,
  dimmed
- **AND** no other row SHALL gain a path segment

#### Scenario: A subject longer than the slot
- **WHEN** a commit subject does not fit the width available to it
- **THEN** the subject SHALL be truncated at its end
- **AND** the tooltip SHALL carry the whole subject
- **AND** the relative date beside it SHALL NOT be truncated

#### Scenario: A linked worktree
- **WHEN** a discovered repository is a linked worktree
- **THEN** its row SHALL carry the marker `worktree` on line 3
- **AND** it SHALL be a row of its own, not folded into the repository whose object store it shares

---

### Requirement: Text taken from a repository is escaped, isolated and stripped of control characters

Every field whose text comes from a repository — the name, the commit subject, a ref name, a remote
host — SHALL be HTML-escaped on its way into the page, SHALL be wrapped so that a bidirectional
override inside it cannot reorder anything outside it, and SHALL have C0 and C1 control characters
replaced with U+FFFD.

#### Scenario: A subject containing markup
- **WHEN** a commit subject is `fix <script>alert(1)</script> handling`
- **THEN** the row SHALL display that text
- **AND** no script SHALL run in the page

#### Scenario: A subject containing a bidirectional override
- **WHEN** a commit subject contains U+202E
- **THEN** the visual order of every field outside that subject SHALL be unchanged
- **AND** no part of one row's text SHALL appear to belong to another row

---

### Requirement: The evidence age is the only field that disappears when the row is narrow

At widths where the row cannot carry every field, the system SHALL yield fields in this order: the
evidence-age caption is hidden entirely; then the commit subject truncates; then the HEAD state
truncates; the name truncates last and never disappears. The divergence figure, the dirty glyphs
and the kind marker SHALL NOT yield at any width.

The evidence-age caption SHALL be hidden rather than truncated.

The caption SHALL read `checked <relative age>` and SHALL NOT read "fetched", "in sync" or "up to
date". When the repository's git directory holds no `FETCH_HEAD`, the caption position SHALL be
empty at every width and the tooltip SHALL say why.

The threshold at which the caption is hidden SHALL be expressed as a function of the row's own
content and the theme's own font, and SHALL NOT be a pixel measurement taken from any particular
screen.

#### Scenario: The sidebar is dragged narrow
- **WHEN** the row cannot fit the name's minimum legible width, the fixed-width runs beside it and
  the evidence-age caption together
- **THEN** the caption SHALL NOT be rendered
- **AND** the divergence figure, the dirty glyphs and the kind marker SHALL still be rendered
- **AND** the caption SHALL NOT be rendered in a truncated form such as `checked 14mo…`

#### Scenario: The sidebar is dragged narrower still
- **WHEN** the row cannot fit the commit subject after the caption has been hidden
- **THEN** the subject SHALL truncate at its end
- **AND** the repository name SHALL still be rendered

#### Scenario: No fetch has ever been recorded
- **WHEN** a repository's git directory contains no `FETCH_HEAD`
- **THEN** the caption position SHALL be empty at full width
- **AND** the row SHALL NOT read `never checked`, `up to date` or `in sync`
- **AND** the tooltip SHALL state that there is no record of a fetch

---

### Requirement: Relative dates are computed by the extension, in English

The system SHALL format every relative date on the row from a unix timestamp, in English, and SHALL
NOT ask git to word a relative date.

A timestamp in the future SHALL render as `just now`. Every row's tooltip SHALL carry the absolute
local date and time of the commit.

The rendered wording SHALL be recomputed at the instant the nearest visible row's wording would
change, without any git process being spawned.

#### Scenario: Git speaks another language
- **WHEN** the machine's git emits localised output
- **THEN** line 2 SHALL still read `3d ago`, in English

#### Scenario: A committer date in the future
- **WHEN** a repository's last commit carries a timestamp later than now
- **THEN** line 2 SHALL read `just now`
- **AND** the tooltip SHALL carry the absolute local timestamp
- **AND** the row SHALL NOT read `in 3 days`

#### Scenario: The wording goes stale on its own
- **WHEN** a visible row reads `59m ago` and a minute passes with no file changing
- **THEN** the row SHALL read `1h ago`
- **AND** no git process SHALL have been spawned

---

### Requirement: Divergence renders nothing at zero, and its two non-numeric cases are words

The system SHALL render `↑<ahead> ↓<behind>` with the ahead figure first, SHALL render only the
non-zero half when one half is zero, and SHALL render nothing at all when both are zero.

When the branch has no upstream, the row SHALL render the dimmed words `no upstream` in place of a
figure. When the upstream is gone, the row SHALL render the dimmed word `gone`.

The row's tooltip SHALL state both figures as a sentence naming the upstream ref, so the arrows are
never the only channel.

#### Scenario: Two ahead and one behind
- **WHEN** the branch is two commits ahead and one behind its upstream
- **THEN** line 1 SHALL render `↑2 ↓1`
- **AND** the tooltip SHALL state that two commits here are not on the upstream and one commit on
  the upstream is not here

#### Scenario: In sync
- **WHEN** the branch is neither ahead nor behind
- **THEN** line 1 SHALL render nothing in the divergence position
- **AND** SHALL NOT render `↑0 ↓0`, `=` or a tick

#### Scenario: No upstream
- **WHEN** the checked-out branch has no upstream
- **THEN** line 1 SHALL render the dimmed words `no upstream`
- **AND** SHALL NOT render a divergence figure

#### Scenario: The upstream was deleted
- **WHEN** git reports the upstream as gone
- **THEN** line 1 SHALL render the dimmed word `gone`

---

### Requirement: Dirty state renders as glyphs, never as a number, and never as a zero

When the second-tier read is enabled, the system SHALL render `*` for working-tree changes, `+` for
staged changes and `!` for conflicts, and SHALL NOT render a count of changed files anywhere on the
row or in the header.

While the second-tier read is disabled, the dirty position SHALL be empty on every row and the
header SHALL state once that uncommitted changes are not being read.

While the second-tier read is enabled and a particular row's answer has not arrived, that row's
dirty position SHALL carry a dimmed placeholder rather than an empty slot or a zero.

#### Scenario: The second-tier read is off
- **WHEN** `multirepoLedger.dirtyState.enabled` is `false`
- **THEN** every row's dirty position SHALL be empty
- **AND** the header SHALL carry the dimmed sentence `Uncommitted changes are not being read.`

#### Scenario: The second-tier read is on and the answer has not landed
- **WHEN** the dirty read is enabled and a visible row's `status` has not returned
- **THEN** that row's dirty position SHALL carry a dimmed placeholder
- **AND** SHALL NOT carry `0`
- **AND** SHALL NOT be empty, which would read as clean

#### Scenario: Staged and unstaged changes together
- **WHEN** a repository has both working-tree and staged changes
- **THEN** line 1 SHALL render `*` and `+`
- **AND** SHALL NOT render a number

---

### Requirement: Compact density folds the row and removes nothing

The system SHALL offer `multirepoLedger.rowDensity` with the values `comfortable` (default, three lines)
and `compact`. In `compact` the system SHALL merge lines 1 and 3 into one line — name, divergence
and dirty glyphs leading, HEAD state, kind marker and review count dimmed and trailing — and SHALL
leave line 2 unchanged.

No field SHALL be removed in `compact`. The system SHALL NOT change density on its own for any
repository count.

The view SHALL offer a toggle that writes the setting, so the choice survives a window reload.

#### Scenario: Compact
- **WHEN** `multirepoLedger.rowDensity` is `compact`
- **THEN** each row SHALL occupy two lines
- **AND** the HEAD state and kind marker SHALL be rendered, dimmed, on the merged line
- **AND** line 2 SHALL still carry the relative date and the subject

#### Scenario: A mid-rebase repository in compact
- **WHEN** the density is `compact` and a repository is mid-rebase
- **THEN** its row SHALL still state the rebase

#### Scenario: Density does not change underneath the reader
- **WHEN** a background scan discovers a further repository
- **THEN** the density SHALL be unchanged

#### Scenario: The choice survives a reload
- **WHEN** the reader toggles density and reloads the window
- **THEN** the chosen density SHALL still be in effect

---

### Requirement: Every row carries a set drawn from a closed state vocabulary, and no score

The system SHALL compute, for each repository, a set drawn from exactly this vocabulary: `clean`,
`dirty`, `unpushed`, `behind`, `detached`, `mid-operation`, `no-upstream`, `unreadable`. A
repository SHALL be able to carry more than one of them at once.

The system SHALL NOT render a composite health score, a percentage, a grade or a traffic light for
any repository or for the board.

Every state SHALL be rendered with a word or a glyph and SHALL NOT be signalled by colour alone.

#### Scenario: A repository in several states at once
- **WHEN** a repository has uncommitted changes, is behind its upstream and has a detached HEAD
- **THEN** it SHALL be counted under each of `dirty`, `behind` and `detached`
- **AND** each of those facts SHALL be legible from the row's own text or glyphs

#### Scenario: No score anywhere
- **WHEN** any repository is rendered
- **THEN** neither the row nor the header SHALL carry a percentage, a score or a traffic light

#### Scenario: A high-contrast theme
- **WHEN** the editor is using a high-contrast theme that flattens colour
- **THEN** every state a row carries SHALL still be readable from a word or a glyph

---

### Requirement: The tally header is a row of clickable filter chips

Above the list the system SHALL render one chip per state that has earned one, and clicking a chip
SHALL filter the list to exactly the repositories in that state. Clicking the active chip SHALL
clear the filter.

Chips SHALL be rendered for `unpushed` (leading), `behind`, `dirty` (only while the second-tier read
is enabled), `mid-operation` and `unreadable`. Chips SHALL NOT be rendered for `detached`,
`no-upstream` or `clean`.

A chip's accessible label and tooltip SHALL be the full sentence the chip abbreviates. While a
filter is active, that sentence SHALL be printed under the chips on its own line.

A chip whose count is zero SHALL NOT be rendered. A chip whose count the system has not established
SHALL NOT be rendered.

No chip's sentence SHALL assert more than a local read establishes. In particular the `unpushed`
sentence SHALL be worded against the remote-tracking refs on this machine and SHALL NOT claim that
the commits exist nowhere else: the ahead figure is measured against a ref that is only as fresh as
the last fetch, so a user who pushed from a second clone has a stale remote-tracking ref and a row
that reads ahead. The `behind` sentence SHALL be worded the same way.

While any repository in the current generation has been discovered and has not answered, the header
SHALL render, dimmed and beside the chips, how many of the discovered repositories have answered,
and the sentence under an active filter SHALL carry it too. A chip computed from part of the board
is a lower bound, and a lower bound rendered as a settled count is the failure this project exists
to avoid. When the generation completes that qualifier SHALL disappear and the chips SHALL be
counts.

When no chip has a count, the header SHALL render one sentence naming what was checked rather than
rendering blank.

#### Scenario: Three repositories have unpushed commits
- **WHEN** three of twenty repositories carry commits that are not on their upstream, and all twenty
  have answered
- **THEN** the header SHALL render a chip reading `↑3 unpushed`
- **AND** its accessible label SHALL read `3 repositories have commits that are not on the
  remote-tracking refs on this machine`
- **AND** it SHALL NOT read that those commits exist only on this machine
- **AND** clicking it SHALL leave exactly those three rows in the list
- **AND** that sentence SHALL be printed under the chips while the filter is active

#### Scenario: Chips while the board is still being read
- **WHEN** discovery has named two hundred repositories, ten have answered and three of those ten
  are unpushed
- **THEN** the header SHALL render `↑3 unpushed`
- **AND** it SHALL render, dimmed and beside the chips, that ten of two hundred have been read
- **AND** the chips SHALL NOT be suppressed while the generation is incomplete

#### Scenario: The qualifier goes when the generation completes
- **WHEN** every discovered repository in the generation has answered or has taken a stated
  unreadable state
- **THEN** the read-so-far qualifier SHALL NOT be rendered
- **AND** each chip's count SHALL be the count for the whole board

#### Scenario: Clicking the active chip clears the filter
- **WHEN** the `unpushed` filter is active and its chip is clicked again
- **THEN** every repository SHALL be shown again
- **AND** the sentence under the chips SHALL be removed

#### Scenario: A single mid-operation repository
- **WHEN** exactly one repository is mid-rebase and no other repository is mid-operation
- **THEN** the chip SHALL name the operation, as `1 rebasing`

#### Scenario: A state that earns no chip
- **WHEN** four repositories have a detached HEAD and three have no upstream
- **THEN** the header SHALL NOT render a chip for either state

#### Scenario: Nothing to report
- **WHEN** no repository is unpushed, behind, mid-operation or unreadable
- **THEN** the header SHALL render `Nothing here is unpushed, behind or unreadable.`
- **AND** SHALL NOT render blank
- **AND** SHALL append, dimmed, `Uncommitted changes are not being read.` while the second-tier read
  is disabled

---

### Requirement: A count the system has not established never renders as zero

The system SHALL render a zero only where it has established that the answer is zero. Wherever a
count is unknown, not yet asked for, or could not be obtained, the system SHALL render a
placeholder, a stated reason, or nothing at all.

#### Scenario: A dirty count that has not been asked for
- **WHEN** the second-tier read is disabled
- **THEN** no row SHALL render `0` in the dirty position
- **AND** no `dirty` chip SHALL render `0 dirty`

#### Scenario: A review count that could not be obtained
- **WHEN** the forge layer is enabled and the query for a repository's owner failed
- **THEN** that row SHALL render the dimmed reason for the failure
- **AND** SHALL NOT render `0 PR` or `0 MR`

#### Scenario: A review count that was established as zero
- **WHEN** the forge layer is enabled and the query succeeded and covered this repository, and it
  has no open pull requests
- **THEN** the row SHALL render `0 PR`

#### Scenario: The visible-of-discovered figure
- **WHEN** a filter is active
- **THEN** the header SHALL render `showing N of M`, where `M` is the number of repositories
  discovery found

---

### Requirement: Four sort modes, most recently committed by default, applied in three ranks

The system SHALL offer the sort modes `recent` (HEAD's committer date, newest first), `name` (base
name), `divergence` (ahead plus behind, descending, ties broken by ahead descending) and `dirty`.
The default SHALL be `recent`.

The `dirty` mode SHALL order by a rank read off the glyphs the row already shows — `!` above `*`
with `+` above `*` alone above `+` alone above clean — and SHALL NOT order by the count of dirty
entries, which the row deliberately never renders. Ordering a board by a number nothing on it shows
leaves two rows both bearing `*` in an order the reader cannot account for.

Every mode SHALL order repositories in three ranks: repositories that have a key for the mode,
ordered by that key; then repositories that have no key for the mode, ordered by path; then
unreadable repositories, ordered by path.

Every mode SHALL break ties on the case-folded absolute path, so two passes over identical data
produce identical order.

Selecting `dirty` SHALL enable the second-tier read if it is disabled, SHALL say so, and SHALL for
as long as that mode is selected run the read for **every discovered repository** rather than for
the visible rows alone. Under the three-rank rule a repository with no dirty answer has no key and
sorts below every answered row, so with the visible-rows restriction in force it would never become
visible, never be read and never acquire a key — the mode would order the first screenful and freeze
the rest of the board permanently. The view SHALL state that cost where the mode is chosen.

The sort mode SHALL persist for the window and SHALL NOT be written to the user's settings file.

#### Scenario: The default ordering
- **WHEN** the list first renders and every row has answered
- **THEN** the repository whose HEAD commit is newest SHALL be first

#### Scenario: A repository with no commits does not sort as zero
- **WHEN** the mode is `recent` and one repository has no commits
- **THEN** that repository SHALL NOT appear above repositories that do have a committer date
- **AND** it SHALL appear in the group of repositories that have no key for this mode
- **AND** its own text SHALL state that it has no commits

#### Scenario: A repository with no upstream under the divergence mode
- **WHEN** the mode is `divergence` and a repository has no upstream
- **THEN** it SHALL appear in the no-key group and SHALL NOT be ordered as though it were `↑0 ↓0`

#### Scenario: Unreadable repositories are last
- **WHEN** any mode is active and one repository is unreadable
- **THEN** it SHALL appear after every readable repository
- **AND** it SHALL remain reachable in one click from the `unreadable` chip

#### Scenario: Selecting the dirty mode with the read disabled
- **WHEN** the reader selects the `dirty` mode while `multirepoLedger.dirtyState.enabled` is `false`
- **THEN** the second-tier read SHALL be enabled
- **AND** the view SHALL state that it has been enabled

#### Scenario: The dirty mode reads the whole board, not the screenful
- **WHEN** the `dirty` mode is selected on a board of two hundred repositories showing twenty rows
- **THEN** `git status` SHALL be spawned for all two hundred rather than for the twenty on screen
- **AND** the view SHALL state that this mode reads every repository
- **AND** a repository that was never on screen SHALL still take its place in the order

#### Scenario: The dirty order is legible from the rows
- **WHEN** the `dirty` mode is active and one repository has conflicts while another has only
  working-tree changes
- **THEN** the repository carrying `!` SHALL be ordered above the one carrying `*`
- **AND** neither row SHALL render a count of changed files

#### Scenario: The mode is not a preference on disk
- **WHEN** the reader selects `divergence` and reloads the window
- **THEN** `divergence` SHALL still be in effect
- **AND** the user's `settings.json` SHALL be unmodified

---

### Requirement: A row changes position at most once per generation, and never under the pointer or a focused row

While a generation's answers are arriving, the system SHALL move a row at most once — at the moment
its answer arrives and it leaves the no-key group for its place under the current mode. Until then
the row SHALL be visible in the no-key group.

The system SHALL NOT re-order the list while the pointer is inside the list or while any row holds
keyboard focus. A pending re-order SHALL be queued and applied when the pointer leaves and no row
holds focus.

Scroll position and the focused row SHALL survive every re-order.

The system SHALL NOT hold the list back until every repository has answered, and SHALL NOT use a
settle timer to decide when to re-order.

#### Scenario: Twenty answers arrive
- **WHEN** twenty repositories are read over several seconds under the `recent` mode
- **THEN** each row SHALL change position at most once
- **AND** every row SHALL be visible throughout

#### Scenario: The pointer is in the list
- **WHEN** an answer arrives that would re-order the list and the pointer is inside the list
- **THEN** no row SHALL move
- **AND** the re-order SHALL be applied when the pointer leaves the list

#### Scenario: A row has keyboard focus
- **WHEN** an answer arrives that would re-order the list and a row holds keyboard focus
- **THEN** no row SHALL move
- **AND** after the list loses focus and re-orders, focus SHALL still identify the same repository

#### Scenario: One slow repository does not hold the board
- **WHEN** one repository sits on an unreachable network share and nineteen answer promptly
- **THEN** the nineteen SHALL be rendered in their places
- **AND** the twentieth SHALL remain visible in the no-key group with its own reading state

---

### Requirement: The state filter and the text filter compose

The system SHALL offer a state filter, set and cleared by a header chip, and a text filter typed
into the header. The text filter SHALL be a case-insensitive substring match against the repository
name, the last commit's subject, and the rendered text of line 3. The two filters SHALL compose with
AND.

While either filter is active the header SHALL render `showing N of M`.

An empty result SHALL render a sentence naming the filter that produced it, together with the
control that clears it, and SHALL NOT render a blank list.

`multirepoLedger.exclude` SHALL NOT be presented as a filter: an excluded repository SHALL NOT be walked,
read, counted in any tally, or included in `M`.

#### Scenario: Text matching line 3
- **WHEN** the reader types `rebasing`
- **THEN** the rows whose line 3 states a rebase SHALL be shown
- **AND** rows that do not match SHALL be hidden

#### Scenario: Text matching a subject
- **WHEN** the reader types `parser` and one repository's last commit subject contains it
- **THEN** that repository's row SHALL be shown

#### Scenario: Both filters at once
- **WHEN** the `unpushed` chip is active and the reader types `api`
- **THEN** only unpushed repositories whose name, subject or line 3 contains `api` SHALL be shown
- **AND** the header SHALL render `showing N of M`

#### Scenario: An empty result
- **WHEN** a text filter matches no repository
- **THEN** the list SHALL render a sentence naming the text that matched nothing
- **AND** SHALL offer the same control that set the filter as the way to clear it

#### Scenario: An excluded repository
- **WHEN** a repository's absolute path is listed in `multirepoLedger.exclude`
- **THEN** it SHALL NOT appear in the list under any filter
- **AND** it SHALL NOT be included in `M`
- **AND** it SHALL NOT be counted by any header chip

---

### Requirement: Selection is by path and is never made on the system's own initiative

The list SHALL have at most one selected row, identified by absolute path, and the selection SHALL
drive the history pane.

The system SHALL NOT select a row automatically. The previous selection SHALL be restored from
window state only when the history view first becomes visible.

Arrow keys SHALL move focus without changing the selection; Enter or Space SHALL select the focused
row.

The selection SHALL survive a re-order, a filter change and a rescan.

#### Scenario: The view opens
- **WHEN** the list first renders after activation
- **THEN** no row SHALL be selected
- **AND** no `git log` process SHALL be spawned

#### Scenario: A collapsed history pane costs nothing
- **WHEN** the window is reopened with the history view collapsed
- **THEN** the previous selection SHALL NOT cause a read until the history view becomes visible

#### Scenario: Arrowing through the list
- **WHEN** the reader moves focus down five rows with the arrow keys
- **THEN** the selection SHALL be unchanged
- **AND** no process SHALL be spawned

#### Scenario: The selection survives a re-order
- **WHEN** a row is selected and the sort mode changes
- **THEN** the same repository SHALL still be selected in its new position

---

### Requirement: Loading, between-generation and empty states are stated, never blank

The system SHALL render each of the following as a stated condition:

- **A repository discovery has named whose read has not returned** — its real name on line 1,
  `reading…` on line 2, nothing on line 3, positioned in the no-key group.
- **Discovery still walking with nothing found yet** — an indeterminate busy indicator that honours
  `prefers-reduced-motion`, with the text `Looking for repositories…`.
- **A new generation in flight** — the previous generation's rows remain, dimmed, beneath the busy
  indicator, rather than being replaced by a spinner.
- **No repository found** — an explanatory message stating that repositories are discovered at any
  depth beneath the open folders and offering the additional-roots setting and a refresh.
- **No folder open and no additional root configured** — an explanatory message offering to open a
  folder and to configure additional roots.

These messages SHALL be rendered by the list itself and SHALL NOT depend on `viewsWelcome`, which
renders only for an empty tree view. Their controls SHALL act by posting a message to the extension
rather than by navigating the page.

#### Scenario: Before the first git answer
- **WHEN** discovery has named a repository and its read has not returned
- **THEN** line 1 SHALL carry the repository's name
- **AND** line 2 SHALL read `reading…`
- **AND** the row SHALL NOT be blank and SHALL NOT be omitted

#### Scenario: Walking with nothing found
- **WHEN** the walk is in progress and no repository has been found
- **THEN** the view SHALL show an indeterminate busy indicator and `Looking for repositories…`
- **AND** the indicator SHALL not animate when the reader has asked for reduced motion

#### Scenario: A refresh over an existing board
- **WHEN** the reader invokes Refresh while twenty rows are on screen
- **THEN** those twenty rows SHALL remain visible, dimmed, under the busy indicator
- **AND** they SHALL NOT be replaced by a spinner

#### Scenario: Nothing found
- **WHEN** discovery completes and finds no repository
- **THEN** the list SHALL state that nothing with a `.git` was found
- **AND** SHALL offer a control that opens the additional-roots setting
- **AND** SHALL offer a control that refreshes

#### Scenario: No folder and no configured root
- **WHEN** no workspace folder is open and `multirepoLedger.additionalRoots` is empty
- **THEN** the list SHALL state that there is nothing to scan
- **AND** SHALL offer a control to open a folder and a control to configure additional roots

---

### Requirement: Every degenerate repository has a stated row

The system SHALL render a row for every discovered repository, whatever state it is in, and SHALL
NOT remove a repository from the list because it could not be read.

| Repository | What the row states |
|---|---|
| No commits on the checked-out branch | line 3 reads `<branch>` alone; line 2 reads `no commits yet`, never a date and never blank |
| Detached HEAD | line 3 reads `detached at <short id>` |
| Mid-merge, rebase, cherry-pick, revert, bisect or `am` | line 3 states the operation in place of the branch, as `rebasing <branch> <step>/<total>` |
| No remote, or no upstream | line 1 renders the dimmed words `no upstream` and no divergence figure |
| Bare | line 3 carries the marker `bare`; the row offers no action that assumes a working tree |
| Shallow | line 3 carries the marker `shallow` |
| Nested inside another repository | a linked worktree is its own row marked `worktree`; a submodule is its own row marked `submodule`, and only while `multirepoLedger.includeSubmodules` is enabled |
| Git refused it for dubious ownership | line 2 reads `not readable — git refused: dubious ownership` with the path, and the row offers to copy git's own remedy |
| It did not answer within the per-process timeout | line 2 reads `did not answer in 10 s` and the row offers Retry |

Each of the last two SHALL join the `unreadable` set, SHALL be counted by the `unreadable` chip, and
SHALL sort last.

#### Scenario: A repository with no commits
- **WHEN** `HEAD` names the branch `main`, which has no commits
- **THEN** line 3 SHALL read `main`
- **AND** line 2 SHALL read `no commits yet`, rather than being blank or carrying a date
- **AND** line 3 SHALL NOT also carry those words
- **AND** the row SHALL NOT be ordered as though its commit date were zero

#### Scenario: A repository mid-rebase
- **WHEN** a repository is stopped at step 1 of 3 of a rebase of `main`
- **THEN** line 3 SHALL read `rebasing main 1/3`
- **AND** SHALL NOT read `detached at <short id>`

#### Scenario: A bare repository
- **WHEN** a discovered repository is bare
- **THEN** line 3 SHALL carry the marker `bare`
- **AND** the dirty position SHALL be empty even while the second-tier read is enabled, with the
  tooltip stating that there is no working tree
- **AND** no `status` process SHALL be spawned for it

#### Scenario: A repository git refuses
- **WHEN** git exits reporting dubious ownership for a repository's path
- **THEN** line 2 SHALL read `not readable — git refused: dubious ownership` with the path
- **AND** the row SHALL offer to copy `git config --global --add safe.directory <path>`
- **AND** the view SHALL NOT offer to add the exception itself
- **AND** the row SHALL be counted by the `unreadable` chip

#### Scenario: A repository that never answers
- **WHEN** a repository's row read exceeds the per-process timeout
- **THEN** the row SHALL remain with its name
- **AND** line 2 SHALL state that it did not answer
- **AND** the row SHALL offer Retry
- **AND** the row SHALL NOT be removed and SHALL NOT render a zero

---

### Requirement: Degenerate environments are stated once for the board, not per row

When `git` is not on `PATH`, the system SHALL render one explanation for the whole board and SHALL
NOT render a state, a divergence figure, a commit date or a count for any repository.

When `gh` or `glab` is absent, or the host a repository points at is not signed in, the affected
rows SHALL carry a dimmed reason in the review-count position and SHALL NOT carry a count.

When the filesystem is slow or a root is unreachable, the list SHALL render each repository as its
answer resolves and SHALL NOT wait for the slowest.

#### Scenario: No git on PATH
- **WHEN** `git --version` cannot be run
- **THEN** the view SHALL state once that `git` was not found on `PATH`
- **AND** SHALL NOT render a divergence figure, a dirty glyph, a commit date or a count for any
  repository
- **AND** SHALL NOT invent rows

#### Scenario: The forge CLI is not installed
- **WHEN** the forge layer is enabled and `gh` is not installed
- **THEN** the affected rows SHALL render the dimmed reason `gh not installed`
- **AND** SHALL NOT render `0 PR`

#### Scenario: A host that is not signed in
- **WHEN** the forge layer is enabled and the CLI is not authenticated for `github.example.com`
- **THEN** the rows whose remote points at that host SHALL render the dimmed reason
  `github.example.com not signed in`
- **AND** rows on a host that did answer SHALL be unaffected

#### Scenario: An unreachable root
- **WHEN** one configured root is on an unreachable network share
- **THEN** the repositories found under the reachable roots SHALL be rendered
- **AND** the view SHALL state the condition rather than rendering an empty list

---

### Requirement: The list states when it may be incomplete

When a guard stops discovery short of the whole of a root, the system SHALL state that on the list
as well as recording it in the log.

#### Scenario: The index result cap is reached
- **WHEN** an editor-index pass returns as many results as its cap allows
- **THEN** the list SHALL state that the search stopped at a cap and that the board may be incomplete
- **AND** the count SHALL be written to the log

#### Scenario: The directory budget is reached
- **WHEN** the walk of a root visits as many directories as its budget allows
- **THEN** the list SHALL state that the walk stopped short of the whole of that root
- **AND** the log SHALL name the count and the first unsearched directory

---

### Requirement: The review count renders in four ways and never invents one

The system SHALL render the review-count position on line 3 as follows: nothing at all while the
forge layer is disabled; a dimmed pending marker while a query covering this repository is in
flight; the established count while a query has answered for it; and a dimmed reason otherwise.

The system SHALL use the word the forge uses — `PR` for a GitHub remote and `MR` for a GitLab one.

#### Scenario: The forge layer is off
- **WHEN** `multirepoLedger.forge.enabled` is `false`
- **THEN** no row SHALL render anything in the review-count position
- **AND** no placeholder, dash or empty bracket SHALL be rendered there

#### Scenario: A query in flight
- **WHEN** a batched query covering a repository's owner has been issued and has not returned
- **THEN** that row SHALL render a dimmed pending marker in the review-count position

#### Scenario: A GitLab remote
- **WHEN** a repository's remote points at a GitLab host and its query returned two open merge
  requests
- **THEN** the row SHALL render `2 MR`
- **AND** SHALL NOT render `2 PR`

---

### Requirement: The page is themed from editor variables, loads nothing external, and is reachable without a mouse

Every colour in the page SHALL come from a `--vscode-*` variable, and no state SHALL be conveyed by
colour alone.

The page SHALL declare a content security policy that admits no source other than its own nonced
style and script, SHALL load no image, font or remote resource, and SHALL be unable to make a
network request. Controls in the page SHALL act by posting a message to the extension rather than by
navigating.

Messages arriving from the page SHALL be validated against the known set of modes and actions before
being acted on, and an unrecognised message SHALL be ignored.

The list SHALL be a single stop in the tab order, with arrow keys moving within it, Enter or Space
selecting, and the menu key opening the focused row's actions. A hover-revealed inline action SHALL
NOT be in the tab order.

#### Scenario: Tabbing past the list
- **WHEN** the reader tabs from the header into the list and tabs again
- **THEN** focus SHALL leave the list after one further stop, whatever the number of rows

#### Scenario: The keyboard reaches a row's actions
- **WHEN** a row has focus and the reader presses the menu key
- **THEN** the same actions offered by the row's context menu SHALL be presented

#### Scenario: An unrecognised message
- **WHEN** the page posts a sort mode the extension does not recognise, as an older build's stored
  state would
- **THEN** the extension SHALL ignore it
- **AND** the current mode SHALL be unchanged

#### Scenario: Nothing is loaded from outside
- **WHEN** the list renders
- **THEN** the page SHALL request no image, font, stylesheet or script from any source other than
  its own nonced inline style and script

---

## Open against design

Three gaps found while writing this file. Each is specified above the way the design implies, and
each needs a decision recorded in `design.md` rather than left to the spec. Two others found here
have since been settled in the design and are recorded at the end of this list so the trail is
readable.

- **The evidence age in compact density.** D28 enumerates the fields on the merged line — name,
  divergence, dirty glyphs, HEAD state, kind marker, review count — and does not name the evidence
  age, while also stating that nothing is removed. This spec keeps the caption trailing and dimmed
  on the merged line, still the first field to yield under D24. D28 should say so.
- **The dirty position on a repository with no working tree.** D27 defines two states for the slot —
  nothing everywhere while the read is off, a dimmed placeholder while the read is on and the answer
  has not landed — and D14 never spawns the read for a bare repository, so under D27 as written such
  a row would hold a placeholder for the life of the window. This spec renders nothing there, with
  the reason in the tooltip.
- **The `mid-operation` chip label above a count of one.** D30 gives the wording only for the count
  of one, where the chip names the operation (`1 rebasing`). It does not give the wording for two or
  more repositories in different operations. This spec says the chip names the category and leaves
  the exact word to the design.

**Settled in the design since this file was written, and recorded so the trail is readable:**

- **Line 2 of a repository with no commits.** Two drafts rendered it two ways. D20 now settles it
  once — line 3 carries the branch name alone and line 2 carries `no commits yet` — and the table
  and the scenario above quote that form, as does `repository-read`.
- **The review count's pluralisation.** D23 wrote `2 PRs` where D57's table wrote `3 PR`. D23 now
  carries D57's unpluralised form and says why: it does not have to change shape at a count of one,
  so `1 PR`, `2 PR` and `0 PR` are one fixed-width run.
