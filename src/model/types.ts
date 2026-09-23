/**
 * The whole data model of the extension, in one place.
 *
 * Every module below `src/` reads or produces these shapes, so this file is the
 * contract between them. It contains types only - the helpers that operate on
 * them live in `src/model/keys.ts`.
 *
 * Dependency direction: view and read depend on model; discovery depends on
 * model; model depends on nothing. Nothing depends on view.
 *
 * One property matters more than any other here, and most of the optionality
 * below exists to preserve it: **a fact the extension has not established must
 * be a different value from a fact it has established as zero**. A repository
 * whose working tree has not been read yet and a repository that is clean are
 * not the same row, and the type system is where that distinction is kept
 * honest, because by the time it reaches the webview it is one string.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * What kind of thing the walk found.
 *
 * Shallowness is deliberately not in this union: a shallow clone is still a
 * plain repository, and folding the two together would mean a shallow worktree
 * had to pick one of them to be.
 *
 * `unknown` is here for the same reason `WorkingTree` has a `not-read` case: a
 * `.git` file that will not open, or one whose `gitdir:` points at nothing, is
 * a repository whose kind was never established, and the only other honest
 * option would be to call it `plain` - which would put a repository the
 * extension cannot read anywhere near the rows it can. Such a repository
 * always carries `problem` as well, and the row shows that rather than a kind
 * marker.
 */
export type RepositoryKind = 'plain' | 'worktree' | 'submodule' | 'bare' | 'unknown';

/** Where a repository came from, which decides how it is labelled and grouped. */
export type RepositorySource = 'workspace' | 'settings';

/**
 * One repository, as discovery knows it. No git process has run yet: everything
 * here was decided from the filesystem.
 */
export interface DiscoveredRepository {
  /**
   * Absolute path of the working tree - the directory that *contains* `.git`.
   * This is the working directory every git command is spawned in, and the
   * identity a row is keyed by.
   */
  path: string;
  /**
   * Absolute path of the real git directory. For a plain repository that is
   * `<path>/.git`; for a linked worktree or a submodule it is wherever the
   * `.git` *file* pointed, which is somewhere inside the parent repository.
   */
  gitDir: string;
  /** Path shown in the list: relative to its workspace folder, else the directory name. */
  label: string;
  kind: RepositoryKind;
  /**
   * The repository has no complete history. Kept beside `kind` rather than in
   * it, because it is orthogonal to what kind of checkout this is, and because
   * it changes what the row may claim: a shallow clone's divergence figures are
   * computed against a truncated graph.
   */
  shallow: boolean;
  source: RepositorySource;
  /** Absolute path of the workspace folder containing this repository, when it is inside one. */
  workspaceFolder?: string;
  /**
   * Set when the repository could not be classified - an unreadable `.git`
   * file, a `gitdir:` pointing nowhere. The repository is still returned, with
   * its reason, because a row that says why is worth more than a row that is
   * silently missing.
   */
  problem?: string;
}

// ---------------------------------------------------------------------------
// What HEAD is doing
// ---------------------------------------------------------------------------

/**
 * Where HEAD points.
 *
 * A discriminated union rather than a branch name plus flags: the cases carry
 * different fields, and a `{ branch: string | undefined; detached: boolean }`
 * shape makes it possible to write - and therefore eventually to write by
 * accident - a detached HEAD that also has a branch name.
 */
export type HeadState =
  /** On a branch with at least one commit. */
  | { readonly kind: 'branch'; readonly name: string }
  /** Detached: a checkout of a commit, a tag, or a rebase in progress. */
  | { readonly kind: 'detached'; readonly sha: string }
  /**
   * A repository with no commits at all - `git init` and nothing since. HEAD
   * names a branch that does not exist yet, so there is a name but no commit,
   * and none of the arithmetic below applies.
   */
  | { readonly kind: 'unborn'; readonly name: string }
  /**
   * No git process has answered for this repository yet.
   *
   * Discovery names a repository long before git does - the walk is filesystem
   * work - and the list renders a row for it immediately, so a row exists whose
   * HEAD nobody has read. That state needs a value of its own rather than a
   * fabricated `{ kind: 'branch', name: '' }`, because the presentation layer
   * has to be able to tell "not read" from "read, and on a branch": the first
   * renders `reading...` on line 2 and sorts into the group with no key, the
   * second renders a commit. A placeholder branch would make it render as an
   * answered repository whose every field happened to be empty, which is the
   * exact wrong impression this model exists to prevent.
   */
  | { readonly kind: 'unknown' };

