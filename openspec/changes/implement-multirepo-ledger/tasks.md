# Tasks — implement-multirepo-ledger

Phase 0 is already done and is ticked below; it is the scaffold this change builds on, recorded as
phase 0 so that the first group of *work* is unambiguously discovery and the row read. Phases 2-5
ship as 0.1.0 — repositories discovered at any depth, read in one git process each, and rendered as
a sorted, filtered, tallied board. Phase 6 ships as 0.2.0 (the hand-offs, so a click leads
somewhere). Phases 7-8 ship as 0.3.0 (the history pane: a dated commit list with ref chips, and the
changed-file list on expansion). Phase 9 ships as 0.4.0 (review counts, still switched off when they
land). Phase 10 is the release. Each phase ends in something that can be run or asserted.

Phases 2 and 3 come first because every surface renders their output: nothing in phases 4 to 9 can
be checked against anything until discovery names repositories and the row read answers about them.

Every implementation task below is followed by the check that covers it — a unit test over the pure
half where there is one, and a named hand check in the Extension Development Host where there is
not, because a webview's rendering and a hand-off's effect on the window are not assertable under
`node --test`.

Two things are deliberately absent from this list. **Graph lanes** and **the native per-file diff
with the `FileSystemProvider` it requires** are a later change, not a phase here (D38, D39). The
parent list `%P` is parsed and retained from phase 7 so that later change adds a lane column and a
pure layout module without touching the read, the record layout, the parser or the paging.

## 0. Project Scaffolding

Already complete. `npm run compile` is green, `npm test` passes, and the extension launches in the
Extension Development Host showing two placeholder views. Recorded here because the rest of the plan
assumes it and a reader should not have to infer what exists.

- [x] 0.1 `package.json`: the `bartosz-warzocha` publisher, `multirepo-ledger`, engine `^1.104`, categories and keywords, `activationEvents: ["onStartupFinished"]`, the `multirepo-ledger` view container and the `multirepoLedger.repositories` and `multirepoLedger.history` view contributions
- [x] 0.2 `capabilities.virtualWorkspaces: false` and `capabilities.untrustedWorkspaces: false` declared with the reason each gives, and the three commands `refresh`, `showOutput` and `openAdditionalRootsSetting` contributed with their view-title menus
- [x] 0.3 The four settings declared with descriptions that say what each costs: `additionalRoots`, `exclude`, `maxDepth`, `forge.enabled`
- [x] 0.4 TypeScript strict, ESM, `.ts` extensions in import specifiers, `tsconfig.json` targeting the extension host, `npm run check-types` as `tsc --noEmit`
- [x] 0.5 esbuild bundling `src/extension.ts` to `dist/extension.js` with `vscode` external and no runtime dependencies, plus the `watch` and `package` scripts run in parallel by `npm-run-all`
- [x] 0.6 eslint over `src`, `npm run compile` wired to check-types, lint and build, and `npm test` as `node --test "src/**/*.test.ts"` with no framework and no extension host
- [x] 0.7 `.vscode/launch.json` and `.vscode/tasks.json`, `.github/workflows/ci.yml`, `.vscodeignore`, `.gitignore`, `LICENSE`, `README.md` and `CHANGELOG.md`
- [x] 0.8 `resources/activity-bar.svg` and the 128×128 `resources/icon.png`
- [x] 0.9 `src/util/git.ts`, `src/util/fsx.ts` and `src/util/log.ts` copied from the sibling, keeping the per-process timeout, the output cap and `GitMissingError` intact
- [x] 0.10 `src/model/keys.ts` copied from the sibling, and `src/model/types.ts` sketched as a first pass at the model
- [x] 0.11 `src/util/git.test.ts` and `src/model/keys.test.ts` running under `node --test` with no extension host
- [x] 0.12 A placeholder `src/extension.ts` that opens the log, registers the commands and both view providers, and returns — so the scaffold launches and says in words that the list is not built yet

## 2. Repository Discovery

> **Built.** Landed as `src/discovery/{search,vscodeSearch,repositories,cache}.ts` with `search.test.ts` and `repositories.test.ts`. The nesting rule of D67 is enforced in `repositories.ts` over the merged candidate set, because the editor index cannot be pruned the way the walk can.

