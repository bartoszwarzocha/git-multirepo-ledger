# Repo Ledger

A VS Code extension that answers "what is the state of all my repositories" for a *directory
full of them*, without opening any of them.

## The problem

Work spread across many repositories has no home in the editor. VS Code's Source Control view
knows only the repositories inside the open folders, and it answers one question about them:
which files are dirty. It does not say which repository moved last, which branch each is on,
how far each has drifted from its upstream, or whether anything is waiting in review.

So the working day starts with the same manual sweep: open a repository, glance, close it,
open the next. With twenty repositories that is twenty context switches to answer a question
that should be one glance.

## What already exists

This table was checked against primary sources on 2026-09-07 — VS Code's and GitLens's own
source and settings schemas, and the Marketplace query API. An earlier version of it, written
from use rather than from a check, was wrong in four places; those are recorded below the table
because a premise that a reviewer can disprove in ten seconds is worse than no premise.

| Tool | What its row already carries | What it does not |
|---|---|---|
| VS Code Source Control | Repository name, branch with `*`/`+`/`!` markers, `<behind>↓ <ahead>↑`. A hidden-by-default Repositories view; the Source Control Graph pane below it does commit → changed files → native diff | No last commit subject or date, anywhere. Sorts by discovery time, name or path only. Scans workspace folders one level deep and **refuses absolute paths** in `git.scanRepositories` |
| GitLens | Repository node with upstream ahead/behind, branch, and `Last fetched <age>` | No last commit on the node. Sorts by discovered / lastFetched / name. Its Repositories view is off by default and renders each repository *expanded* into ~8 children. Pull-request aggregation is Pro-gated |
| Git Graph | The commit graph of one repository | One repository. No release since 2021 |
| Project Manager | Recursively scans configured absolute base folders for `.git` — the same discovery this project needs | Shows **no git state at all**; it is navigation |

**What that leaves, stated exactly.** Not "nobody takes the directory as the unit" — Project
Manager does, and has millions of users doing it. The unoccupied ground is narrower and it is
this:

1. **The last commit's subject and date on a per-repository row.** Absent from core's row, its
   tooltip and its children, and from GitLens's repository node.
2. **Sorting a repository list by last commit.** Core sorts by discovery time, name or path;
   GitLens by discovered, last-fetched or name. Nobody sorts by when work last landed.
3. **Repositories nested deeper than one level, or in directories never opened.** A directory
   opened as a workspace folder is already scanned by core, so the shallow case is not a gap.
4. **Open review counts per repository without a paid plan.**

Items 1 and 2 are one idea: the last-commit line is what makes the sort legible, and the sort is
what turns a list into a board.

**And the honest half.** Twenty-seven Marketplace extensions claim multi-repository scope and
none is above roughly 760 installs; the direct competitors are under a hundred. The two
seven-figure neighbours succeed as *pure navigation with no state layer*. No feature request for
this shape was found in `microsoft/vscode`; the two nearest open issues ask for filtering and
sorting *inside* the existing Source Control view. The gap is real and the demand is unproven.
That belongs here rather than in a footnote, because it is the fact most likely to be forgotten
once the code is fun to write.

## What this project adds

1. **The last commit is the headline, and the list is sorted by it.** "Which of these moved, and
   when" is the question that starts a day. No existing view carries that fact on the row, and
   none offers it as an ordering. This is the difference; everything else supports it.
2. **One row per repository, three lines, nothing to expand.** Name, divergence and how old that
   divergence figure is; the last commit's date and subject; the HEAD state and what kind of
   repository it is. Twenty repositories readable in one pass.
3. **A divergence figure that admits its own age.** `↑2 ↓0` is computed against a remote-tracking
   ref that is only as fresh as the last fetch, so the row says when that was. Nothing here ever
   renders "up to date" for a question nobody asked.
4. **The directory is the unit, at any depth.** Repositories are found beneath the opened folders
   and beneath extra absolute paths, whether or not they are open in the editor. The editor
   itself stops at one level and refuses absolute paths, so this covers the nested and the never
   opened.
5. **Review state beside local state.** Open MR/PR counts from the `gh` and `glab` CLIs, batched
   by owner rather than fetched per repository, so the row says both what is on disk and what is
   waiting on somebody else. Off by default, because it touches the network.

## What it deliberately is not

Not a git client. No staging, no committing, no pushing, no conflict resolution, no blame. It
is a status board that hands off to the tools already installed. Everything it runs is a read.

## It is published, so it is designed for the unknown

This is the governing constraint, and it outranks anything measured on a development machine.
The extension will run on repository layouts, hardware and network conditions its author will
never see. Every decision is made against the general case, not against a directory somebody
happened to have open.

Concretely, none of the following may be assumed:

- **How many repositories, or how they are arranged.** Two or two hundred. Flat, or nested
  several levels deep, or a repository inside another repository. Depth and exclusions are
  settings with sane defaults, and the walk is bounded so a symlink cycle or a home directory
  cannot hang anything.
- **How fast git answers.** A local SSD and a network share differ by orders of magnitude, and
  so do a fresh repository and one with a decade of history. So: nothing blocks, rows render as
  each repository resolves rather than after all of them do, every read is cancellable, and a
  read that times out says so instead of disappearing.
- **How many cores the machine has.** Concurrency is derived from `os.cpus()` between a floor
  and a ceiling, and is overridable. No number tuned to one machine is baked in.
- **That a repository will answer at all.** Some refuse every command — ownership git does not
  trust, a corrupt index, a permission wall. Some have no commits, a detached HEAD, no remote,
  or sit mid-rebase. Each is a stated row state carrying its reason: never a blank row, and
  never a zero that actually means "we could not ask".
- **That `git` is on `PATH`,** or that `gh` or `glab` exist, or that either is authenticated
  for the host a given repository points at.
- **That every repository belongs to one account or one forge.** A directory may mix personal
  and work repositories, several identities, and more than one host.

**Measurements on a development machine are smoke tests, not design inputs.** They are worth
taking — a wall-clock figure catches mistakes a code review will not — but a number obtained on
one machine never becomes a constant, a threshold, or an argument. If a measurement appears to
justify a design decision, the decision is wrong: it has been fitted to a single sample.

## Tech stack

Deliberately the same as the sibling project `openspec-ledger`, because the two are maintained
by one person and a second set of conventions is a second thing to remember.

- TypeScript (strict), targeting the VS Code extension host (Node)
- esbuild bundle to `dist/extension.js`, `vscode` external, no runtime dependencies
- Tests are `node --test "src/**/*.test.ts"` — plain `node:test`, no framework, no extension host
- Git access through the `git` CLI via `child_process`, never a JavaScript reimplementation
- Nothing on the activation path: discovery and reads are scheduled after `activate` returns
