# Changelog

All notable changes to Multirepo Ledger are recorded here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-21

### Fixed

- **The commit list and the report went stale while the window was open.** They were re-read on
  start-up, on Refresh and when the period changed - never from a pass. So a commit that landed
  while you watched moved the row above it and left the list below showing whatever the period was
  last asked for. Reported as "the extension did not refresh"; the reporter had found the
  workaround without knowing it was one, because switching the period and back was the only control
  on screen that re-read the commits. A pass now reads them alongside the rows.
- **Refresh refreshed half of what you were looking at.** It reloaded the commits only in the `All`
  scope, so pressing it while looking at one repository - the default - left that repository's list
  untouched.
- **A branch tip that lives only in `packed-refs` produced no event.** Verified against git 2.52: a
  fresh clone keeps `refs/remotes/origin/main` there and writes no file under `refs/` for it, so a
  repository whose refs are packed could move in silence. `packed-refs` is watched now, and so is
  `reftable/**`, for repositories created on git's alternative ref backend, which have no `refs/`
  directory at all.
- **Starting a rebase, merge, cherry-pick, revert or bisect changed the row without an event.** The
  markers those write are watched now, so the third line reports them as they happen.

### Added

- **`multirepoLedger.refreshIntervalMinutes`** - a periodic re-read, five minutes by default, `0`
  to switch it off. File watching is not a guarantee: it degrades on network shares and mapped
  drives, it is capped per platform, and `files.watcherExclude` over `.git` switches it off
  entirely. The timer does not run while the window is unfocused.
- **A read when the window regains focus**, which is the one case neither the watcher nor the timer
  can see: work done in a terminal while the editor sat in the background. Floored at fifteen
  seconds so that alt-tabbing costs nothing.

## [0.1.0] - 2026-09-08

### Added

- **The repository list.** One row per repository, three lines, nothing to expand: the name with
  its divergence and — dimmed and trailing — how old that divergence figure is; the last commit's
  age and subject; what HEAD is doing, and a marker when the checkout is a worktree, a submodule,
  bare or shallow. The default ordering is by last commit, which no other repository list in the
  editor offers.
- **Discovery at any depth**, beneath the open folders and beneath absolute directories named in
  `multirepoLedger.additionalRoots`. Finding a `.git` ends the walk of that subtree, so a repository's
  own subdirectories are not further repositories; a `.git` that is a *file* — a linked worktree or
  a submodule — is resolved and classified from the filesystem before any process is spawned; and a
  candidate that turns out to sit inside another repository's working tree is dropped whichever
  search found it.
- **A clickable tally** above the list. Each count filters the rows beneath it, because a count you
  cannot act on is decoration.
- **The history pane**, driven by the selected row. One `git log` per page carries the hash,
  parents, refs, date, author and subject; branches and tags render as chips. Commits that exist on
  no remote this repository knows about are marked *only here* — and only when that was actually
  established, which costs a second process and happens only when the row already said there was
  something ahead.
- **Commit contents and the diff.** Expanding a commit lists the files it changed, in one
  `diff-tree`. Clicking a file opens the editor's own diff against the commit's parent, served by a
  read-only filesystem this extension registers over `git cat-file` — because VS Code's `git:` URIs
  resolve only for repositories the built-in Git extension has already opened, which excludes every
  repository this board exists to show.
- **Row hand-offs**: open the repository's folder in a new window, or copy its path. Both are
  explicit buttons on the row. The primary click only selects.
- **Open review counts**, from `gh` and `glab`, switched off by default because they are the one
  thing here that leaves the machine. Batched by owner rather than fetched per repository: GitHub
  allows thirty search requests a minute, so the per-repository version does not work at all on a
  directory of any size. A count whose query stopped at its own limit renders as `41+`; a host with
  no client, a tool that is not installed and a tool that is not signed in each render as silence
  with their own sentence, never as a zero.
- Settings: `multirepoLedger.additionalRoots`, `multirepoLedger.exclude`, `multirepoLedger.maxDepth`,
  `multirepoLedger.dirty.enabled`, `multirepoLedger.concurrency`, `multirepoLedger.history.pageSize` and
  `multirepoLedger.forge.enabled`.
- The scaffolding this all sits on: the manifest, the esbuild bundle, eslint, `node:test`, CI on
  Ubuntu and Windows, the Activity Bar glyph and the Marketplace icon, and `src/util/git.ts`,
  `fsx.ts` and `log.ts` adapted from the sibling project `openspec-ledger`.

### Notes

- **Everything the extension runs is a read.** `--no-optional-locks` precedes every `status`, so not
  even `.git/index` is rewritten. Nothing in this version touches the network, and the only thing
  ever written is the extension's own storage — unless the review counts are switched on, which is
  the single outbound path and is named as such wherever it appears.
- **A figure the extension has not established never renders as zero.** A working tree nobody read
  is not a clean one; a branch with no upstream is not level with one; a branch whose upstream is
  gone says so in words; and the divergence figure carries the age of its own evidence rather than
  claiming to be current, because `.git/FETCH_HEAD` records an attempt and not a success, and is
  absent entirely after a clone.
- A repository git refuses — dubious ownership, a corrupt index, a directory that vanished
  mid-scan — gets a row carrying git's own words and the exact command that failed, so it can be
  retyped. There is no `safe.directory` button: that control exists to stop a repository in a shared
  directory executing somebody else's configuration.

### Not in this version

- Merge lanes in the history pane. VS Code ships a Source Control Graph on by default, so lanes are
  the least differentiated work in the project. The parent list is read and stored from the first
  version, so drawing them later needs a renderer rather than a migration.
- A text filter over the board. The tally chips answer the questions the header raises, and the
  editor's own find covers the rest.
- Three of the five row hand-offs. Open Folder in a New Window and Copy Path ship as inline
  buttons; Reveal in Source Control, Open in Terminal and Open Remote in Browser are wired in the
  controller and have no button yet.
- Verification by a person. Nobody has run the empty and unusual states by hand in the Extension
  Development Host, and the `glab` path has never met a real `glab`. Both are recorded as open in
  `openspec/changes/implement-multirepo-ledger/tasks.md` rather than quietly ticked.
- A Marketplace release. Nothing is published.