/** What git is in the middle of, which no `status --porcelain=v2` output mentions. */
export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/**
 * A git operation left running.
 *
 * Every field but `kind` is optional because all of them are recovered from
 * files that are git's implementation detail rather than its published
 * interface. When a detail file is missing the operation is still reported -
 * "rebasing" with no step count is a true and useful thing to say, and is much
 * better than either guessing a step or dropping the state entirely.
 */
export interface Operation {
  readonly kind: OperationKind;
  /** Current step, when `rebase-merge/msgnum` or `rebase-apply/next` could be read. */
  readonly step?: number;
  /** Total steps, from `rebase-merge/end` or `rebase-apply/last`. */
  readonly total?: number;
  /** Short name of the branch being rebased, from `rebase-merge/head-name`. */
  readonly branch?: string;
  /** Short name of the branch being rebased onto, when it could be read. */
  readonly onto?: string;
}

// ---------------------------------------------------------------------------
// Divergence from the upstream
// ---------------------------------------------------------------------------

/**
 * How far the current branch is from its upstream.
 *
 * Four cases, and the reason they are four rather than a pair of numbers is the
 * whole point of this type: **"no upstream", "the upstream is gone", "in sync"
 * and "ahead 0, behind 0" are not the same fact**, and three of them are not
 * zero. A dashboard that renders all four as a quiet `0` is the specific way
 * every multi-repository view lies to its reader.
 *
 * `unknown` is the fifth: the read did not finish, so nothing may be claimed.
 */
export type Divergence =
  /** The branch tracks `upstream` and the two agree. */
  | { readonly kind: 'in-sync'; readonly upstream: string }
  /** The branch tracks `upstream`; `ahead` and/or `behind` are non-zero. */
  | { readonly kind: 'diverged'; readonly upstream: string; readonly ahead: number; readonly behind: number }
  /** The branch tracks nothing. There is no question to answer, not an answer of zero. */
  | { readonly kind: 'no-upstream' }
  /** The branch tracks a ref that no longer exists on the remote. */
  | { readonly kind: 'gone'; readonly upstream: string }
  /** Not established: unborn HEAD, a truncated read, or a command that failed. */
  | { readonly kind: 'unknown' };

// ---------------------------------------------------------------------------
// The last commit
// ---------------------------------------------------------------------------

/**
 * The commit at HEAD. This is the field the whole extension exists for: no
 * other multi-repository surface puts it on the row, and the default ordering
 * is by its date.
 */
export interface LastCommit {
  /** Abbreviated hash, as git abbreviated it - never truncated by this extension. */
  readonly shortSha: string;
  /** Committer date in whole seconds since the epoch. */
  readonly committedAt: number;
  /** The commit's first line. */
  readonly subject: string;
  readonly author: string;
}

// ---------------------------------------------------------------------------
// Working-tree state
// ---------------------------------------------------------------------------

/**
 * What `status --porcelain=v2` counted.
 *
 * Only ever produced by a completed read. The *absence* of this object on a row
 * is what says the second-tier read has not run or has not returned, which is
 * why the counts inside it are plain numbers: once you hold one of these, every
 * number in it was measured.
 */
export interface DirtyCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

/**
 * The working tree, including the two states that are not counts.
 *
 * `not-read` is the value a row carries until the opt-in second-tier read
 * returns for it, and it exists so that no caller can accidentally treat a
 * missing answer as a clean tree. `incomplete` is the same idea for an answer
 * that arrived truncated or failed: something is known to be wrong, so the row
 * must not claim the tree is clean.
 */
export type WorkingTree =
  | { readonly kind: 'not-read' }
  | { readonly kind: 'counted'; readonly counts: DirtyCounts }
  | { readonly kind: 'incomplete'; readonly reason: string };

// ---------------------------------------------------------------------------
// How fresh the divergence figure is
// ---------------------------------------------------------------------------