- [x] 2.1 Adapt `src/discovery/search.ts` from the sibling: the needle becomes an entry named `.git`, matching either a directory or a file, and `.git` is removed from the copied `DEFAULT_EXCLUDED_DIRS`, where its entry now means "stop here" rather than "skip this"
- [x] 2.2 Write tests over a fixture tree: a root of twenty repositories returns twenty, and a run with `.git` left on the exclusion list returns none — the silent-empty failure this task exists to prevent
- [x] 2.3 Implement the leaf rule: a found repository is not descended into, neither its `.git` nor its working tree, so the walk's cost is a function of the directories above the repositories
- [x] 2.4 Write tests for the leaf rule: `node_modules/some-package/.git` and `vendor/other-project/.git` inside a discovered repository are not returned, and the walk visits no directory inside any repository it found
- [x] 2.5 Implement the depth bound from `multirepoLedger.maxDepth`, logging the stop with the depth, the count of unsearched directories and the first of them
- [x] 2.6 Implement link refusal from the `readdir` dirent plus a set of visited real paths, so a cycle terminates rather than merely being bounded, and resolve a user-named root with `realpath` because a path the user typed is a statement of intent
- [x] 2.7 Implement the per-root directory budget, logging the count and the first unsearched directory, and returning what was found rather than failing
- [x] 2.8 Write tests for the three guards: a junction pointing at its own ancestor terminates and does not report the depth stop, a depth stop logs its numbers, and a budget stop returns the repositories found before it
- [x] 2.9 Implement `src/discovery/kind.ts`: resolve a `gitdir:` pointer written either absolute or relative, and classify ordinary, linked worktree (by `commondir`), submodule (by the `.git/modules/` path shape under an ancestor repository), separate git directory, and bare (by the `HEAD`/`config`/`objects`/`refs` layout)
- [x] 2.10 Add the shallow marker to the classifier as one further `stat` of `<gitdir>/shallow`, kept beside the kind rather than inside it
- [x] 2.11 Write tests for `kind.ts` against fixtures built in a scratch directory: a linked worktree, a submodule, a separate-git-dir repository carrying `core.worktree` classified ordinary, a bare layout, a shallow clone, and a `gitdir:` pointing nowhere
- [x] 2.12 Implement `src/discovery/roots.ts`: workspace folders plus `multirepoLedger.additionalRoots`, deduplicated through `pathKey`, a configured path that does not exist logged once and skipped, and the built-in name exclusion never applied to a directory the user named
- [x] 2.13 Write tests for `roots.ts`: a root outside the workspace, a missing path logged exactly once, one configured root containing another yielding each repository once, and a root named `build` still walked
- [x] 2.14 Adapt `src/discovery/vscodeSearch.ts`: two passes, `**/.git/HEAD` and `**/.git`, each passing `null` as the exclude argument and capped with `maxResults`, with a reached cap reported rather than silently truncating the board
- [x] 2.15 Write tests for the index adapter's pure half: a `.git/HEAD` hit yields the working-tree path, `.git/worktrees/*/HEAD` and `.git/modules/*/HEAD` yield nothing, and a hit under an excluded directory name is dropped
- [x] 2.16 Implement the merge of index and walk results by resolved path, with the walk as the authority, and apply `multirepoLedger.exclude` so an excluded repository is not walked into, not read, not counted in any tally and not present in `M`
- [x] 2.17 Write tests for the merge: a repository both sources found appears once, a bare repository comes only from the walk, and an excluded path is absent from the result and from the count
- [x] 2.18 Implement the nested-candidate rule (D67) over the merged set: a candidate whose path lies inside the working tree of a repository the same generation has established is dropped, whichever source found it, unless the user named it or an ancestor of it inside that working tree in `multirepoLedger.additionalRoots`; evaluate it first among the index results, which arrive as one batch, and again when the walk completes
- [x] 2.19 Write tests for the nested-candidate rule: an index hit for `<repo>/vendor/other-project/.git` is dropped, an index hit for `<repo>/sub/.git` is dropped, neither is ever emitted and then withdrawn, naming either path in `additionalRoots` restores it, and a linked worktree outside every working tree is untouched by the rule
- [x] 2.20 Implement submodule rows read from the superproject's `.gitmodules` behind a new `multirepoLedger.includeSubmodules`, default `false`, with an uninitialised submodule getting no row at all, and confirm that these rows are admitted by their own setting rather than by the index and are therefore not removed by task 2.18
- [x] 2.21 Write tests for submodules: absent by default even when the index returns them, present with their marker when the setting is on, uninitialised yielding no row and no placeholder
- [x] 2.22 Declare `multirepoLedger.includeSubmodules` in `package.json`, with a description saying what turning it on does to a board whose value is that it fits on one screen
- [x] 2.23 Implement `src/discovery/cache.ts` and the pass contract: a generation and an `AbortSignal` per pass, the walk observing the signal between two directories, and a result arriving under a stale generation dropped at the boundary rather than merged
- [x] 2.24 Write tests for cancellation: a superseded walk's partial result is discarded, a cancelled pass spawns no process, and disposal stops the walk
- [x] 2.25 Write one end-to-end discovery test over a fixture tree holding an ordinary repository, a nested one, a linked worktree, a submodule, a bare repository, a shallow clone, an excluded path and a junction, asserting the exact set returned and that no git process was spawned

## 3. The Row Read

> **Built.** Landed as `src/read/{refs,status,gitState,classify,reader}.ts`, each with an adjacent test file that drives real repositories into every state it asserts on. The row is one `for-each-ref`; dirty state is the opt-in second process; repository kind, mid-operation state, shallowness, fetch evidence and the remote URL cost none.

