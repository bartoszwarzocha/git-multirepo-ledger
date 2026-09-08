# Spec: repository-actions

Traces to: D51 (the hand-offs from a row), D52 (Source Control by name, never as a side effect),
D53 (the remote URL and the browser allowlist), D54 (no batch operation), D19 (dubious ownership,
and no trust button), D35 (before, between and instead of answers), D36 (keyboard and content
security policy), D1 (every judgement is a pure module), D63 (activation registers and returns),
D65 (every outbound path), D66 (two capability declarations, both refusals)

---

## ADDED Requirements

### Requirement: The action list for a row is decided before it is offered

The system SHALL decide which actions a row offers from facts already established at zero process
cost — the repository's absolute path, its kind, whether the built-in git extension is present, and
whether a remote can be named — and SHALL NOT offer an action it already knows cannot succeed.

An action that is offered and then fails puts the reader in the position of working out which of the
two things broke, so absence is decided as deliberately as presence.

Opening the action list SHALL NOT spawn a process.

#### Scenario: A bare repository is not offered a folder to open
- **WHEN** the user opens the actions for a row marked `bare`
- **THEN** the list SHALL NOT contain Open Folder in New Window
- **AND** the list SHALL contain Open in Terminal and Copy Path

#### Scenario: No remote means no browser action
- **WHEN** a repository has no remote that can be named
- **THEN** the list SHALL NOT contain Open Remote in Browser
- **AND** no disabled placeholder for it SHALL be rendered in its place

#### Scenario: The built-in git extension is absent
- **WHEN** the built-in git extension is not installed or has been disabled
- **THEN** the list SHALL NOT contain Show in Source Control or Reveal in Source Control
- **AND** every other action for that row SHALL still be offered

#### Scenario: Opening the list is free
- **WHEN** the user opens the actions for any row
- **THEN** no `git`, `gh` or `glab` process SHALL be spawned

---

### Requirement: Every action is reachable by mouse and by keyboard, from the same list

The system SHALL offer a row's actions from the row's context menu and from a menu opened on the
focused row by keyboard, and both routes SHALL render the same list for the same row.

One action — Open Folder in New Window — SHALL additionally appear inline on hover. That inline
control SHALL NOT be in the tab order, because a row is an ARIA `option` and an `option` may not
contain a focusable child; everything it does SHALL also be in the menu.

#### Scenario: The two routes agree
- **WHEN** the same row's actions are opened by right-click and by the keyboard menu key
- **THEN** both SHALL list the same actions in the same order

#### Scenario: The list is reachable without a mouse
- **WHEN** the user moves focus to a row with the arrow keys and opens its menu from the keyboard
- **THEN** every action offered for that row SHALL be invocable from that menu

#### Scenario: The hover control does not add tab stops
- **WHEN** the user tabs out of the repository list
- **THEN** focus SHALL move to the next control outside the list
- **AND** SHALL NOT stop on any per-row inline button

---

### Requirement: Open the repository's folder in a new window

The system SHALL open the repository's working-tree root in a **new** editor window, leaving the
current window's folders, its board and its history pane exactly as they were.

The action SHALL NOT be offered for a bare repository, whose only directory is a directory of git
internals.

#### Scenario: An ordinary repository opens beside the board
- **WHEN** the user invokes Open Folder in New Window on a row
- **THEN** a new window SHALL open on that repository's working-tree root
- **AND** the current window's workspace folders SHALL be unchanged
- **AND** the board SHALL still show every row it showed before

#### Scenario: The current window is never replaced
- **WHEN** the action is invoked from a window that already has a workspace folder open
- **THEN** that folder SHALL remain open in that window

#### Scenario: A bare repository offers no folder
- **WHEN** the row is marked `bare`
- **THEN** the action SHALL be absent from both routes

---

### Requirement: The set of hand-offs is closed, and nothing changes the shape of the current window

The hand-offs are exactly five — Open Folder in New Window, Show or Reveal in Source Control, Open in
Terminal, Copy Path, Open Remote in Browser — plus the two failure-state actions specified below. No
other action SHALL be offered on a row.

In particular, no action SHALL add, remove or replace a workspace folder of the current window. The
extension's premise is repositories the user is *not* working in, and an action that rearranges the
window they are working in is the side effect the Source Control requirement below refuses, arrived
at from the other direction.

#### Scenario: The window's folders are never changed
- **WHEN** discovery finds repositories, every row read completes, and every action offered on every
  row is invoked in turn