/**
 * When this repository last *attempted* a fetch.
 *
 * The word "attempted" is load-bearing and is why this is a union rather than
 * an optional number. The evidence is the mtime of `FETCH_HEAD`, and that file
 * is touched by a fetch that returned nothing, truncated but still touched by a
 * fetch that failed, absent entirely after a clone, and suppressible with
 * `--no-write-fetch-head`. So it proves an attempt and never a success.
 *
 * Everything downstream of `Divergence` is only as true as this, because
 * ahead/behind is computed against a remote-tracking ref that is exactly as old
 * as the last fetch. `no-record` must therefore render as silence: a row that
 * says "in sync" with nothing behind it is the failure this type prevents.
 */
export type FetchEvidence =
  /** `FETCH_HEAD` exists; this is its modification time, in seconds since the epoch. */
  | { readonly kind: 'attempted'; readonly at: number }
  /** No `FETCH_HEAD`. Nothing may be said about how current the divergence is. */
  | { readonly kind: 'no-record' };

// ---------------------------------------------------------------------------
// A failed read
// ---------------------------------------------------------------------------

/**
 * Why a repository could not be read.
 *
 * `command` is not optional and is not a nicety: the extension's whole claim is
 * that it only ever reads, and the way a user checks that claim - or debugs a
 * repository git refuses - is by retyping the command themselves. A row that
 * says "could not read" without saying what was run is unfalsifiable.
 */