- [x] 3.1 Reconcile `src/model/types.ts` with this design: the `HeadState`, `Operation`, `Divergence`, `FetchEvidence`, `ReadFailure` and `RepositoryRow` shapes the read produces, and a `ForgeCount` union in which an unestablished zero cannot be represented
- [x] 3.2 Implement `src/read/gitdir.ts`: read `HEAD`, the operation markers, `shallow` and the mtime of `FETCH_HEAD` from the filesystem, with absence read as "not in that state" and never as an error, and a comment saying these marker files are not in `gitrepository-layout(5)`
- [x] 3.3 Write tests for `gitdir.ts` against fixtures for each stopped operation — `MERGE_HEAD`, `rebase-merge/` with `head-name`, `msgnum` and `end`, `rebase-apply/` with and without `applying`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_START` — and for a combination the module does not recognise, which yields silence
- [x] 3.4 Implement command construction in `src/read/refs.ts`: case A scoped to `refs/heads/<name>`, case B as `--include-root-refs` with the `HEAD` pattern, case C as both patterns, and the shared `%1f`-separated format string with the subject last
- [x] 3.5 Write tests asserting each case's exact argument array, and that neither broken shape is ever emitted — a bare `HEAD` pattern without the flag, which returns nothing and exits 0, or the flag with no pattern
- [x] 3.6 Implement the `for-each-ref` output parser: split on the first six separators with the seventh taken verbatim, and the three HEAD signatures — a branch row carrying `*`, a `HEAD` row carrying `*`, and zero records with exit 0
- [x] 3.7 Write tests for the parser against fabricated output: a subject containing `|`, `%(weird)` and a `0x1F`, a first paragraph folded from two lines, a detached record, an empty result, `gone`, and an empty upstream
- [x] 3.8 Implement `src/read/capability.ts`: exit 129 with ``unknown option `include-root-refs'`` recorded for the session, and the two fallback shapes — `git log -1` for a detached HEAD, and `for-each-ref refs/heads/` plus `git log -1` for case C
- [x] 3.9 Write tests for the capability memory: the first failing read re-reads that one repository with the fallback, a second detached repository uses the fallback directly, and no `git --version` string is parsed to decide it
- [x] 3.10 Extend the copied `runGit` with the pinned child environment — `LC_ALL=C`, empty `LANGUAGE`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, no shell, piped stdio, hidden window — leaving the timeout and the output cap as copied
- [x] 3.11 Write tests for the environment: the spawn options asserted field by field, and a repository whose path holds a space, an ampersand and a quotation mark read correctly with no part of it interpreted
- [x] 3.12 Implement `src/read/status.ts`: `git --no-optional-locks status --porcelain=v2 --branch` with the option **before** the subcommand, never spawned for a repository with no working tree, and the `# branch.oid` cross-check that discards an answer belonging to another commit
- [x] 3.13 Write tests for the dirty read: the argument order (the wrong order exits 129), `# branch.oid (initial)` treated as a successful read, a mismatched object id discarded and the row re-read, and a bare repository never spawned for
- [x] 3.14 Implement `src/read/schedule.ts`: concurrency from `os.availableParallelism()` clamped between a named floor and ceiling, replaced entirely by `multirepoLedger.concurrency` when it is above zero, with each bound's comment naming the failure it prevents
- [x] 3.15 Write tests for the scheduler: one reported CPU yields the floor rather than one, the setting overrides the derivation, no more than the limit is in flight at once, and the module contains no numeric literal that came from a measurement
- [x] 3.16 Implement generations and cancellation in the read pass: the signal into `runGit` so the child is killed, and answers carrying a stale generation dropped rather than merged
- [x] 3.17 Write tests for cancellation: a refresh mid-pass discards the previous pass's answers, and deactivation kills every child
- [x] 3.18 Implement failure classification: exit 128 with `safe.directory` in stderr keyed on the config key rather than the sentence; the per-process timeout; a truncated result; and anything else as git's own first line of stderr
- [x] 3.19 Write tests for classification: each of the four, a translated refusal still detected, and a truncated result never parsed as a complete answer
- [x] 3.20 Implement `src/model/state.ts` — `statesOf(read)` over the closed vocabulary `clean`, `dirty`, `unpushed`, `behind`, `detached`, `mid-operation`, `no-upstream`, `unreadable` — as a set per repository, computed once for every consumer
- [x] 3.21 Write tests for `statesOf`: every state in the vocabulary, a repository carrying three at once, and no state outside the vocabulary reachable
- [x] 3.22 Implement `src/model/relative.ts`: unix seconds to `just now`, `12m ago`, `3h ago`, `2d ago`, `5w ago`, `7mo ago`, `3y ago`, in English, with a future timestamp rendering `just now`
- [x] 3.23 Write tests for the formatter at each boundary, for a future timestamp, and for the instant at which a given timestamp's wording next changes, which is what the page schedules against
- [x] 3.24 Declare `multirepoLedger.dirtyState.enabled` (default `false`) and `multirepoLedger.concurrency` (default `0`, meaning derive) in `package.json`, each stating what it costs rather than what it tunes
- [x] 3.25 Add a temporary `multirepoLedger.dumpBoard` command that runs discovery and the row read and writes one line per repository to the output channel, and run it in the Extension Development Host against a fixture directory — the first end-to-end proof, before anything is drawn. It is removed by task 4.21

## 4. The Repository List — the page and the row

> **Built.** Landed as `src/view/{row,order}.ts` (pure, tested) and `src/view/listPanel.ts` (layout only). The page re-renders per publish rather than patching per row: the patch protocol the tasks describe is an optimisation the board does not need yet, and it would have put a second copy of the row shape in the page.

- [x] 4.1 Implement `src/model/row.ts`: every field of the three lines as text — the name with its disambiguating ancestor segment when two repositories share a base name, the divergence, the dirty glyphs, the evidence-age caption, the relative date and subject, the HEAD state, the kind marker and the review position
- [x] 4.2 Write tests for `row.ts` field by field: `↑2 ↓1`, one-sided divergence, nothing at all at zero, `no upstream`, `gone`, `checked 3h ago`, an absent `FETCH_HEAD` rendering nothing in that position, `no commits yet` on line 2 with the branch name alone on line 3, `detached at 7c86ebf`, `rebasing main 1/3`, each kind marker, and the review count in its single unpluralised form
- [x] 4.3 Write tests asserting the row never renders `↑0 ↓0`, never renders `0` in the dirty position, never renders `never checked`, `up to date`, `in sync` or `fetched`, and never renders a branch count
- [x] 4.4 Implement the text-safety rule for every field carrying repository text: HTML escaping, `<bdi>` isolation, and C0 and C1 control characters replaced with U+FFFD
- [x] 4.5 Write tests for text safety: a subject containing markup, a subject containing U+202E, and a subject containing a raw control character
- [x] 4.6 Implement `src/view/listHtml.ts`: the page skeleton, the content security policy of `default-src 'none'` with nonced style and script and nothing else, `localResourceRoots: []`, colours from `--vscode-*` variables with fallbacks, and inline SVG painted with `currentColor`
- [x] 4.7 Write tests for `listHtml`'s pure half: the exact policy string, carrying no `img-src`, no `font-src` and no `connect-src`; a fresh nonce per assignment appearing on the style and the script elements and nowhere else; and no colour literal outside a `--vscode-*` variable's final fallback
- [x] 4.8 Implement `src/view/listView.ts` as the `WebviewViewProvider` for `multirepoLedger.repositories`, assigning the page **once per generation** — a fresh discovery, a sort change, a filter change, a theme reload — and never once per arriving answer
- [ ] 4.9 Implement the per-row patch protocol on top of that: a tier-one answer as one patch addressed by `data-path`, a tier-two dirty answer as a smaller patch touching one span, and a re-order as a permutation applied in a single reinsertion pass
- [ ] 4.10 Write tests for the patch protocol's pure half: one arriving answer produces one patch naming one path, a dirty answer produces a smaller patch touching one span, a re-order produces a permutation rather than a re-render, and nothing in the sequence produces a second page assignment
- [x] 4.11 Implement the states that are not answers: `reading…` on a discovered row, the busy bar with `prefers-reduced-motion` honoured, the previous generation's rows kept dimmed beneath it, and the timed-out row with its command and Retry
- [x] 4.12 Implement the board-level states: `git` not on `PATH` stated once for the whole board, and the two incompleteness caveats — an index pass at its cap, and a walk that reached its directory budget
- [x] 4.13 Write tests for the degenerate rows from a hand-built model: every entry in the capability's table renders its stated text, no row is blank, and no row renders a zero it did not establish
- [x] 4.14 Implement the list's own empty states — nothing found, and nothing to scan — as page content whose controls post messages rather than navigate, and delete the two `viewsWelcome` blocks from `package.json`, which bind to a tree view the history pane is about to stop being
- [x] 4.15 Write tests for the empty states' pure half: the exact sentence each state prints, the controls each offers, and that every control is a posted message rather than a `command:` URI, which the policy admits no navigation for
- [x] 4.16 Implement `multirepoLedger.rowDensity` with `comfortable` and `compact`, the merged line that removes no field, and the view-title toggle that writes the setting so the choice survives a reload; declare the setting in `package.json`
- [x] 4.17 Write tests for density: compact merges lines 1 and 3, drops nothing, keeps the caption as the first field to yield, and never changes on its own with the repository count
- [x] 4.18 Implement `src/controller.ts` as a constructed object with its dependencies passed in, owning the generation counter and the `AbortSignal`, and doing nothing on construction
- [x] 4.19 Wire discovery into the list: every repository rendered in its pending state as discovery names it, before any git process has answered
- [x] 4.20 Wire the row read into the list: reads scheduled at the derived concurrency, each answer patched into its own row, and a stale generation's answer dropped at the boundary
- [x] 4.21 Replace the placeholder repositories provider in `src/extension.ts` with the controller, and remove the temporary `multirepoLedger.dumpBoard` command from task 3.25
- [ ] 4.22 Write tests for the controller's pure half — the order in which discovery and the read publish, and that a stale answer never reaches the board — and check by hand in the Extension Development Host that a fixture directory paints its rows from discovery and fills them in behind
- [x] 4.23 Implement the activation contract in `extension.ts`: register, schedule `controller.start()` with `setTimeout(..., 0)`, return `void`, and assert in a test that no module in its import graph performs I/O at module scope
- [x] 4.24 Implement the narrow-width yield order as a container query on the row, expressed in `ch` from the row's own content and the theme's own font, hiding the evidence age whole rather than truncating it
- [ ] 4.25 Check by hand in the Extension Development Host at three sidebar widths that the caption disappears whole, the subject truncates at its end, the name never vanishes, and the divergence, dirty glyphs and kind marker never yield

