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

**Open question, not yet measured:** the Marketplace install counts and the exact current
feature set of the multi-repository views in GitLens. The table above describes capability from
use, not from a measurement, and the differentiator argument in the proposal must not lean on a
number nobody has checked.

## What this project adds

1. **The directory is the unit, not the workspace.** Repositories are found at any depth
   beneath the opened folders and beneath extra absolute paths, whether or not they are open
   in the editor. This is the same recursive discovery that OpenSpec Ledger uses, and the same
   reason: real work does not sit at a workspace-folder root.
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

## Measured baseline (`E:\AI`, 2026-09-07)

Every number below was measured on the development machine, not assumed.

- **23 git repositories** beneath a single directory. 16 at the top level, 7 nested two or
  three levels down, and one repository *inside* another (`my_name_is_claude/my_name_is_claudepilot`)
  — so "repository inside a repository" is a case the discovery layer meets on day one, not a
  hypothetical.
- **13 of the 23 refuse every git command** with `fatal: detected dubious ownership`, exit 128.

  The cause was established rather than guessed, and it is mundane: those directories are owned
  by SID `S-1-5-21-3778064966-3402182952-1707121149-1002`, a *different Windows installation's*
  SID, while the ten that work are owned by `DESKTOP-QF5A9LL\barto`. They were carried over from
  another machine. Git compares the directory's owner against the process token, finds a
  stranger, and stops. It is not a network or VPN condition — the measurement was repeated with
  the VPN connected and is identical.

  Consequence for the design, sized correctly: **exit 128 is a row state with a sentence, not a
  blank row.** The row says what is wrong and names the command that fixes it. That is ordinary
  error handling that any reader of many repositories needs — not a reason for this extension to
  exist, and not a claim about repositories in general. It earns its place here only because a
  directory of repositories collected over years will always contain a few the current user did
  not create.

- **Process spawn dominates completely.** From Node with `shell: false`, `git --version` takes a
  median of **77 ms** and `git status --porcelain=v2 --branch` takes **71 ms** — the same. Git's
  actual work is free at this scale; what costs is starting the process. So the design question
  is never "is this command expensive" but "how few processes can this row cost".
- **The full row costs three commands**, about **276 ms** serially per repository.
- **Fan-out over all 23 repositories**, three commands each, at increasing concurrency. Two runs,
  because the first was against a cold filesystem cache and the second was not — the warm figures
  are the ones to design against, and the shape of the curve is the same either way:

  | concurrency | cold | warm |
  |---|---|---|
  | 1 | 3107 ms | 2136 ms |
  | 4 | 1242 ms | 845 ms |
  | 8 | 1232 ms | **689 ms** |
  | 16 | 1696 ms | 724 ms |
  | 24 | 950 ms | 697 ms |

  The knee is at four and everything past eight is noise. Each repository already issues its
  three reads in parallel, so a concurrency of 8 repositories means up to 24 git processes in
  flight, which is this machine's core count. **Eight is the setting**, giving roughly 0.7 s warm
  for the whole directory.

## Tech stack

Deliberately the same as the sibling project `openspec-ledger`, because the two are maintained
by one person and a second set of conventions is a second thing to remember.

- TypeScript (strict), targeting the VS Code extension host (Node)
- esbuild bundle to `dist/extension.js`, `vscode` external, no runtime dependencies
- Tests are `node --test "src/**/*.test.ts"` — plain `node:test`, no framework, no extension host
- Git access through the `git` CLI via `child_process`, never a JavaScript reimplementation
- Nothing on the activation path: discovery and reads are scheduled after `activate` returns

## Reference environment

`E:\AI` as described above: 23 repositories, nesting three levels deep, one repository inside
another, and 13 carried over from another machine that refuse a git command until a
`safe.directory` entry is added. A design that assumes every repository answers a git command is
wrong for this machine — and, more usefully, wrong for any directory that has accumulated
repositories from more than one source.