- **THEN** the window's workspace folders SHALL be exactly the folders it had before
- **AND** no action SHALL have offered to add one

#### Scenario: The list holds no sixth action
- **WHEN** the user opens the actions for an ordinary row that has answered
- **THEN** the list SHALL contain no action beyond the five named above

---

### Requirement: Show or Reveal the repository in Source Control, and say which

The system SHALL check the built-in git extension's exported API for the repository's path before
offering the action, and SHALL label the action by what it will actually do.

When the git extension already has the repository open, the action SHALL be labelled **Reveal in
Source Control** and SHALL only focus the Source Control view. When it does not, the action SHALL be
labelled **Show in Source Control**, its tooltip SHALL state that it adds the repository to the
Source Control view for this window, and invoking it SHALL call the git extension's exported
`openRepository`.

The system SHALL NOT use the git extension's internal commands for this.

#### Scenario: Already open
- **WHEN** the built-in git extension already lists the repository
- **THEN** the action SHALL read Reveal in Source Control
- **AND** invoking it SHALL focus the Source Control view
- **AND** the number of repositories the git extension holds SHALL be unchanged

#### Scenario: Not yet open
- **WHEN** the git extension does not list the repository
- **THEN** the action SHALL read Show in Source Control
- **AND** its tooltip SHALL say that it adds the repository to the Source Control view for this
  window
- **AND** invoking it SHALL make that repository appear in the Source Control view

---

### Requirement: Nothing else ever adds a repository to Source Control

The system SHALL call the git extension's `openRepository` only from the labelled action above.
Discovery, the row read, the dirty read, the history pane, a watcher event, a refresh and activation
SHALL NOT call it.

#### Scenario: A full pass changes nothing in the sidebar
- **WHEN** the extension discovers forty repositories, reads every row and fills every dirty count
- **THEN** the Source Control view SHALL contain exactly the repositories it contained before
- **AND** no file decoration SHALL have changed for any discovered repository

#### Scenario: Selecting a row does not open it
- **WHEN** the user selects a row and its history pane fills
- **THEN** that repository SHALL NOT have been added to the Source Control view

---

### Requirement: Open a terminal at the repository

The system SHALL create a terminal whose working directory is the repository — the working-tree
root, or for a bare repository the repository directory itself — and SHALL show it.

The system SHALL NOT send any text to the terminal, and SHALL NOT reuse an existing terminal on the
strength of its shell-integration directory.

#### Scenario: The terminal starts where the repository is
- **WHEN** the user invokes Open in Terminal on a row
- **THEN** a terminal SHALL be created with that repository's directory as its working directory
- **AND** that terminal SHALL be brought to the foreground

#### Scenario: Nothing is typed for the user
- **WHEN** a terminal is created by this action
- **THEN** no command SHALL have been written to it
- **AND** in particular no `cd` SHALL have been sent

#### Scenario: An existing terminal is not commandeered
- **WHEN** a terminal is already open whose working directory is that same repository
- **AND** the user invokes Open in Terminal on the row
- **THEN** a new terminal SHALL be created
- **AND** nothing SHALL be sent to the existing one

---

### Requirement: Copy the repository's path

The system SHALL place the repository's absolute path on the clipboard in the platform's own
separator form, because the destination is a shell on this machine. For a bare repository the path
copied SHALL be its git directory.

#### Scenario: The clipboard holds exactly the path
- **WHEN** the user invokes Copy Path on a row
- **THEN** the clipboard SHALL contain that repository's absolute path and nothing else
- **AND** the separators SHALL be the platform's own

#### Scenario: A worktree or submodule row copies its own path
- **WHEN** the row is a linked worktree or a submodule
- **THEN** the clipboard SHALL contain that working tree's path
- **AND** SHALL NOT contain the main repository's or the superproject's path

---

### Requirement: Open the repository's remote in a browser

The system SHALL read the remote URL at click time with one process:

```
  git -C <path> config --get remote.<name>.url
```

and SHALL NOT read `.git/config` from the filesystem for this purpose, because `include`,
`includeIf` and `url.<base>.insteadOf` put the answer somewhere a direct read does not see.

The remote SHALL be chosen in this order: the remote named by HEAD's upstream as the row already
holds it; failing that `origin`; failing that the sole remote when there is exactly one. When no
remote can be named this way, the action SHALL NOT be offered rather than guessed at.