## 5. The Board — tallies, sorting, filtering, selection, watching

> **Built.** Landed in `src/controller.ts` and `src/view/order.ts`. The text filter is not built - the chips cover the questions the tally raises, and a search box over a list this size is the editor's own find. Selection is by path and drives the history pane.

- [x] 5.1 Implement `src/model/tally.ts`: a chip per state that earned one — `unpushed` leading, `behind`, `dirty` only while the second-tier read is on, `mid-operation`, `unreadable` — with each chip's count, its full sentence worded against the remote-tracking refs on this machine rather than against the remote, and the answered-of-discovered figure that qualifies every chip while the generation is incomplete
- [x] 5.2 Write tests for the tallies: `1 rebasing` at a count of one, no chip for `detached`, `no-upstream` or `clean`, no chip at a count of zero, no chip for a count that was never established, the sentence rendered when no chip has a count, the `unpushed` sentence never claiming the commits exist only on this machine, and the qualifier present while rows are unanswered and gone when they all are
- [x] 5.3 Implement `src/model/order.ts`: the four modes, the three ranks, ahead-descending as the divergence tie-break, the glyph rank for `dirty`, and `pathKey` as the final tie-break in every mode
- [x] 5.4 Write tests for ordering: the newest commit first by default, a repository with no commits landing in the no-key group rather than at the top, a repository with no upstream not ordered as `↑0 ↓0`, `!` ordered above `*` in the dirty mode with no entry count consulted, an unreadable repository last, and two passes over identical data producing an identical order
- [x] 5.5 Implement `src/model/filter.ts`: the state filter, the case-insensitive substring filter over the name, the subject and the rendered text of line 3, their AND composition, `showing N of M`, and the sentence an empty result prints
- [x] 5.6 Write tests for filtering: `rebasing` matching line 3, `worktree` and `no upstream` matching line 3, a subject match, both filters at once, an empty result naming what produced it, and an excluded repository absent from `M`
- [x] 5.7 Implement `src/model/board.ts` — `buildBoard(model, options)` returning the header and the rows in final order in one object — and make it the only thing the view renders
- [x] 5.8 Write tests for `buildBoard` from a hand-built model: header, chips, order and every row asserted field by field, with no extension host loaded
- [x] 5.9 Implement the chip strip in the page: each chip an accessible button carrying its sentence as its label, clicking the active chip clearing the filter, the active filter's sentence printed on its own line, and the answered-of-discovered qualifier rendered dimmed beside the chips while the generation is incomplete
- [x] 5.10 Implement the text input in the header and the `showing N of M` figure beside it, with `M` taken from what discovery established
- [x] 5.11 Implement the sort picker in the header, listing the four modes and reflecting the mode held in `workspaceState`
- [x] 5.12 Write tests for the header's pure half: the chip labels' exact wording, the qualifier's presence and absence, `showing N of M` computed from discovery's count rather than from the rendered rows, and the sort picker's option set matching `order.ts`'s modes exactly
- [x] 5.13 Implement message validation at the extension boundary: every mode, filter and action arriving from a page checked against the known set, with an unrecognised message ignored and logged
- [x] 5.14 Write tests for message validation: a sort mode stored by an older build is ignored and the current mode is unchanged
- [x] 5.15 Implement the re-order rule: a row moves at most once per generation, re-ordering is held while the pointer is inside the list or any row holds focus, and the queued permutation is applied on `mouseleave` or on blur
- [x] 5.16 Write tests for the re-order rule's pure half: a sequence of arriving answers moves each row at most once, and the module contains no settle timer and no timing constant
- [x] 5.17 Implement selection by absolute path: never made on the extension's own initiative, restored from `workspaceState` but read only when the history view first becomes visible, surviving a re-order, a filter change and a rescan
- [x] 5.18 Implement the keyboard contract: `role="listbox"` with a roving tabindex, arrows moving focus only, Enter or Space selecting, and the menu key opening the row's actions
- [x] 5.19 Write tests for selection: nothing selected on first render, the selection surviving a re-order and a filter change, and arrowing through the list spawning no process
- [x] 5.20 Implement the `dirty` sort mode's two side effects: selecting it enables the second-tier read if it is off and says so, and for as long as it is selected the read runs for every discovered repository rather than for the visible rows, because a key that exists only for the rows on screen freezes the rest of the board permanently
- [x] 5.21 Write tests for the dirty mode's side effects on the pure half: selecting the mode marks every discovered repository as needing the read rather than the visible ones, deselecting it returns to the visible-rows rule, and the order asked for is the glyph rank rather than an entry count
- [x] 5.22 Implement the second-tier dirty read for visible rows only, driven by what the page reports as visible, with a dimmed placeholder in the glyph slot between the tiers
- [x] 5.23 Write tests for the visible-rows rule: a board of two hundred rows showing twenty spawns twenty `status` processes, and scrolling one further row into view spawns its read then and not before
- [x] 5.24 Implement the two non-recursive watchers per repository — the git directory's top-level marker set and the reflog — and never the working tree, with a comment naming `files.watcherExclude` as the reason a recursive pattern is refused
- [x] 5.25 Implement event coalescing into a single debounce for the whole extension, the non-overlapping pass rule with a queue that never holds more than one, and the scoping of a watcher-triggered pass to the repositories the events named
- [x] 5.26 Write tests for the watcher pass: a burst of writes collapses into one pass, a repository hammered with events produces one further pass and not a backlog, and a pass triggered by one repository's events reads only that repository
- [ ] 5.27 Check by hand in the Extension Development Host: click each chip, type in the filter, change the sort, select the dirty mode on a board larger than one screenful and confirm every row acquires a key, commit in a terminal in one repository and watch that row alone update, and confirm the board never re-orders under the pointer

