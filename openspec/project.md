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

| Tool | What it does | What it does not |
|---|---|---|
| VS Code Source Control | Lists repositories in the open folders, shows dirty files | No last commit, no branch divergence, no review state; nothing outside the workspace |
| GitLens | Deep, excellent, per-repository: blame, graph, history | Organised around *one* repository at a time; the multi-repository view is a list of trees to expand, not a board to scan |
| Git Graph | The commit graph of one repository | One repository, and nothing about the others |

None of them takes a *directory* as the unit and answers across it.

**Not yet checked:** Marketplace install counts, and the exact current feature set of the
multi-repository views in GitLens. The table describes capability from use, not from a
measurement, and no argument in the proposal may lean on a number nobody has verified.

## What this project adds

1. **The directory is the unit, not the workspace.** Repositories are found at any depth
   beneath the opened folders and beneath extra absolute paths, whether or not they are open
   in the editor.
2. **One row per repository, three lines, nothing to expand.** Repository name and its
   divergence; the last commit; the branch, the branch count and the open merge requests.
   Twenty repositories readable in one pass.
3. **The last commit is the headline.** "Which of these moved, and when" is the question that
   starts a day, and it is the one fact no existing multi-repository view puts first.
4. **Review state beside local state.** Open MR/PR counts from the `gh` and `glab` CLIs, so the
   row says both what is on disk and what is waiting on somebody else. Off by default, because
   it touches the network.

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
