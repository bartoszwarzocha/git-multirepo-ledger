# Repo Ledger

**Every other repository list tells you where each repository *is*. This one tells you when it last
moved — and sorts by it.**

VS Code's own Repositories row already carries the branch and the ahead/behind figures, and so does
GitLens's. Neither carries the last commit: not on the row, not in the tooltip, not in the children
beneath it. And neither will sort by it — VS Code offers discovery order, name or path; GitLens
offers discovered, last-fetched or name. "Which of these moved, and when" is the question that
starts a working day, and nothing in the editor answers it.

The second half is where the repositories are. `git.repositoryScanMaxDepth` defaults to `1`, and
`git.scanRepositories` refuses an absolute path outright, so a repository two levels down — or in a
directory you have not opened — is invisible to both. This walks for `.git` at any depth, beneath
the open folders and beneath directories you name.

That is the whole of what this does. It is a status board, not a git client: no staging, no
committing, no pushing, no fetching, no conflict resolution. Everything it runs is a read, and it
never writes inside a repository it found.

> **This is early.** See [Status](#status) at the bottom before you expect any of it to work.

## The row

One repository per row, three lines, nothing to expand — so twenty repositories are one pass of the
eye rather than twenty clicks.

1. **The repository name**, how far it has diverged from its upstream, and — dimmed at the end —
   how old that divergence figure is.
2. **The last commit**: when, then its subject. This is the line the extension exists for, and the
   list is sorted by it.
3. **What HEAD is doing** — `main`, or `detached at 7c86ebf`, or `rebasing 1/3 onto main` — and a
   marker when the repository is not an ordinary one: `worktree`, `submodule`, `bare`, `shallow`.

### Two things the row deliberately does not do

**It never renders an unestablished figure as zero.** `↑2 ↓1` is computed against a remote-tracking
ref that is exactly as old as the last fetch, so the row says how old that is and stays silent when
`.git/FETCH_HEAD` cannot prove even an attempt. A branch with no upstream reads `no upstream`, one
whose upstream is gone reads `gone`, and a working tree that has not been read yet is not the same
as a clean one. Absence of measurement never looks like a measured zero.

**It has no branch count.** No tool surveyed carries one, and a number you would not act on is not
a field.

A repository that will not answer — ownership git does not trust, a corrupt index, no commits yet,
a directory that vanished mid-scan — gets a row that says so, why, and the exact command that
failed, so you can retype it yourself.

## The history pane

Below the list, filling in for whichever row is selected: that repository's recent commits — hash,
age, author, subject, and chips for the branches and tags that point at each one. One `git log` per
page, not one per commit.

Commits that exist on no remote this repository knows about are marked **only here**, and only when
that was actually established: the check costs a second process and runs only when the row already
said there was something ahead, so an unmarked commit means "asked, and no", never "did not ask".

**Click a commit** and it expands into the files it changed. **Click a file** and it opens in the
editor's own diff, against its parent — for a repository the editor has never opened. That needs
this extension to serve the blobs itself, because VS Code's own `git:` URIs resolve only for
repositories the built-in Git extension has already opened, which excludes every repository this
board exists to show.

A merge says it is a merge and names its parents rather than showing a diff that would be true
against one side and misleading against the other.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `repoLedger.additionalRoots` | `[]` | Absolute directory paths scanned for repositories in addition to the open folders. This is the normal way to use the extension: the directory your repositories live in is usually not the one you have open. |
| `repoLedger.exclude` | `[]` | Absolute paths of repositories to leave out entirely — a mirror, a vendored checkout, anything you keep but never work in. |
| `repoLedger.maxDepth` | `32` | How deep below each root the search for `.git` descends. A stop against a symlink cycle or a home directory, not a way to make the scan cheaper. |
| `repoLedger.dirty.enabled` | `true` | Show which repositories hold uncommitted work. The one read that walks the working tree, so it costs a second `git` process per repository on screen. While off, the row says nothing there rather than showing a zero. |
| `repoLedger.concurrency` | `0` | How many repositories are read at once. `0` derives it from what the machine says it can run in parallel. |
| `repoLedger.history.pageSize` | `50` | Commits per page in the history pane. |
| `repoLedger.forge.enabled` | `false` | Open merge and pull request counts, via the `gh` and `glab` CLIs. **Off by default: it reaches the network.** While off, neither tool is invoked. |

## Privacy

Everything except `repoLedger.forge.enabled` is a local read of your own repositories. With the
forge setting on, `gh` and `glab` are run as subprocesses and talk to whatever hosts your
repositories point at, using credentials those tools already hold; no token is ever asked for or
stored, and there is no telemetry and no account. With it off, nothing leaves the machine.

## Status

Early, and not published. What exists: the manifest and the build; the data model; the walk that
finds repositories; the classification of worktrees, submodules, bare and shallow checkouts from
the filesystem; the readers for `for-each-ref` and `status --porcelain=v2`; the mid-operation and
fetch-evidence readers; and the logic that decides what every row says and in what order. All of it
is unit-tested against repositories the tests build and drive into each state.

Open review counts are built and switched off, which is where they will stay by default. They run
`gh` and `glab`, batched by owner rather than per repository — GitHub allows thirty search requests
a minute, and a directory of forty repositories asked one at a time renders a half-populated board
that reads as a bug. A query that stops at its own limit renders as `41+` rather than as a total,
and a host with no client shows nothing rather than a zero. The `glab` half has never met a real
`glab`; until it does it fails to silence, which is the ship-safe state and not a substitute for
the check.

What does not exist: merge lanes in the history pane, a text filter over the board, and three of
the five row hand-offs. All are recorded as deferred, with their reasons, in
`openspec/changes/implement-repo-ledger/`. Nobody has yet run the empty and unusual states by hand
in the Extension Development Host, which is the largest thing standing between this and a release.

No screenshots, benchmarks or install counts appear above because none of them exist yet, and none
will be added before they are true. The one number worth stating plainly: nothing comparable on the
Marketplace has more than a few hundred installs, so this is built because its author wants it, not
because demand for it has been demonstrated.

## Licence

MIT — see [LICENSE](LICENSE).