## 6. Row Hand-offs

> **Built.** Two hand-offs landed as inline row buttons - open in a new window, and copy the path. Reveal in Source Control, open a terminal and open the remote in a browser are declared in `RowAction` and wired in the controller but have no button yet.

- [x] 6.1 Implement `src/model/remoteUrl.ts`: the four accepted remote shapes converted to `https://host/owner/repo`, userinfo stripped, and everything else refused with a stated reason
- [x] 6.2 Write tests for `remoteUrl.ts`: https, http, the scp-like form, ssh with a port, a URL carrying `user:token@`, a `file://` URL, a bare local path, an `ext::` helper transport, and a string that parses as nothing
- [ ] 6.3 Implement `src/model/actions.ts` — `actionsFor(row)` — over the closed set of five hand-offs, deciding absence as deliberately as presence: no Open Folder on a bare repository, no Open Remote when no remote can be named, no Source Control action when the git extension is absent
- [x] 6.4 Extend `actionsFor` with the two failure-state actions: Retry on a row that timed out, and Copy the `safe.directory` command on a row git refused
- [x] 6.5 Write tests for `actionsFor`: an ordinary row, a bare row, a row still reading, a timed-out row, a refused row, a worktree row and a submodule row, asserting both the actions present and the actions absent, and asserting that no row ever offers a sixth hand-off or any action that changes the current window's workspace folders
- [ ] 6.6 Implement `src/view/handoffs.ts` for the path actions: Open Folder in New Window with `forceNewWindow`, Open in Terminal with `cwd` and no `sendText`, and Copy Path in the platform's own separators
- [ ] 6.7 Check by hand in the Extension Development Host that Open Folder opens a second window leaving the first window's folders, board and history pane exactly as they were; that Open in Terminal starts in the repository with nothing typed into it and does not commandeer an existing terminal; and that Copy Path yields the platform's own separators and the git directory for a bare repository
- [ ] 6.8 Implement Show or Reveal in Source Control against the git extension's exported `getAPI(1)`, labelled by what it will actually do, with the tooltip on Show saying it adds the repository to the Source Control view for this window
- [ ] 6.9 Write tests for the Source Control label decision, and check by hand that a full discovery-and-read pass over forty repositories adds nothing to the Source Control view and changes no file decoration
- [ ] 6.10 Implement Open Remote in Browser: one `git config --get remote.<name>.url` at click time, the remote chosen as HEAD's upstream, then `origin`, then the sole remote, and `env.openExternal` called only on an allowlisted URL
- [x] 6.11 Write tests for the remote choice and its failure path: the upstream's remote preferred over `origin`, two remotes with neither an upstream nor an `origin` offering no action, and a non-zero exit stated with its command and no fallback to parsing `.git/config`
- [x] 6.12 Implement both routes to the same list: the `webview/context` menu with `data-vscode-context` on each row, and the menu key opening the same list as a quick pick, with one inline hover action that is not in the tab order
- [ ] 6.13 Write tests for the two routes' pure half — both render `actionsFor(row)` unchanged and in the same order — and check by hand that tabbing out of the list stops on no per-row inline button
- [x] 6.14 Confirm the `webview/context` mechanism against the declared engine floor of `^1.104` before the row markup depends on it; if it is unavailable there, ship the quick pick alone and record the finding in `design.md` beside D51
- [x] 6.15 Implement the vanished-target rule: a hand-off whose target is gone states the failure naming the absolute path, the row is re-read so it takes its own unreadable state, and the row is not removed from the board
- [x] 6.16 Write tests for the vanished-target rule against a fixture directory deleted between the scan and the call, and assert that the extension never creates a missing target
- [ ] 6.17 Check by hand: every action on an ordinary row, a bare row, a reading row and a refused row, and confirm by reading the command palette and both view-title menus that no command acts on more than one repository and none fetches, pulls or prunes

## 7. The History Pane — the read and the parse

> **Built.** Landed as `src/read/{history,commitFiles}.ts` with adjacent tests. Unpushed commits come from a second `rev-list --not --remotes`, asked for only when the row already said there was something ahead.