export interface ReadFailure {
  /** The command as a user could retype it, from `formatCommand` in util/git.ts. */
  readonly command: string;
  /** git's own stderr, trimmed. Quoted rather than paraphrased. */
  readonly stderr: string;
  /** Short reason for the row: `timed out`, `git refused this directory`, ... */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * What a repository looks like from across the room.
 *
 * A small closed set rather than a number to interpret, and deliberately not a
 * composite "health" score: the point of the list is that a reader sees the
 * state of twenty repositories without opening any of them, and a score would
 * hand them arithmetic to do instead of a word to read. Where a repository is
 * in more than one of these states at once, `rowStateOf` in `view/row.ts` owns
 * the precedence and states it in one place.
 */
export type RowState =
  /** Nothing to do: in sync, nothing uncommitted. */
  | 'clean'
  /** Uncommitted work in the tree. */
  | 'dirty'
  /** Commits that exist only on this machine. */
  | 'unpushed'
  /** The upstream has commits this checkout does not. */
  | 'behind'
  /** Both of the above. */
  | 'diverged'
  /** HEAD is not on a branch. */
  | 'detached'
  /** A merge, rebase, cherry-pick, revert or bisect was left running. */
  | 'operation'
  /** The branch tracks nothing, so no divergence question exists. */
  | 'no-upstream'
  /** `git init` and nothing since. */
  | 'unborn'
  /** git would not answer. The row carries the command and the reason. */
  | 'unreadable'
  /**
   * Nothing has been established about this repository yet.
   *
   * The state a row carries between discovery naming it and a git process
   * answering for it, and the state a row falls back to when the read returned
   * but left the divergence unestablished. It is not `clean`, and keeping it
   * out of `clean` is the whole reason it exists: a board that files every
   * unanswered repository under "fine" flatters the reader for exactly as long
   * as the scan is running, which is the moment they are most likely to look.
   */
  | 'unknown';

export const ROW_STATES: readonly RowState[] = [
  'clean',
  'dirty',
  'unpushed',
  'behind',
  'diverged',
  'detached',
  'operation',
  'no-upstream',
  'unborn',
  'unreadable',
  'unknown',
];

/**
 * One repository, fully read - the input to the pure presentation layer.
 *
 * Discovery facts and read facts are both here rather than nested, because
 * every consumer wants them together and the nesting only ever added a level to
 * every access. What is *not* here is any string the webview renders: those are
 * produced by `view/row.ts` from this, so that every label is decided in a
 * module with no `vscode` import and is unit-tested there.
 */
export interface RepositoryRow {
  readonly repository: DiscoveredRepository;
  readonly head: HeadState;
  readonly divergence: Divergence;
  readonly operation?: Operation;
  /** Absent for an unborn repository, and for a read that failed. */
  readonly lastCommit?: LastCommit;
  readonly workingTree: WorkingTree;
  readonly fetch: FetchEvidence;
  /**
   * Present exactly when the row is `unreadable`. The two travel together so
   * that a row can never be marked unreadable without saying why.
   */
  readonly failure?: ReadFailure;
  /**
   * The read returned but was cut short - `GitResult.truncated`, or output that
   * stopped mid-record. What is here is true; what is missing is unknown. Kept
   * separate from `failure` because a partial answer still renders a useful row
   * and a failed one does not.
   */
  readonly incomplete?: string;
  /**
   * Open merge or pull requests, when the forge layer was on and could answer.
   *
   * Absent means nobody asked - the layer is off, or this host has no client
   * this version speaks. That is deliberately a different value from
   * `{ kind: 'counted', open: 0 }`, which means the question was put and the
   * answer was none. Collapsing the two would put a confident zero beside every
   * repository on a machine where `gh` is not installed.
   */
  readonly review?: ReviewState;
  /**
   * The primary remote's URL, read from `.git/config` rather than asked of git.
   *
   * Absent when the repository has no remote, which is a state and not a
   * failure: a repository nobody publishes has no review question to answer.
   */
  readonly remoteUrl?: string;
}

/** What is known about a repository's open reviews. See `RepositoryRow.review`. */
export type ReviewState =
  | {
      readonly kind: 'counted';
      readonly open: number;
      /**
       * The owner query returned as many results as it was allowed to fetch, so
       * this is a floor rather than a total.
       *
       * Without this a truncated answer renders as an exact one, which is the
       * same failure as a zero nobody established: the reader has no way to tell
       * that the number stopped short. The row draws it as `41+`.
       */
      readonly atLeast?: boolean;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * One repository as the page draws it: every string already decided.
 *
 * This is the boundary between the pure presentation layer and the webview.
 * `view/row.ts` produces it from a `RepositoryRow`; the page places the fields
 * and decides nothing, so that every judgement on the row - what state it is
 * in, which words describe it, which fields are silent - is made in a module
 * with no `vscode` import and is unit-tested there.
 *
 * The optional fields carry the model's central property across the boundary,
 * and the distinction survives one more step than it looks: an **absent**
 * field is a fact nobody established, an **empty string** is a fact
 * established to have nothing to say. Both render as nothing, and they differ
 * in the tooltip - `divergence: ''` means the branch is level with its
 * upstream, `divergence` absent means the read never established where it
 * stands. Collapsing the two here would put the guessing back into the page.
 */
export interface RenderedRow {
  /** Absolute working-tree path: the row's identity, and what a click sends back. */
  readonly path: string;
  readonly state: RowState;
  /** Line 1: the repository directory's base name. Never truncated away. */
  readonly name: string;
  /**
   * Line 1: the dimmed ancestor segment drawn ahead of the name, present only
   * when another row on the board shares this base name.
   */
  readonly qualifier?: string;
  /** Line 1: `^2 v1`; `''` when established as level; absent when not established. */
  readonly divergence?: string;
  /** `no upstream` and `gone` are words about the branch and render dimmed; the figures do not. */
  readonly divergenceDimmed: boolean;
  /** Line 1: `*`, `+`, `!`; `''` when counted and clean; absent when the tree was not read. */
  readonly dirty?: string;
  /** Line 1, dimmed and trailing: `checked 2h ago`. Absent when there is no record of a fetch. */
  readonly freshness?: string;
  /** Line 2, leading: `3h ago`. Absent when there is no commit to date. */
  readonly age?: string;
  /**
   * Line 2: the commit subject in full, or the sentence that stands in for it.
   * Truncation is the page's, because it depends on a width only the page
   * knows; the tooltip carries this text whole either way.
   */
  readonly subject: string;
  /** Line 3: `main`, `detached at 7c86ebf`, `rebasing main 1/3`. Empty for a row still being read. */
  readonly headState: string;
  /** Line 3: `worktree`, `submodule`, `bare`, `shallow`. Absent for an ordinary repository. */
  readonly kind?: string;
  /**
   * Line 3: `2 PR`, `2 MR`, or absent.
   *
   * Absent both when nobody asked and when the answer was none: a row with
   * nothing open has nothing to say there, and a `0 PR` would spend a field
   * saying so on every repository in the directory.
   */
  readonly review?: string;
  /** The whole row, spelled out - every figure the glyphs abbreviate, and the absolute commit date. */
  readonly tooltip: string;
  /**
   * Present exactly when `state` is `unreadable`: the summary, the command as
   * a user could retype it, and git's own words. The command is not a nicety -
   * the extension's claim is that it only ever reads, and retyping the command
   * is how a reader checks that claim.
   */
  readonly unreadableReason?: string;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type SortMode = 'recent' | 'name' | 'divergence' | 'dirty';

export const SORT_MODES: readonly SortMode[] = ['recent', 'name', 'divergence', 'dirty'];

/**
 * What the list is narrowed to.
 *
 * Built around the questions the tally header raises rather than around what is
 * easy to compute: a header saying three repositories hold unpushed work is
 * only worth reading if one click shows those three.
 */
export type FilterMode =
  | 'all'
  /** Anything with work that exists only on this machine. */
  | 'unpushed'
  /** Anything with uncommitted changes. */
  | 'dirty'
  /** Behind, or diverged. */
  | 'behind'
  /** Detached, mid-operation, unborn or without an upstream - the ones that need a decision. */
  | 'attention'
  /** Repositories git would not answer for. */
  | 'unreadable';

export const FILTER_MODES: readonly FilterMode[] = [
  'all',
  'unpushed',
  'dirty',
  'behind',
  'attention',
  'unreadable',
];

/**
 * The header counts.
 *
 * `unknown` is not decoration: a repository whose second-tier read has not
 * returned is not clean and must not be counted as clean, so it needs somewhere
 * to go. Without it the tally would drift toward flattering the reader while a
 * pass is still running.
 */
export interface Tally {
  readonly total: number;
  readonly clean: number;
  readonly dirty: number;
  readonly unpushed: number;
  readonly behind: number;
  readonly attention: number;
  readonly unreadable: number;
  /** Discovered, not yet read. */
  readonly unknown: number;
}

/** Why the list has nothing in it, which is three different sentences. */
export type ListStatus =
  /** A pass is running and has produced no row yet. */
  | { readonly kind: 'scanning' }
  /** Nothing to scan: no folder open and no configured root. */
  | { readonly kind: 'nothing-to-scan' }
  /** Scanned, and found no repository. */
  | { readonly kind: 'no-repositories' }
  /** git is not on PATH, so no row can be read at all. Stated once, not per row. */
  | { readonly kind: 'no-git' }
  /** At least one row. */
  | { readonly kind: 'ready' };

/**
 * Everything the list surface needs, already decided.
 *
 * `busy` is separate from a `scanning` status on purpose: rows on screen from
 * the previous pass are still worth reading while the next one runs, and
 * replacing them with a spinner throws that away. Status says what there is;
 * `busy` says whether it is about to change.
 */
export interface ListModel {
  readonly rows: readonly RepositoryRow[];
  readonly status: ListStatus;
  readonly tally: Tally;
  readonly sort: SortMode;
  readonly filter: FilterMode;
  /** A pass is running behind the rows shown. */
  readonly busy: boolean;
  /**
   * The fetch button is offered on each row.
   *
   * Carried on the model rather than read from settings by the page, so a
   * button that reaches the network can never be drawn by a view that has not
   * been told it may.
   */
  readonly fetchEnabled: boolean;
  /**
   * The fast-forward button is offered on each row.
   *
   * Its own flag rather than a second use of `fetchEnabled`, because the two
   * are different risks: a fetch cannot touch a file the reader has open,
   * and this can.
   */
  readonly pullEnabled: boolean;
  /**
   * The period every commit question is asked over: the pane's list and the
   * report both. On the board because it is a lens over everything, not a
   * setting of one panel.
   */
  readonly period: string;
  /** Only merges, in the pane and in the report alike. */
  readonly mergesOnly: boolean;
  /** One person's identity key, or absent for everybody. */
  readonly authorId?: string;
  /**
   * Every person the current answer contains, for the control that picks one.
   *
   * A chosen person who has nothing in the current range is still in this list,
   * carried by the controller: narrowing the period must not silently drop the
   * filter and widen the result behind the reader's back.
   */
  readonly authors: readonly ActivityAuthor[];
  /**
   * The row the reader last clicked, by working-tree path.
   *
   * Selection is the primary click's whole effect, and it is deliberately
   * inert: it moves nothing, opens nothing and spawns nothing. Opening a
   * repository is a window-level act that throws away the board the reader is
   * standing on, so it is an action they have to aim at, not something a stray
   * click does to them.
   */
  readonly selectedPath?: string;
  /**
   * Bumped once per pass. The webview patches rows in place while this is
   * unchanged and re-renders when it changes, so a row cannot be replaced by a
   * row from a superseded pass.
   */
  readonly generation: number;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * A ref pointing at a commit, classified so the pane can order and colour it.
 *
 * `%D` hands over one string per commit with everything on it - `HEAD -> main,
 * origin/main, tag: v1.2` - and the three kinds answer different questions, so
 * they are separated here rather than rendered as one run of text.
 */
export type CommitRefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface CommitRef {
  readonly kind: CommitRefKind;
  /** The short name: `main`, `origin/main`, `v1.2`. */
  readonly name: string;
}

/** One commit, as `git log` reported it. */
export interface Commit {
  readonly sha: string;
  readonly shortSha: string;
  /** Parent hashes, in git's order. Read from day one so a later change can draw lanes. */
  readonly parents: readonly string[];
  readonly refs: readonly CommitRef[];
  /** Committer date, whole seconds since the epoch. */
  readonly committedAt: number;
  readonly author: string;
  /**
   * The address git recorded for the author, exactly as written.
   *
   * Read because the display name is not an identity: `user.name` is per
   * checkout, so one person arrives as `Bartosz Warzocha` from one machine and
   * `bartosz.warzocha` from another. Normalising happens where identities are
   * compared, not here, so the commit keeps saying what it actually says.
   *
   * Empty when the commit carried none, which git permits.
   */
  readonly authorEmail: string;
  readonly subject: string;
  /**
   * This commit exists on no remote this repository knows about.
   *
   * Established by a separate `rev-list --not --remotes`, and only when the row
   * said there was something ahead - so `false` here means "asked, and no", not
   * "did not ask". A page whose unpushed set was never established carries
   * `unpushedKnown: false` on the page rather than a `false` on every commit.
   */
  readonly unpushed: boolean;
}

/** One file a commit changed, from `diff-tree --name-status`. */
export interface CommitFile {
  /** git's own letter: A, M, D, R, C, T. */
  readonly status: string;
  /** Repository-relative path, POSIX separators, as git writes it. */
  readonly path: string;
  /** Where a rename or copy came from. */
  readonly oldPath?: string;
}

/** What the history pane holds for one repository. */
export interface HistoryPage {
  /** Working-tree path of the repository these commits came from. */
  readonly repositoryPath: string;
  readonly label: string;
  readonly commits: readonly Commit[];
  /** True when the unpushed set was established; see `Commit.unpushed`. */
  readonly unpushedKnown: boolean;
  /** More commits exist beyond this page. */
  readonly more: boolean;
}

/** Why the history pane has nothing to show, which is several different sentences. */
export type HistoryStatus =
  /** Nothing is selected in the list above. */
  | { readonly kind: 'no-selection' }
  /** A read is running and has produced nothing yet. */
  | { readonly kind: 'reading'; readonly label: string }
  /** The repository has no commits. */
  | { readonly kind: 'unborn'; readonly label: string }
  /** git would not answer for it, with the command that failed. */
  | { readonly kind: 'unreadable'; readonly label: string; readonly reason: string }
  /** At least one commit. */
  | { readonly kind: 'ready' };

/**
 * Whose commits the pane below the board is listing.
 *
 * Scope only. The period, the author and the merges filter are not here: they
 * are the lens the whole extension is looking through, they apply to the report
 * as well, and putting them on the pane meant a reader had to go *down* to
 * change something that governs what happens *up*. They live on the board now,
 * and this is the one thing left that is genuinely about the pane.
 */
export type PaneMode = 'selected' | 'all';

export interface HistoryModel {
  readonly mode: PaneMode;
  /** Present in `activity` mode. */
  readonly activity?: ActivityView;
  /**
   * The selected repository's name, so the mode strip can say what it is
   * showing rather than lighting nothing at all.
   */
  readonly selectedLabel?: string;
  readonly status: HistoryStatus;
  readonly page?: HistoryPage;
  /** The commit whose file list is open. At most one is expanded at a time. */
  readonly expanded?: string;
  /** Files of the expanded commit, absent while they are still being read. */
  readonly files?: readonly CommitFile[];
  /** A read is running behind what is on screen. */
  readonly busy: boolean;
}

/**
 * One person, and every name their git configs have recorded for them.
 *
 * Identity is the address, not the display name. A picker keyed on `%an`
 * offered the same person once per spelling and, worse, hid the rest of their
 * work behind whichever spelling was picked - which is what this one did.
 *
 * Addresses are folded together, names are never folded: two addresses whose
 * names merely look alike would be two people merged into one, with nothing on
 * screen to say it had happened. An address is evidence; a resemblance is a
 * guess.
 */
export interface ActivityAuthor {
  /** The address lowercased, or the fallback `authorIdOf` describes. */
  readonly id: string;
  /** What to show: the name used for most of these commits. */
  readonly label: string;
  /** The address as git wrote it. Empty when the commits carried none. */
  readonly email: string;
  /** Every distinct name seen under this address, most used first. */
  readonly names: readonly string[];
  /** How many commits in the current answer are theirs. */
  readonly commits: number;
}

/** The cross-repository digest, already grouped and counted. */
export interface ActivityView {
  /** `today`, `week`, `month` - the vocabulary lives in `view/activity.ts`. */
  readonly period: string;
  /** One sentence: how much landed, where, and by how many people. */
  readonly summary: string;
  /**
   * Repositories that could not be read, named.
   *
   * Never folded into the summary: a digest that counted a repository it failed
   * to read would report a quieter week than actually happened.
   */
  readonly unreadable?: string;
  readonly days: readonly ActivityDayView[];
  /** Every person present, for the filter. */
  readonly authors: readonly ActivityAuthor[];
  readonly mergesOnly: boolean;
  /** Absent means everybody. */
  readonly authorId?: string;
}

export interface ActivityDayView {
  readonly heading: string;
  readonly entries: readonly ActivityEntryView[];
}

export interface ActivityEntryView {
  readonly repositoryPath: string;
  readonly label: string;
  readonly sha: string;
  readonly shortSha: string;
  /** `14:32`, in the reader's own timezone. */
  readonly time: string;
  /** The person's display name - the one the picker offers, not necessarily
   * the string on this commit. */
  readonly author: string;
  /**
   * What git actually recorded here, present only when it differs from
   * `author`.
   *
   * The row reads consistently with the picker above it, and the commit's own
   * words are still one hover away rather than overwritten.
   */
  readonly recordedAs?: string;
  readonly subject: string;
  readonly merge: boolean;
}

// ---------------------------------------------------------------------------
// Messages between the webview and the extension
// ---------------------------------------------------------------------------

/**
 * What the page may ask for. A closed union, validated against the exported
 * arrays above before it is acted on: the page is ours, but a webview message
 * is still input crossing a trust boundary.
 */
export type ListMessage =
  | { readonly type: 'select'; readonly path: string }
  | { readonly type: 'sort'; readonly sort: SortMode }
  | { readonly type: 'filter'; readonly filter: FilterMode }
  | { readonly type: 'action'; readonly action: RowAction; readonly path: string }
  | { readonly type: 'refresh' };

/**
 * What a row offers.
 *
 * All but one of these open something else and write nothing. The exception is
 * `fetch`, which is the single thing this extension does that writes inside a
 * repository - remote-tracking refs, `FETCH_HEAD` and objects, never the
 * working tree, a branch or a commit. It is here because the divergence figures
 * on the row are measured against remote-tracking refs, so without it the board
 * reports the state of the last fetch and calls it the state of the repository.
 * It ships off; see `multirepoLedger.fetch.enabled`.
 */
export type RowAction =
  | 'open-window'
  | 'add-to-workspace'
  | 'reveal-in-scm'
  | 'open-terminal'
  | 'copy-path'
  | 'fetch'
  | 'pull';

export const ROW_ACTIONS: readonly RowAction[] = [
  'open-window',
  'add-to-workspace',
  'reveal-in-scm',
  'open-terminal',
  'copy-path',
  'fetch',
  'pull',
];