#### Scenario: The upstream's remote is preferred
- **WHEN** HEAD's upstream is `upstream/main` and the repository also has a remote named `origin`
- **THEN** the URL read SHALL be for the remote `upstream`

#### Scenario: One process, at click time
- **WHEN** the user invokes Open Remote in Browser
- **THEN** exactly one `git` process SHALL be spawned
- **AND** no `git` process SHALL have been spawned for the remote URL before the click

#### Scenario: Several remotes, no upstream and no origin
- **WHEN** a repository has remotes `a` and `b`, no upstream on HEAD and no remote named `origin`
- **THEN** the action SHALL be absent from both routes

#### Scenario: The URL read fails
- **WHEN** `git config --get` exits non-zero, or does not answer within the runner's timeout
- **THEN** no browser SHALL be opened
- **AND** the failure SHALL be stated with the exact command that was run
- **AND** the system SHALL NOT fall back to parsing `.git/config`

---

### Requirement: Only four remote shapes are opened, and userinfo is stripped

The system SHALL convert exactly these four remote forms into a web URL and SHALL open nothing else:
`https://host/owner/repo(.git)`, `http://host/owner/repo(.git)`, the scp-like
`git@host:owner/repo.git`, and `ssh://git@host[:port]/owner/repo.git`. Each SHALL become
`https://host/owner/repo`.

Any other remote — a `file://` URL, a bare local path, a helper transport such as `ext::`, or
anything unrecognised — SHALL NOT be handed to the operating system, and the row SHALL say that the
remote is not one that can be opened in a browser.

Userinfo SHALL be removed from the URL before it is opened.

The allowlist is a security boundary rather than tidiness: opening a URI hands it to whatever handler
the operating system has registered for its scheme, so an unexamined remote string turns a cloned
repository's configuration into a launcher.

#### Scenario: An scp-like remote
- **WHEN** the remote URL is `git@github.com:owner/repo.git`
- **THEN** the browser SHALL be opened at `https://github.com/owner/repo`

#### Scenario: An ssh remote with a port
- **WHEN** the remote URL is `ssh://git@git.example.com:2222/owner/repo.git`
- **THEN** the browser SHALL be opened at `https://git.example.com/owner/repo`

#### Scenario: A credential in the remote never reaches the browser
- **WHEN** the remote URL is `https://user:token@git.example.com/owner/repo.git`
- **THEN** the opened URL SHALL be `https://git.example.com/owner/repo`
- **AND** the opened URL SHALL carry no userinfo
- **AND** no part of the token SHALL be written to the output channel

#### Scenario: A transport that is not a web URL
- **WHEN** the remote URL is a helper transport such as `ext::git-custom-helper %S`, or a
  `file://` URL
- **THEN** nothing SHALL be opened
- **AND** the row SHALL state that the remote is not one that can be opened in a browser

#### Scenario: A local path remote
- **WHEN** the remote URL is a bare local path such as `/srv/mirrors/repo.git`
- **THEN** nothing SHALL be opened
- **AND** the row SHALL state the same reason

---

### Requirement: An unestablished fact about a remote is never reported as an absence

The system SHALL distinguish "this repository has no remote" from "the remote could not be read",
and SHALL NOT render the second as the first. No action label SHALL carry a count the extension has
not established.

#### Scenario: The read failed, so nothing is claimed
- **WHEN** the remote URL read exits non-zero
- **THEN** the stated reason SHALL be that the remote could not be read
- **AND** the system SHALL NOT state that the repository has no remote
- **AND** the system SHALL NOT render a remote count of `0`

#### Scenario: No count appears in a label
- **WHEN** the forge layer is off and the user opens the actions for a row
- **THEN** no action label SHALL contain a review, change or remote count
- **AND** in particular no label SHALL contain `0`

---

### Requirement: A row that has not answered still offers its path actions

Discovery establishes a repository's path and kind before any git process runs, so the actions that
depend only on those facts SHALL be offered and SHALL behave identically while the row read is still
in flight. No action SHALL wait for the row read, and no action SHALL be greyed out merely because
the read has not landed.

#### Scenario: Copy Path on a reading row
- **WHEN** a row shows `reading…` on line 2
- **AND** the user invokes Copy Path
- **THEN** the clipboard SHALL contain that repository's path
- **AND** the action SHALL NOT wait for the row read to finish