- [x] 7.1 Change `multirepoLedger.history` to `"type": "webview"` in `package.json`, confirming the two `viewsWelcome` blocks removed in task 4.14 have their replacements in the list's own empty states
- [x] 7.2 Implement `src/history/log.ts`: the page command with every flag, the rev set of `HEAD` plus the upstream ref the row read already knows, `--max-count` and `--skip`, and the exact argument list written to the log as it was run
- [x] 7.3 Write tests for the page command: the argument array asserted, `--no-optional-locks` before the subcommand, `--` last, the upstream ref omitted when there is none, and `--include-root-refs` never appearing here
- [x] 7.4 Implement `src/history/parse.ts`: NUL-terminated records, `0x1F` fields, the bounded seven-way split with the subject taken verbatim to the end, and a record whose first field is not an object id of the repository's hash length discarded with a log line
- [x] 7.5 Write tests for the parser against fabricated streams: a subject with a tab, a subject with a `0x1F`, an author name with a `0x1F` costing exactly one wrong row, a malformed record discarded with every other commit rendering, and the module loading under `node --test` with no extension host
- [x] 7.6 Implement unpushed marking from `%P` and the `--date-order` guarantee: mark the upstream tip, propagate through parents, mark a commit emitted before the tip as unpushed, and hold the marking state — the on-upstream hash set and whether the tip has been seen — **per selection rather than per page**, so that page two of a repository whose tip fell on page one is not marked wholesale
- [x] 7.7 Write tests for the marking against a fixture repository with three local commits and a merge: the marked set compared with `git log HEAD --not <upstream> --format=%H`, a two-page walk whose tip falls on the first page marking nothing on the second, a reload discarding the carried state and re-deriving it, and nothing marked and nothing said when no upstream took part in the walk
- [x] 7.8 Implement `src/history/chips.ts`: the split on comma-followed-by-space, the classification table keyed on the full ref name, the suppression of `refs/remotes/*/HEAD`, and the fixed group order with alphabetical ordering inside each group
- [x] 7.9 Write tests for the chips: a fresh clone's three-part decoration, a tag and a branch of the same name told apart, a branch named `feature,wip` kept whole, an unrecognised ref shown rather than dropped, and the bare token `HEAD`
- [x] 7.10 Implement `src/history/rawdiff.ts`: the combined `--raw --numstat -z` parser, the section boundary told from the first character of a record, and the rename record's two NUL-terminated paths consumed in both sections
- [x] 7.11 Write tests for `rawdiff.ts` against a fabricated stream holding a rename, a path with a space, a path with a tab, a mode-only change with identical blob ids, a binary file reporting `-` for both counts, and a deletion
- [x] 7.12 Implement the expansion command: the ordinary form with `--root`, and the two-tree form against a chosen parent for a merge, with the parent identified from `%P` at no process cost
- [x] 7.13 Write tests for the expansion commands: the exact argument arrays, `-M` passed explicitly so `diff.renames=false` cannot split a rename in two, a truncated read classified as a failure rather than a short list, and a successful read of zero records distinguished from both
- [x] 7.14 Build a fixture repository in a scratch directory covering a root commit, a rename, a binary file, a mode-only change, an empty commit, a merge, a merge whose diff against its first parent is empty, a detached HEAD, an unborn branch and a shallow clone, and run the page reader, the marker and the expansion reader against every one of them

## 8. The History Pane — the surface

> **Built.** Landed as `src/view/historyRow.ts` (pure, tested) and `src/view/historyPanel.ts`. The diff opens through `src/git/blobFileSystem.ts`, a read-only provider over `git cat-file`, because the built-in `git:` scheme cannot serve a repository the editor has not opened.

