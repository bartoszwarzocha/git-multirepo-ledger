# Spec: repository-read

Traces to: D8 (repository kind decided from files), D11 (the row read is one process), D12 (the read
is its own capability probe), D13 (the pinned child environment), D14 (dirty state is an opt-in
second read), D15 (derived concurrency and the two guards), D16 (generations and cancellation),
D17 (operation marker files), D18 (`FETCH_HEAD` proves an attempt), D19 (dubious ownership),
D20 (a stated row for every degenerate repository), D25 (unix timestamps, not git's words),
D26 (`no upstream` and `gone` are words, not zeros), D27 (dirty glyphs, never a count),
D30 (the header states what is not being read), D35 (before, between and instead of answers),
D41 (the subject is last), D63 (one `git --version` per session), D64 (the git directory is what is
watched), D65 (the closed set of subcommands)

---

## ADDED Requirements

### Requirement: The facts on a row are established by one git process per repository per refresh

The system SHALL establish, in a single `git for-each-ref` invocation per repository, all of: which
branch `HEAD` is on or that it is detached, the short object id of the commit `HEAD` points at, the
upstream ref's short name, the ahead/behind counts against that upstream, the commit's committer date
as a unix timestamp, and the commit's subject.

The format string SHALL be
`%(HEAD)%1f%(refname)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(contents:subject)`
in every command shape, so one parser reads every answer.

No further process SHALL be spawned to establish any of those facts.

#### Scenario: An ordinary repository with a branch checked out
- **WHEN** a repository has `main` checked out, tracking `origin/main`, two commits ahead
- **THEN** the system SHALL spawn exactly one `git` process for that repository
- **AND** the row SHALL carry `main`, the short object id, `origin/main`, `↑2`, the last commit's
  relative date and its subject
- **AND** no second process SHALL be spawned to obtain any of those fields

#### Scenario: A board of forty repositories
- **WHEN** forty repositories are discovered and `multirepoLedger.dirtyState.enabled` is `false`
- **THEN** a full refresh SHALL spawn forty `git` processes for the rows
- **AND** one further `git --version` process for the session, not one per repository

#### Scenario: A repository holding a thousand refs
- **WHEN** a repository has one thousand tags and branches and `main` is checked out
- **THEN** the read SHALL still be one process
- **AND** the read SHALL report only `HEAD`'s branch
- **AND** no branch count SHALL be established or rendered for any repository, whatever its ref count

---

### Requirement: The command shape is chosen by the `HEAD` file that has already been read

The system SHALL read the git directory's `HEAD` before spawning anything, and SHALL choose one of
three command shapes from it:

- **Case A**, `HEAD` contains `ref: refs/heads/<name>` —
  `git for-each-ref --format=<format> refs/heads/<name>`.
- **Case B**, `HEAD` contains a raw object id —
  `git for-each-ref --include-root-refs --format=<format> HEAD`.
- **Case C**, `HEAD` could not be read —
  `git for-each-ref --include-root-refs --format=<format> refs/heads/ HEAD`.

The pattern and the flag are load-bearing together: `HEAD` as a pattern without `--include-root-refs`
returns nothing, and `--include-root-refs` without a pattern also returns remote-tracking refs and
tags. The system SHALL NOT issue either broken shape.

The command is an optimisation over a file read; the command's own output is the authority. Cases A
and B return the refname, and the system SHALL take the refname from the output rather than from the
file.

#### Scenario: Attached HEAD scopes the read to one ref
- **WHEN** `HEAD` contains `ref: refs/heads/feature/parser`
- **THEN** the command SHALL name the pattern `refs/heads/feature/parser`
- **AND** SHALL NOT pass `--include-root-refs`
- **AND** the cost of the read SHALL NOT depend on how many other refs the repository holds

#### Scenario: Detached HEAD is read with the flag and the pattern together
- **WHEN** `HEAD` contains a raw object id
- **THEN** the command SHALL pass both `--include-root-refs` and the pattern `HEAD`
- **AND** the read SHALL return one record whose refname is `HEAD`
- **AND** SHALL NOT return an empty result

#### Scenario: The git directory cannot be read before the spawn
- **WHEN** `HEAD` cannot be opened — a permission wall, or a directory on a mount that is not
  answering
- **THEN** the system SHALL run case C rather than reporting the repository unreadable on the file
  read alone
- **AND** the row SHALL be filled from the command's output if the command succeeds

#### Scenario: Remote-tracking refs and tags are never mistaken for HEAD
- **WHEN** a repository has fifty remote-tracking refs and two hundred tags
- **THEN** no remote-tracking ref and no tag SHALL appear as the row's HEAD state, its branch or its
  subject

---

### Requirement: HEAD state is reported as a branch, a detached object id, or an unborn branch

The system SHALL distinguish three signatures in the read's output and SHALL report a different row
for each:

- a `refs/heads/*` record carrying `*` in `%(HEAD)` — that branch's name;
- a `HEAD` record carrying `*` and no branch carrying it — `detached at <short object id>`;
- zero records with exit code 0, where `HEAD` named a branch — that branch, with no commits.

A repository whose HEAD state is unborn SHALL NOT be given a commit date, a subject or an object id,
and SHALL NOT be reported as having committed at any time.

#### Scenario: A branch is checked out
- **WHEN** the read returns a `refs/heads/main` record whose `%(HEAD)` field is `*`
- **THEN** line 3 SHALL read `main`

#### Scenario: HEAD is detached
- **WHEN** the read returns a `HEAD` record whose `%(HEAD)` field is `*`, and no branch record carries
  `*`
- **THEN** line 3 SHALL read `detached at 7c86ebf`, using the short object id the read returned

#### Scenario: A repository with no commits
- **WHEN** `HEAD` names `refs/heads/main`, and the read returns zero records and exits 0
- **THEN** line 3 SHALL read `main` and line 2 SHALL read `no commits yet`
- **AND** line 2 SHALL NOT carry a date
- **AND** the repository SHALL NOT be ordered among repositories that have a last-commit date

#### Scenario: A linked worktree reports its own HEAD
- **WHEN** a linked worktree and the repository it was created from are both on the board, and each
  has a different branch checked out
- **THEN** each row SHALL report the branch checked out in its own working tree
- **AND** neither row SHALL report the other's branch as its HEAD state

---

### Requirement: A record is split on its first six separators, so a commit subject cannot shift a field

Fields are separated by `%1f` (U+001F) and records by a newline, and the subject is the last field.
The system SHALL split each record on the first six separators and take everything after the sixth as
the subject, so a subject containing a separator, a pipe, a percent sign or a parenthesis cannot move
another field.

`%(contents:subject)` folds a wrapped first paragraph onto one line, so a record occupies one line.

#### Scenario: A subject containing delimiters used by other tools
- **WHEN** the last commit's subject is `fix a|b parsing and %(weird) chars`
- **THEN** line 2 SHALL show that subject in full in the tooltip, and unaltered up to its truncation
- **AND** the upstream, divergence and date fields SHALL be unaffected

#### Scenario: A commit message whose first paragraph wraps
- **WHEN** the last commit's message begins with a paragraph spanning two lines
- **THEN** line 2 SHALL show those lines joined by a single space
- **AND** the output SHALL NOT be read as two records

---

### Requirement: The read asks git for a unix timestamp, never for a worded date

The system SHALL request `%(committerdate:unix)` and SHALL word the relative date itself. It SHALL
NOT request `%(committerdate:relative)` or pass `--date=relative` anywhere in the row read.

#### Scenario: A machine whose git speaks another language
- **WHEN** git on the machine is a build that translates its output, and the machine's locale is not
  English
- **THEN** the row's date SHALL read in English, for example `3d ago`
- **AND** the row SHALL NOT mix a translated date with English text

#### Scenario: A committer date in the future
- **WHEN** the last commit's committer date is three days ahead of the machine's clock
- **THEN** line 2 SHALL read `just now`
- **AND** the tooltip SHALL carry the absolute local date and time

---

### Requirement: Every git child runs in a pinned, non-interactive environment

The system SHALL spawn every git child with `LC_ALL=C`, an empty `LANGUAGE`, `GIT_OPTIONAL_LOCKS=0`
and `GIT_TERMINAL_PROMPT=0`, with no shell, with stdio piped, and with the window hidden.

#### Scenario: A translated git build
- **WHEN** git would otherwise emit `gone`, the ahead/behind wording, or a `fatal:` line in another
  language
- **THEN** the parsed fields SHALL be the same as on an English machine
- **AND** the row SHALL carry the same state it would carry there

#### Scenario: A read cannot block on a credential prompt
- **WHEN** any git child would otherwise ask for a username or a password
- **THEN** the child SHALL fail rather than wait
- **AND** the row SHALL report the failure rather than remaining in a reading state indefinitely

#### Scenario: The extension's own reads do not provoke another read
- **WHEN** a full refresh runs with the dirty read enabled, and the board is then left untouched
- **THEN** `.git/index` SHALL NOT be rewritten by the extension's reads
- **AND** the board SHALL NOT enter a repeating refresh driven by its own file events

#### Scenario: A repository path containing shell metacharacters
- **WHEN** a discovered repository's absolute path contains a space, an ampersand or a quotation mark
- **THEN** the read SHALL run in that directory and produce the same row as for any other path
- **AND** no part of the path SHALL be interpreted as a command

---

### Requirement: The `--include-root-refs` fallback is discovered by the read that needs it, and remembered for the session

`git for-each-ref` cannot run outside a repository, so there is nowhere to probe the flag that is not
already a repository read. The system SHALL therefore issue case B or case C as written and treat exit
code 129 with ``unknown option `include-root-refs'`` on stderr as the answer: it SHALL record for the
rest of the session that the flag is unavailable, and SHALL re-read that one repository with the
fallback shape.

- Detached HEAD, fallback: `git log -1 --format=%h%x1f%ct%x1f%s`. One process.
- Case C, fallback: `git for-each-ref --format=<format> refs/heads/` plus
  `git log -1 --format=%h%x1f%ct%x1f%s`. Two processes, and the only two-process path in the row read.

The system SHALL NOT parse `git --version` to decide whether the flag exists, and SHALL NOT run a
dedicated probe process before the board starts.

#### Scenario: The first detached read on an older git
- **WHEN** the first read that passes `--include-root-refs` exits 129 with
  ``unknown option `include-root-refs'``
- **THEN** that repository SHALL be re-read with `git log -1 --format=%h%x1f%ct%x1f%s`
- **AND** its row SHALL carry the short object id, the relative date and the subject
- **AND** its upstream and divergence fields SHALL be empty, because a detached HEAD has no upstream

#### Scenario: No repository pays the discovery twice
- **WHEN** the flag has already been found unavailable in this session
- **AND** a second repository with a detached HEAD is read
- **THEN** that read SHALL use the fallback shape directly
- **AND** SHALL NOT spawn a process that passes `--include-root-refs`

#### Scenario: A repository whose `HEAD` is unreadable on an older git
- **WHEN** case C runs on a git without the flag
- **THEN** that repository SHALL cost two processes, and no repository SHALL cost more

#### Scenario: A git that supports the flag is never asked to prove it
- **WHEN** every read that uses the flag succeeds
- **THEN** no additional process SHALL have been spawned to establish support
- **AND** repositories with an attached HEAD SHALL cost one process on any version of git, because
  case A never passes the flag

---

### Requirement: Repository kind, stopped operations, shallowness and evidence age cost no process

The system SHALL establish, from the filesystem alone: whether the repository is ordinary, a linked
worktree, a submodule, a repository with a separate git directory, or bare; whether it is shallow;
which operation, if any, it is stopped in the middle of; and when a fetch was last attempted.

The system SHALL NOT run `git rev-parse`, `git status` or any other process to establish any of them.

#### Scenario: A refresh of forty ordinary repositories
- **WHEN** forty repositories are read with the dirty read off
- **THEN** repository kind, shallowness, stopped-operation state and evidence age SHALL together cost
  zero processes
- **AND** the total SHALL be forty processes plus the one `git --version` for the session

#### Scenario: A bare repository
- **WHEN** a discovered directory holds `HEAD`, `config`, `objects/` and `refs/` and has no `.git`
- **THEN** the row SHALL carry the `bare` marker
- **AND** no `git status` process SHALL be spawned for it, because `status` there exits 128 with
  `fatal: this operation must be run in a work tree`

#### Scenario: A shallow repository
- **WHEN** `<gitdir>/shallow` exists
- **THEN** the row SHALL carry the `shallow` marker
- **AND** the marker SHALL cost no process

---

### Requirement: A stopped operation replaces the branch on line 3, and an unrecognised set of markers says nothing

The system SHALL read the git directory's operation markers and SHALL report the operation in place of
the HEAD state:

| Files under the git directory | Reported as |
|---|---|
| `MERGE_HEAD` | merging |
| `rebase-merge/` with `head-name`, `msgnum`, `end` | `rebasing <head-name> <msgnum>/<end>` |
| `rebase-apply/` without `applying` | rebasing |
| `rebase-apply/` with `applying` | applying patches |
| `CHERRY_PICK_HEAD` | cherry-picking |
| `REVERT_HEAD` | reverting |
| `BISECT_START` | bisecting |

`head-name` is the branch **being rebased**, not the branch being rebased onto. The system SHALL NOT
resolve `rebase-merge/onto`, which holds a raw object id, to a branch name; where the target is named
at all it SHALL be named by the short object id that was read.

None of these files is specified in `gitrepository-layout(5)`. Their absence SHALL be read as "not in
that state" and never as an error, and a combination the system does not recognise SHALL leave the row
showing the HEAD state it read.

#### Scenario: A repository stopped mid-rebase
- **WHEN** `rebase-merge/head-name` contains `refs/heads/main`, `msgnum` contains `1` and `end`
  contains `3`
- **THEN** line 3 SHALL read `rebasing main 1/3`
- **AND** line 3 SHALL NOT read `detached at <object id>`, although `HEAD` is detached during a rebase
- **AND** no process SHALL be spawned to establish it

#### Scenario: A repository stopped mid-merge
- **WHEN** `MERGE_HEAD` exists
- **THEN** line 3 SHALL report the repository as merging
- **AND** the state SHALL NOT be sought from `git status --porcelain=v2`, which does not report it

#### Scenario: A repository stopped mid-cherry-pick, mid-revert or mid-bisect
- **WHEN** `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `BISECT_START` exists
- **THEN** line 3 SHALL report cherry-picking, reverting or bisecting respectively

#### Scenario: An `am` in progress
- **WHEN** `rebase-apply/` exists and contains `applying`
- **THEN** line 3 SHALL report the repository as applying patches, not as rebasing

#### Scenario: The markers are not where they were expected
- **WHEN** a repository is mid-rebase in a git whose marker layout the system does not recognise
- **THEN** line 3 SHALL show the HEAD state that was read
- **AND** the row SHALL NOT be reported as unreadable, and no error SHALL be raised

---

### Requirement: The evidence age is reported only when `FETCH_HEAD` exists, and never as a claim about the remote

`<gitdir>/FETCH_HEAD`'s mtime records the last time a fetch **ran**. It does not prove the fetch
reached the remote, that anything changed, or that no fetch has ever happened: it is absent after a
fresh clone, it is touched on a no-op fetch, it is touched and truncated on a failed one, and it can
be suppressed with `--no-write-fetch-head`.

When the file exists the system SHALL render `checked <relative age>` and nothing stronger. When it is
absent the system SHALL render nothing in that position, and the tooltip SHALL say why. The strings
`up to date`, `in sync`, `fetched` and `never checked` SHALL NOT appear on a row.

The system SHALL NOT run `git fetch`, `git fetch --dry-run` or `git ls-remote` to freshen the caption.

#### Scenario: A repository that has been fetched
- **WHEN** `<gitdir>/FETCH_HEAD` exists with an mtime three hours old
- **THEN** line 1 SHALL carry the dimmed trailing caption `checked 3h ago`

#### Scenario: A freshly cloned repository
- **WHEN** a repository has been cloned and never fetched, so `FETCH_HEAD` does not exist
- **THEN** line 1 SHALL carry nothing in that position
- **AND** the row SHALL NOT read `never checked`, `up to date` or `in sync`
- **AND** the tooltip SHALL state that there is no record of a fetch to date the comparison from

#### Scenario: A fetch that failed
- **WHEN** the last fetch failed and left `FETCH_HEAD` present and zero bytes long
- **THEN** the caption SHALL still read `checked <age>`, which is the attempt it is evidence of
- **AND** the row SHALL make no claim that the comparison is current

#### Scenario: The caption is never bought with a network call
- **WHEN** the board refreshes
- **THEN** no `git fetch`, no `git fetch --dry-run` and no `git ls-remote` SHALL be spawned

---

### Requirement: An absent upstream, a zero divergence and an unestablished divergence are three different rows

The system SHALL distinguish, and SHALL render differently:

- `%(upstream:short)` empty — the branch has no upstream. Line 1 SHALL carry the dimmed words
  `no upstream` and SHALL NOT carry a divergence figure.
- `%(upstream:track,nobracket)` empty with an upstream present — ahead 0, behind 0. Line 1 SHALL carry
  nothing in the divergence position.
- `%(upstream:track,nobracket)` equal to `gone` — the upstream ref no longer exists. Line 1 SHALL
  carry the dimmed word `gone`.
- The read has not answered, or failed — nothing SHALL be rendered in the divergence position.

`↑0 ↓0` SHALL never be rendered, and a divergence figure SHALL never be rendered for a repository
whose read did not establish one.

#### Scenario: A branch with no upstream
- **WHEN** the read returns an empty `%(upstream:short)`
- **THEN** line 1 SHALL read `no upstream`
- **AND** SHALL NOT read `↑0 ↓0`, `=` or show a tick

#### Scenario: A branch in sync with its upstream
- **WHEN** the read returns `origin/main` and an empty track field
- **THEN** the divergence position SHALL be empty
- **AND** the board SHALL state once, in plain text rather than on each row, that divergence is
  measured against the remote-tracking refs on disk and is therefore as old as the last fetch

#### Scenario: The upstream branch was deleted
- **WHEN** the read returns `gone` in the track field
- **THEN** line 1 SHALL read `gone`

#### Scenario: A repository whose read failed renders no figure
- **WHEN** the read for a repository timed out
- **THEN** the divergence position SHALL be empty
- **AND** it SHALL NOT be filled with `↑0 ↓0`, nor with figures from the previous generation shown
  under the current one's caption

---

### Requirement: Uncommitted changes are a second read that ships off and is asked only for visible rows

The dirty read is `git --no-optional-locks status --porcelain=v2 --branch`. The system SHALL place
`--no-optional-locks` **before** the subcommand: written after it, git exits 129 with
``unknown option `no-optional-locks'`` and every dirty read fails.

It SHALL run only while `multirepoLedger.dirtyState.enabled` is `true`, only for repositories currently
visible in the list, and never for a repository with no working tree. It SHALL NOT pass
`--show-stash`, and it SHALL leave the untracked mode at its default, so an untracked directory is
reported once rather than per file.

Dirtiness SHALL render as `*`, `+` and `!` — the markers the built-in git extension already shows in
the same window — and never as a count.

#### Scenario: The default installation reads no working tree
- **WHEN** the extension is installed with default settings and the board refreshes
- **THEN** no `git status` process SHALL be spawned for any repository
- **AND** the dirty glyph position SHALL be empty on every row, uniformly
- **AND** the header SHALL state once that uncommitted changes are not being read, so an empty slot is
  not read as "clean"

#### Scenario: The read is enabled
- **WHEN** `multirepoLedger.dirtyState.enabled` is set to `true`
- **THEN** each visible repository SHALL be read with
  `git --no-optional-locks status --porcelain=v2 --branch`
- **AND** the option SHALL precede `status` in the argument list

#### Scenario: A row that is not on screen
- **WHEN** a board of two hundred repositories shows twenty rows and the rest are scrolled out of view
- **THEN** `git status` SHALL be spawned for the visible rows only
- **AND** scrolling a further row into view SHALL spawn its read then, and not before

#### Scenario: Between the two tiers, the glyph slot is not zero
- **WHEN** the dirty read is on, and a visible row's tier-one answer has landed but its `status`
  answer has not
- **THEN** that row's glyph position SHALL carry a dimmed placeholder
- **AND** SHALL NOT render `0`, and SHALL NOT render the row as clean

#### Scenario: A repository with no commits
- **WHEN** `git status --porcelain=v2 --branch` reports `# branch.oid (initial)` and exits 0
- **THEN** the row SHALL be treated as read successfully
- **AND** the repository SHALL NOT be reported as unreadable

#### Scenario: The repository moved between the two reads
- **WHEN** `# branch.oid` does not match the object id the tier-one read reported
- **THEN** the dirty answer SHALL be discarded
- **AND** the row SHALL be read again rather than patched with a dirty state belonging to another
  commit

#### Scenario: A repository with no working tree
- **WHEN** a repository is bare
- **THEN** no `git status` process SHALL be spawned for it, whether or not the setting is on

---

### Requirement: A repository that does not answer keeps its row, with its reason and its command

Every git child SHALL carry a per-process timeout and an output cap. A read that exceeds the timeout
SHALL produce a stated row, not a disappearance and not a blank; output beyond the cap SHALL be
reported as truncated rather than read as a complete answer.

The number of repository reads in flight SHALL be derived from `os.availableParallelism()`, clamped
between a floor and a ceiling, and SHALL be replaced entirely by `multirepoLedger.concurrency` when that
setting is greater than zero. No fixed concurrency measured on any machine SHALL be used.

#### Scenario: A repository on an unreachable mount
- **WHEN** a discovered repository sits on a network share that stops answering
- **THEN** its row SHALL read `did not answer in 10 s`
- **AND** the row SHALL carry the exact command that was run, and a Retry action
- **AND** every other row on the board SHALL complete normally

#### Scenario: A repository whose read produces pathological output
- **WHEN** a read produces more output than the cap
- **THEN** the result SHALL be reported as truncated
- **AND** SHALL NOT be parsed as though it were the whole answer

#### Scenario: Concurrency on a constrained machine
- **WHEN** the runtime reports one available CPU
- **THEN** the number of reads in flight SHALL be the floor rather than one
- **AND** a hundred repositories SHALL NOT be read one at a time

#### Scenario: The user overrides concurrency
- **WHEN** `multirepoLedger.concurrency` is set to `4`
- **THEN** no more than four repository reads SHALL be in flight at once

---

### Requirement: A repository git refuses for dubious ownership states the refusal and offers git's own remedy

When git exits 128 and its stderr names the config key `safe.directory`, the system SHALL report the
repository as `not readable — git refused: dubious ownership`, with the repository's path, and SHALL
offer to copy the command `git config --global --add safe.directory <path>`.

Detection SHALL key on the config key, which is not translated, and not on the English sentence around
it. The system SHALL NOT run that command, and SHALL NOT pass `-c safe.directory=<path>` in any
invocation of its own. There SHALL be no "trust this repository" action and no "trust all" setting.

#### Scenario: A repository whose ownership git does not trust
- **WHEN** the read exits 128 and stderr contains `safe.directory`
- **THEN** the row SHALL read `not readable — git refused: dubious ownership` and SHALL show the path
- **AND** an action SHALL copy `git config --global --add safe.directory <path>` to the clipboard
- **AND** the repository SHALL join the `unreadable` set, so it is counted in the header and reachable
  in one click

#### Scenario: The extension changes nothing on the user's behalf
- **WHEN** such a row has been rendered and its copy action has been used
- **THEN** the user's `safe.directory` configuration SHALL be unchanged
- **AND** no invocation of git by the extension SHALL pass `-c safe.directory`

#### Scenario: The refusal in another language
- **WHEN** git's refusal is emitted by a translated build
- **THEN** the state SHALL still be detected, because the config key appears in the message whatever
  the surrounding wording

#### Scenario: After the user runs the command themselves
- **WHEN** the user runs the copied command in their own shell and refreshes
- **THEN** the repository SHALL be read normally and SHALL carry an ordinary row

---

### Requirement: The row read depends on `git` alone, and its absence is one state for the whole board

The system SHALL establish once per session, with a single `git --version`, whether `git` is on
`PATH`. When it is not, the board SHALL carry one explained state, and no per-repository read SHALL be
attempted.

The row read SHALL NOT invoke `gh`, `glab` or any other external tool, and the presence, absence or
authentication state of those tools SHALL NOT change any fact on the row.

#### Scenario: git is not installed
- **WHEN** `git` is not on `PATH`
- **THEN** the board SHALL state that git was not found, once, for the whole board
- **AND** SHALL NOT spawn a `for-each-ref` process for any repository
- **AND** SHALL NOT invent rows, dates or divergence figures for the repositories discovery found

#### Scenario: git is present
- **WHEN** `git` is on `PATH`
- **THEN** exactly one `git --version` SHALL be spawned for the session
- **AND** it SHALL NOT be spawned again per repository or per refresh

#### Scenario: Neither `gh` nor `glab` is installed
- **WHEN** neither forge CLI exists on the machine
- **THEN** every local fact on every row SHALL be established exactly as it would be with them
  installed
- **AND** the row read SHALL spawn neither tool

#### Scenario: A forge CLI exists but is not authenticated
- **WHEN** `gh` is installed and is not logged in
- **THEN** the row read SHALL be unaffected and the row SHALL carry its local facts
- **AND** no review count SHALL be rendered as `0`

---

### Requirement: Any other refusal is reported in git's own words

When a read fails for a reason the system does not recognise, the row SHALL carry git's own first line
of stderr, verbatim, and the repository SHALL join the `unreadable` set. The row SHALL NOT be removed
from the board, and no field SHALL be filled with a zero to stand in for the missing answer.

#### Scenario: A corrupt or unreadable git directory
- **WHEN** case C is run because the prelude failed, and the command also fails
- **THEN** the row SHALL show git's first line of stderr as it was emitted
- **AND** the repository SHALL remain on the board with its name

#### Scenario: An unreadable repository is never silently dropped
- **WHEN** a repository cannot be read for any reason
- **THEN** it SHALL still occupy a row
- **AND** it SHALL be counted in the header's `unreadable` tally, so its existence is visible without
  reading the list

---

### Requirement: Rows exist before any git process answers, and a superseded answer is dropped

Discovery answers long before git does. Every discovered repository SHALL therefore have a row before
any read has answered: its real name on line 1, `reading…` on line 2, and nothing on line 3.

Every discovery-and-read pass SHALL carry a generation. A result arriving with a stale generation SHALL
be dropped at the boundary and SHALL NOT be merged into the current board.

#### Scenario: A cold start
- **WHEN** the extension has started, discovery has named forty repositories, and no read has answered
- **THEN** forty rows SHALL be rendered with their names
- **AND** each SHALL read `reading…` on line 2
- **AND** no row SHALL show a date, a divergence figure, a dirty glyph or a zero

#### Scenario: A refresh during a pass
- **WHEN** the user invokes Refresh while reads from the previous pass are still in flight
- **THEN** answers from the previous pass SHALL be discarded on arrival
- **AND** the board SHALL NOT show a mixture of rows from two passes

#### Scenario: Selecting a repository does not stop the board
- **WHEN** the user clicks a row while other repositories are still being read
- **THEN** the in-flight row reads SHALL continue
- **AND** the remaining rows SHALL be filled in as their answers land

#### Scenario: The window closes
- **WHEN** the view is disposed or the extension is deactivated
- **THEN** the current generation SHALL be aborted and every git child SHALL be killed
- **AND** no process SHALL outlive the window

---

### Requirement: A re-read is scoped to the repositories whose git directories changed

The system SHALL watch each repository's git directory and its reflog, never its working tree, and a
pass provoked by those events SHALL read only the repositories the events named. A workspace-folder
change, or a change to a setting that affects what is read, SHALL provoke a full pass.

Events SHALL be coalesced, and two passes SHALL NOT overlap: events arriving during a pass SHALL
schedule at most one further pass.

#### Scenario: A commit made in a terminal
- **WHEN** the user commits in one repository from an external terminal
- **THEN** that repository alone SHALL be re-read, at one process
- **AND** every other repository SHALL cost zero processes
- **AND** the row SHALL update without the user invoking Refresh

#### Scenario: Editing a file without committing
- **WHEN** a file in a repository's working tree is edited and not staged or committed
- **THEN** no row read SHALL be provoked by that edit

#### Scenario: A burst of writes
- **WHEN** a single `git commit` writes several files under the git directory
- **THEN** those writes SHALL collapse into one pass
- **AND** a repository being written to repeatedly SHALL NOT accumulate a queue of passes

#### Scenario: An event the watcher never sees
- **WHEN** a repository's reflog is disabled and a branch ref is updated in a way that fires no event
- **THEN** the row SHALL be brought up to date by the next event, by window focus, or by Refresh
- **AND** the board SHALL NOT be left permanently stale with nothing on screen to say so

---

### Requirement: The row read runs a closed set of subcommands, and writes nothing

The only git subcommands the row read may run are `--version`, `for-each-ref`, `status` and, on a git
without `--include-root-refs`, `log -1`. None of them writes to the repository and none of them
connects to a network.

#### Scenario: A full refresh changes nothing on disk
- **WHEN** a full refresh runs over every discovered repository with the dirty read enabled
- **THEN** no ref, no `FETCH_HEAD`, no index and no configuration file SHALL be modified by the
  extension
- **AND** no repository SHALL gain a `FETCH_HEAD` it did not have

#### Scenario: Nothing leaves the machine
- **WHEN** the row read runs with `multirepoLedger.forge.enabled` at its default of `false`
- **THEN** no network request SHALL be made by the extension
- **AND** no subcommand outside the closed set SHALL be spawned

---

## Open against design

- **A record the parser cannot split.** D11 fixes the field order and the `%1f` delimiter but does not
  say what happens to a record that does not split into seven fields. The requirement above takes
  D41's rule — the subject is last, so the split is on the first six separators — and applies it to
  the row read. What to do with a genuinely malformed record is undecided; the reading that matches
  D20 is that the repository joins the `unreadable` set rather than rendering a shifted field.
- **Two settings this capability depends on are not yet in the manifest.** D14 names
  `multirepoLedger.dirtyState.enabled` and D15 names `multirepoLedger.concurrency`; `package.json` declares
  neither. Both need a declaration, with a description stating what the setting costs, before this
  capability can be implemented as specified.