#### Scenario: The path actions are complete before the read lands
- **WHEN** a row has not yet answered
- **THEN** Open Folder in New Window, Open in Terminal, Copy Path and the Source Control action
  SHALL be offered
- **AND** each SHALL do exactly what it does for a row that has answered

---

### Requirement: A row in a failure state offers the action that fits its failure

A row that timed out SHALL offer **Retry**, which re-reads that repository and no other. A row that
git refused for dubious ownership SHALL offer an action that copies the exact remedy to the
clipboard:

```
  git config --global --add safe.directory <path>
```

The system SHALL NOT run that command, SHALL NOT pass `-c safe.directory=<path>` in any invocation
of its own, and SHALL NOT offer any "trust this repository" or "trust all" control anywhere in the
extension.

#### Scenario: Retry re-reads one repository
- **WHEN** a row says it did not answer in time
- **AND** the user invokes Retry on that row
- **THEN** exactly one repository SHALL be re-read
- **AND** no other row SHALL be re-read

#### Scenario: The remedy is copied, not run
- **WHEN** a row states that git refused the repository for dubious ownership
- **AND** the user invokes the copy action on that row
- **THEN** the clipboard SHALL contain `git config --global --add safe.directory <path>` with that
  repository's own path
- **AND** no process SHALL be spawned
- **AND** the user's git configuration SHALL be unchanged

#### Scenario: There is no trust switch
- **WHEN** the user searches the command palette and the extension's settings
- **THEN** no command and no setting SHALL exist that adds a `safe.directory` entry or that
  otherwise defeats git's ownership check

---

### Requirement: A hand-off whose target is gone reports it and never silently does nothing

The system SHALL treat a target that has disappeared between the scan and the click as a stated
failure: the failure SHALL name the absolute path, the row SHALL be re-read so that it takes its
proper unreadable state rather than continuing to look ordinary, and the row SHALL NOT be removed
from the board on the strength of one failed hand-off.

Invoking an action SHALL NOT block the repository list or the history pane, whatever the target's
filesystem is doing.

#### Scenario: The directory was deleted after the scan
- **WHEN** the repository's directory has been deleted since discovery found it
- **AND** the user invokes Open Folder in New Window on its row
- **THEN** the failure SHALL be stated with that path
- **AND** the row SHALL be re-read and SHALL then carry its own reason
- **AND** the row SHALL NOT silently disappear

#### Scenario: The directory is on an unreachable mount
- **WHEN** the repository sits on a network mount that is not responding
- **AND** the user invokes an action on its row
- **THEN** the action SHALL either complete or state a failure naming the path
- **AND** the repository list SHALL remain scrollable and the history pane SHALL remain usable
  throughout

#### Scenario: The extension never creates the target
- **WHEN** a hand-off's target directory does not exist
- **THEN** the system SHALL NOT create it

---

### Requirement: Degenerate repositories keep the hand-offs their state allows

The hand-offs depend on a repository's path, its kind and its remote, so a repository in an unusual
state SHALL keep every action those facts allow and SHALL lose only the ones they rule out.

#### Scenario: A repository with no commits
- **WHEN** a row says `no commits yet`
- **THEN** Open Folder in New Window, Open in Terminal, Copy Path and the Source Control action
  SHALL be offered
- **AND** Open Remote in Browser SHALL be offered when a remote can be named

#### Scenario: A detached HEAD
- **WHEN** a row says `detached at 7c86ebf`
- **THEN** every action offered for an ordinary row SHALL be offered
- **AND** because HEAD has no upstream, the remote SHALL be chosen as `origin`, or as the sole
  remote, or the browser action SHALL be absent

#### Scenario: A repository mid-rebase
- **WHEN** a row says `rebasing main 1/3`
- **THEN** the hand-offs SHALL be unchanged
- **AND** no action SHALL be offered that continues, aborts or otherwise alters the rebase

#### Scenario: A repository git could not read
- **WHEN** a row states that git refused the repository, or that it did not answer
- **THEN** Copy Path SHALL still be offered
- **AND** any action requiring a fact the read never established SHALL be absent

#### Scenario: A bare repository
- **WHEN** the row is marked `bare`
- **THEN** Open Folder in New Window SHALL be absent
- **AND** Copy Path SHALL copy the git directory
- **AND** Open in Terminal SHALL open a terminal in that directory

#### Scenario: A repository nested inside another
- **WHEN** a linked worktree, a submodule or an unrelated clone inside another repository has its
  own row