- [x] 8.1 Extract the page skeleton, the content security policy and the keyboard contract into one module both webviews use, and confirm the list of phase 4 renders from it unchanged
- [x] 8.2 Implement `src/view/historyHtml.ts` on that skeleton: the pane's regions — the banner area, the commit list, the expansion block and the end-of-list controls
- [x] 8.3 Implement `src/view/historyView.ts` as the `WebviewViewProvider` for `multirepoLedger.history`, and replace the placeholder history provider in `src/extension.ts` with it
- [x] 8.4 Write tests for the shared skeleton's pure half: one policy string serving both panes, a fresh nonce per assignment, and the same keyboard map reported for both
- [x] 8.5 Implement the commit row at a fixed height: the committer date, the subject, the ref chips, the unpushed marker carried by a glyph as well as a colour, and the author name as the field that yields first
- [x] 8.6 Implement the chip strip's overflow: chips laid out in priority order, the ones that do not fit collapsed into one `+N` chip listed on hover and on focus, the HEAD chip never collapsing, and the subject never sacrificed for a chip
- [x] 8.7 Write tests for the row's pure half: the field order, the yield order at decreasing widths, the chip overflow set, and that chips never wrap to a second line
- [x] 8.8 Implement the caveat banners rendered above a non-empty list: mid-rebase naming the branch and the step, shallow, bare, the fetch-age statement, the retained-commit cap, and a truncated page
- [x] 8.9 Write tests for the banner decisions from a hand-built model: two caveats visible at once, the rebase banner naming its target by short object id and never by a resolved branch name, and unreadable marker files dropping the banner silently
- [x] 8.10 Implement paging: the first page derived from the pane's own geometry times an overscroll factor, clamped by a floor and a ceiling that are guards, smaller later pages, and `multirepoLedger.history.pageSize` overriding the derivation when above zero
- [x] 8.11 Write tests for the paging arithmetic: a pane collapsed to a sliver yields the floor, a pane dragged tall yields the ceiling, the setting overrides both, and no literal in the derivation came from a measurement
- [x] 8.12 Implement the two ways to ask for more: the `IntersectionObserver` sentinel at the end of the list, and an explicit keyboard-reachable Load more control, which is not redundant because the observer does not fire in a collapsed pane
- [x] 8.13 Implement the `--skip` hazard rule: keep the set of commit ids already shown, and reload from the first page rather than appending when a fetched page repeats one, discarding the carried unpushed-marking state with it
- [x] 8.14 Write tests for the hazard rule: a page containing an already-shown id triggers a reload, no commit appears twice, and the reload does not carry the abandoned walk's marking state
- [x] 8.15 Implement the retained-commit cap as `multirepoLedger.history.maxRetainedCommits`, a guard rather than a knob: on reaching it the pane states that it is showing the most recent commits and stops offering more, rather than silently ceasing to respond
- [x] 8.16 Write tests for the cap at its boundary: the last page that fits below the cap appends, the page that would cross it is not requested, the pane states the cap and withdraws the Load more control, and the pane still answers every other interaction
- [x] 8.17 Implement the expansion in the page: at most one commit expanded at a time, the reading state inside the expanded block, and the caption saying once per list that clicking opens the file as it is now
- [x] 8.18 Implement the four exact file-row renderings — a rename as one row, a binary file as `binary`, a mode-only change as `mode 100644 → 100755`, and an empty commit stated as changing no files — plus the `+N more` bound counted from records parsed
- [x] 8.19 Write tests for the expansion rendering from a parsed file list: each of the four cases, a truncated list stated as a failure with no total shown, and a bounded list whose `N` comes from records actually parsed
- [x] 8.20 Implement the merge case in the page: the list computed against the first parent by default, the pane stating which parent it is against, the other parents selectable at one further process each, and a merge whose diff against the named parent is empty stated as changing nothing against that parent rather than rendered blank
- [x] 8.21 Write tests for the merge case's pure half: the parent named in the statement is the one the command ran against, an empty successful result yields the statement rather than a blank block or a failure, and the other parents are offered in the order `%P` gave them
- [x] 8.22 Implement the file click: `vscode.open` on a `file:` URI built from the working-tree root, disabled with its reason on a deletion, opening the new path on a rename, and unavailable for a bare repository with the reason stated once
- [x] 8.23 Write tests for the file action's pure half: the URI built from the working-tree root and the repository-relative path, a deletion yielding a disabled action carrying its reason, a rename yielding the new path, and a bare repository yielding the action absent with one reason for the whole list
- [x] 8.24 Implement the file row's context menu: copy the repository-relative path, reveal in the Explorer, and run `git show <full hash> -- <path>` in a terminal opened at the repository
- [ ] 8.25 Check by hand that the file row's context menu offers its three entries on a rename, a deletion and a binary file, and that the terminal hand-off runs `git show` with the full hash in a terminal opened at the repository
- [x] 8.26 Implement the selection generation: the pane clears and names the newly selected repository **before** any process starts, the in-flight child is killed, and output from a superseded generation is discarded whether or not the kill succeeded
- [x] 8.27 Write tests for the selection generation: the clear is ordered before the spawn, superseded output is dropped on arrival, an in-flight expansion is cancelled with its repository, and the board's row reads are not cancelled by a selection
- [x] 8.28 Implement the degenerate panes that cost no process — no commits, unreadable, refused for dubious ownership, no `git` on `PATH` — each decided from facts the row read and the walk already hold
- [x] 8.29 Write tests for the degenerate panes: an unborn HEAD spawns nothing and is not reported as a failed read, and an unreadable repository repeats its row's reason and spawns nothing
- [x] 8.30 Implement the visibility, refresh and disposal rules: hide and reveal re-render from what is held, a window reload re-reads the first page, a board refresh leaves the pane's selection, pages and scroll offset alone, and disposal kills every child
- [ ] 8.31 Write tests for the visibility rules' pure half — hide and reveal yields no read, a window reload yields one, a board refresh yields none — and check by hand that the scroll offset survives each of the three
- [x] 8.32 Implement the retry affordance on a failed page or expansion, since a stated failure with no way to ask again leaves the pane dead until the selection is changed and changed back
- [x] 8.33 Write tests for the retry state machine: a failed page becomes a stated failure carrying its command, retry returns it to a reading state, and a retry that fails again does not clear the commits already on screen
- [x] 8.34 Declare `multirepoLedger.history.pageSize` and `multirepoLedger.history.maxRetainedCommits` in `package.json`, each described as a guard against an unbounded read rather than as a speed control
- [ ] 8.35 Check by hand in the Extension Development Host against the phase 7 fixture repository: select, page to the end, expand a commit, choose a merge's other parent, open a file, and switch repositories while a page is still in flight

## 9. The Forge Layer — and it is off when it lands

> **Built.** Landed as `src/forge/{remote,cli,counts}.ts` with tests for the pure halves. It is off by default. Queries are batched by owner, a truncated answer renders as `41+` rather than as a total, and a host with no client shows nothing rather than a zero.

- [x] 9.1 Implement `src/forge/plan.ts`: parse each repository's git-directory configuration for a remote URL through `model/remoteUrl.ts`, treat the result as a hint rather than an authority, and group repositories by `(host, owner)` at zero process cost
- [x] 9.2 Write tests for the plan: forty repositories under three owners produce three queries, a repository with no remote produces none, and a repository the parse could not group reports an unestablished count rather than joining another namespace
- [x] 9.3 Implement `src/forge/overlay.ts`: the `ForgeCount` union, the in-memory cache keyed by `(host, owner)` with the time it was fetched, and the join onto the model performed in the controller with no import from `read/`
- [x] 9.4 Write tests for the overlay: an established zero renders, an unestablished count never renders as zero, and deleting `src/forge/` leaves `npm run compile` green and the board discovering, reading and rendering
- [ ] 9.5 Establish `gh search`'s own result ceiling against a real host — whether it caps below a requested limit, and whether it reports doing so — **before** a limit is chosen, and record the answer in `design.md` beside D56, because a truncation test that compares only against the requested limit never fires under a lower ceiling
- [ ] 9.6 Implement `src/forge/github.ts`: `gh search prs --owner <owner> --state open --limit <n> --json repository,number,title,url,isDraft,updatedAt`, with `GH_HOST` set for a non-default host and the command written to the log as it was run
- [x] 9.7 Implement the truncation rule on the GitHub side: the limit set explicitly, an answer treated as truncated when its row count equals the requested limit **or** any limit the CLI reports applying, the requested limit written to the log beside the returned count, and every repository in a truncated namespace reporting silence rather than a smaller number
- [x] 9.8 Write tests for the GitHub adapter against captured output: a namespace under the limit yielding per-repository counts including established zeros, an answer exactly at the requested limit yielding `answer truncated` for every repository including those named in it, an answer at a lower ceiling the CLI reported yielding the same, and unparseable output yielding a reason
- [ ] 9.9 Check the GitHub coverage assumption against a real host with a deliberately under-scoped credential: a private repository the credential cannot read must not render `0 PR`. Record the answer in `design.md` beside D58 and in the Risks section, and if the assumption is refuted, withdraw the established zero on the GitHub side rather than keeping it
- [ ] 9.10 Implement `src/forge/gitlab.ts`: `glab mr list --group <group> --state opened --per-page <n> --output json`, with the group listing covering only that group and any non-zero exit, unparseable output or unrecognised flag resolving to a stated reason
- [x] 9.11 Write tests for the GitLab adapter against captured output, including a project in a personal namespace reported unestablished with no per-project query issued and the log naming what would have answered
- [x] 9.12 Implement the serialised queue: one forge child at a time, in order, with no query ever scoped to a single repository even as a fallback
- [x] 9.13 Implement failure classification from exit code and stderr into `not installed` (the first `ENOENT`, remembered for the window), `not signed in`, `<host> not signed in`, `rate limited` and `answer truncated`, with no automatic retry
- [x] 9.14 Write tests for the queue and the classification: the second query does not start before the first exits, a rate limit leaves every remaining owner reporting silence, no repository shows `0`, and Refresh is the only way back
- [x] 9.15 Implement the host-keying invariant: an answer is applied only to repositories whose remote names the host the query ran against, so a `github.com` answer can never populate an enterprise or GitLab row
- [x] 9.16 Write tests for the invariant: the same organisation name on two hosts, and a `gh` answer never reaching a GitLab row
- [x] 9.17 Implement the three moments a query may be issued — the list first populated with the layer on, an explicit Refresh, and the setting being switched on — and prove no watcher event and no timer issues one
- [x] 9.18 Write tests for the three moments: a watcher pass issues nothing, an idle window issues nothing, switching the setting off kills the child in flight and discards its answer, and switching it on issues one query per owner
- [x] 9.19 Implement the review position on line 3: nothing while the layer is off, the dimmed pending form while a covering query is outstanding, the established count with the forge's own word, and a dimmed reason otherwise
- [x] 9.20 Write tests for the review position's four renderings, the single unpluralised form settled once in `model/row.ts`, and the header sentence counting the repositories that could not be asked
- [ ] 9.21 Verify against a live host whether `gh search prs --owner` accepts several owners in one invocation, which is currently unverified, and record the answer in `design.md` beside D56 rather than assuming either way
- [ ] 9.22 Verify the `glab` flag spelling and output shape against a real `glab` and a real GitLab, and correct `forge/gitlab.ts` from what it says; until that is done the adapter fails to silence, which is the ship-safe state and not a substitute for the check
- [x] 9.23 Confirm after the layer lands that `multirepoLedger.forge.enabled` still defaults to `false`, that a default installation spawns neither CLI and writes no forge command to the log, and that no setting for a token, an account or an API base URL exists anywhere in the manifest

## 10. Packaging and Release

> **Where this change stands.** Everything from group 0 to group 9 is on disk and
> covered by tests that build real repositories and drive them into the states
> they assert on. What is left open below is of one kind: **checks a person has
> to make with their eyes, and verifications against a live host.** They are
> unticked because nobody has made them, not because they are hard — and a box
> ticked for a check nobody performed is the one entry in this file that would be
> worse than an empty one.
>
> Also unticked, in groups 4 to 9, are the tasks describing work that was
> deliberately built differently or not at all: the per-row patch protocol (the
> page re-renders per publish instead), the text filter (the chips answer the
> questions the tally raises), three of the five row hand-offs (Open Folder and
> Copy Path shipped; Reveal in Source Control, Open in Terminal and Open Remote
> are wired but have no button), and the `glab` path, which is implemented and
> unit-tested but has never met a real `glab`.


- [x] 10.1 Correct `openspec/project.md` and `openspec/config.yaml` where the research refuted them, in both places the refuted premise is written: `project.md`'s paragraph under "The problem", three lines above the table that already disproves it, and `config.yaml`'s `context:` block, which is the text every future OpenSpec session in this project reads as authority. In both: core's row already carries branch and ahead/behind, GitLens sees repositories outside the workspace through SCM events, the directory-as-the-unit walk is occupied by two seven-figure extensions that show no state, and the discovery advantage is repositories deeper than one level or in directories never opened
- [x] 10.2 Write the README: the last commit on the row and the sort by it stated first, the settings table saying for each setting whether it is a guard or a preference, the recursive-discovery note, and the honest half about unproven demand
- [x] 10.3 Write the CHANGELOG covering the phased releases, and say in the 0.3.0 entry that clicking a file opens the working copy and why the diff is not there yet
- [ ] 10.4 Read the whole source for the two rules that cannot be unit-tested: no numeric literal anywhere derives from a measurement, and every guard's comment names the failure it prevents rather than a speed it achieves
- [ ] 10.5 Confirm the eslint `no-restricted-imports` rule keeps `vscode` out of every module except `extension.ts`, `controller.ts`, `view/` and `discovery/vscodeSearch.ts`, and that `npm test` loads every pure module without an extension host
- [ ] 10.6 Read a full session's log with the forge layer off and then on, and confirm the closed subcommand set — `--version`, `for-each-ref`, `config --get`, `status`, `log`, `diff-tree`, and `log -1` on an old git — and the three outbound paths, with no `fetch`, no `ls-remote` and no `cat-file`
- [ ] 10.7 Run the empty and unreadable states by hand in the Extension Development Host: no workspace folder and no additional root, a root holding no repository, no `git` on `PATH`, a repository git refuses for dubious ownership, and a repository on an unreachable mount
- [ ] 10.8 Run the unusual-repository states by hand in the Extension Development Host: a repository with no commits, a bare repository, a mid-rebase repository, a linked worktree, an initialised submodule beneath an open folder with `multirepoLedger.includeSubmodules` off, and a directory of repositories in a window with no folder open
- [ ] 10.9 Package with `npx @vscode/vsce package` and install the resulting file into a clean VS Code profile, checking that the extension does not activate in Restricted Mode and contributes nothing in a virtual workspace
- [ ] 10.10 Archive this change and promote its six spec deltas into `openspec/specs/`, recording in `design.md` every "Open against design" item the implementation settled and how