- **THEN** every action on that row SHALL act on that row's own path
- **AND** SHALL NOT act on the enclosing repository

---

### Requirement: No action writes to a repository, and no action acts across repositories

Every action in this capability SHALL be a read or a hand-off. The system SHALL NOT stage, commit,
push, pull, fetch, prune, merge, rebase, check out, stash or write configuration, and SHALL NOT
offer any operation that acts on more than one repository — no Fetch All, no Pull All, no Prune All.

The only git subcommand this capability runs is `config --get`.

#### Scenario: The repository is untouched
- **WHEN** every action offered on a row has been invoked in turn
- **THEN** nothing under that repository's git directory SHALL have been modified by the extension
- **AND** no ref, index or configuration file SHALL have been written

#### Scenario: No batch command exists
- **WHEN** the user searches the command palette for this extension's commands, and opens the view
  title menu
- **THEN** no command SHALL act on more than one repository
- **AND** no command SHALL fetch, pull or prune

#### Scenario: The board is not a substitute for a git client
- **WHEN** a row is behind its upstream
- **THEN** the row SHALL NOT offer to fetch or pull
- **AND** the hand-offs SHALL be the only route the extension provides to doing so

---

### Requirement: Degenerate environments change what is offered, never what is claimed

#### Scenario: No git on PATH
- **WHEN** `git` is not on `PATH`
- **THEN** the list SHALL state that once for the whole board
- **AND** Open Remote in Browser SHALL NOT be offered on any row
- **AND** no `git` process SHALL be spawned by any action

#### Scenario: No gh and no glab
- **WHEN** neither `gh` nor `glab` is installed
- **THEN** every action in this capability SHALL be offered exactly as it is when they are installed
- **AND** no action SHALL invoke `gh` or `glab`

#### Scenario: A forge host that is not signed in
- **WHEN** the forge layer is on and a repository's host reports that it is not signed in
- **THEN** the actions offered on that row SHALL be unchanged
- **AND** Open Remote in Browser SHALL still be offered when a remote can be named

#### Scenario: An untrusted workspace
- **WHEN** the window is in Restricted Mode
- **THEN** the extension SHALL NOT activate
- **AND** none of its commands SHALL appear in the command palette
- **AND** no action SHALL be invocable

#### Scenario: A virtual workspace
- **WHEN** the workspace has no local filesystem path
- **THEN** the extension SHALL NOT run, so no hand-off SHALL be offered

---

### Requirement: No action runs on the extension's own initiative

Every action in this capability SHALL run only in response to a user gesture. Activation SHALL spawn
no process, open no window, create no terminal, write nothing to the clipboard and open nothing
externally.

The only outbound path this capability has is opening a remote's web URL, and it SHALL happen only
on the click that asks for it.

#### Scenario: Activation is inert
- **WHEN** the extension activates
- **THEN** no terminal SHALL be created, no window SHALL be opened, the clipboard SHALL be unchanged
  and nothing SHALL be opened externally

#### Scenario: A refresh invokes nothing
- **WHEN** the user presses Refresh, or a watcher event schedules a pass
- **THEN** no action from this capability SHALL be invoked
- **AND** nothing SHALL leave the machine

---

## Open against design

- **A vanished or unresponsive target is not decided anywhere.** D51 decides that an action known to
  be impossible is not offered, but nothing decides what happens when the target disappears between
  the scan and the click — which is the ordinary case for a board that reads directories the user is
  not working in. The requirement above is what D51's rejected alternative implies: say which of the
  two things broke, and name the path. Whether the row is re-read afterwards, and whether any
  existence check happens before the hand-off at all, are not decided.
- **How the set of remote names is known is not decided.** D53 fixes one process at click time,
  `git config --get remote.<name>.url`, and an order that ends with "the sole remote if there is
  exactly one" — but naming the sole remote, or knowing that `origin` exists, needs the set of
  remotes, which that command does not return. The only zero-process source in the design is the
  `.git/config` parse D53 admits as a *hint* for the forge layer. Either that hint also feeds this
  action's remote choice, or the click costs a second process; D53 says neither.
- **Show in Source Control on a bare repository is undecided.** D51 removes Open Folder for a bare
  repository; D52 does not say whether the git extension's exported `openRepository` accepts one, and
  that was not verified. The scenarios above leave the Source Control action's availability on a bare
  row unstated rather than guessing.
