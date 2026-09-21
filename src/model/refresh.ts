/**
 * When the board re-reads itself, and what it watches to know that it should.
 *
 * Three mechanisms, because no one of them is sufficient:
 *
 *   - **Watching** catches the ordinary case the moment it happens - a commit,
 *     a checkout, a fetch, the start of a rebase - and costs nothing until it
 *     fires.
 *   - **A timer** catches everything watching misses. File watching is not a
 *     guarantee: it degrades on network shares and mapped drives, it is capped
 *     per platform, and a reader who has set `files.watcherExclude` to
 *     `**\/.git/**` has switched it off entirely without knowing what that
 *     costs them here.
 *   - **Window focus** catches the case the other two cannot see at all: work
 *     done outside this editor while it sat in the background. Somebody who
 *     pulls in a terminal, alt-tabs back, and finds the board unchanged reads
 *     that as a broken board, and they are not wrong.
 *
 * None of it reveals what another person pushed. That is a fact about a server,
 * and nothing on this disk changes until a fetch asks. The board is honest
 * about this - divergence figures carry the age of the evidence behind them -
 * but no amount of watching substitutes for the asking.
 *
 * Pure: every decision here is a function of its arguments, so the policy is
 * unit-tested rather than reasoned about.
 */

/**
 * Everything inside a `.git` that changes what a row says.
 *
 * Working-tree files are deliberately absent: they change on every keystroke in
 * every editor across every repository on the board, and the dirty column is a
 * second-tier read the timer already covers.
 *
 * `refs/**` alone was not enough, which is why this is a list rather than that
 * one pattern:
 *
 *   - `packed-refs` holds branch tips that have no file under `refs/` at all.
 *     A fresh clone keeps `refs/remotes/origin/main` there and nowhere else -
 *     verified against git 2.52 - so a repository that was cloned and then had
 *     its refs packed can move without a single event under `refs/`.
 *   - `reftable/**` is the alternative ref backend git 2.45 introduced. It is
 *     not the default in 2.52, but a repository created with
 *     `--ref-format=reftable` has no `refs/` directory whatsoever.
 *   - The operation markers are what the row's third line reports. Starting a
 *     rebase is a state change a reader expects to see, and it writes none of
 *     the above.
 */
export const WATCHED_GIT_PATHS =
  '{HEAD,ORIG_HEAD,FETCH_HEAD,packed-refs,' +
  'MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_START,' +
  'refs/**,reftable/**,rebase-merge/**,rebase-apply/**}';

/** The setting's own bounds. Minutes, because nobody thinks about this in seconds. */
export const MIN_REFRESH_MINUTES = 1;
export const MAX_REFRESH_MINUTES = 1440;
export const DEFAULT_REFRESH_MINUTES = 5;

/**
 * How often the timer fires, or `undefined` for never.
 *
 * `0` is off and is a real choice: somebody reading twenty repositories on a
 * network share may want nothing to happen unless they ask. Anything below the
 * floor is raised to it rather than honoured, because a board that re-reads
 * every few seconds spends a machine's morning on `git` processes to answer a
 * question nobody asked that often.
 */
export function refreshIntervalMs(minutes: number): number | undefined {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  const bounded = Math.min(Math.max(minutes, MIN_REFRESH_MINUTES), MAX_REFRESH_MINUTES);
  return Math.round(bounded * 60_000);
}

/**
 * The shortest gap between two reads triggered by the window being focused.
 *
 * A guard, not a preference. `onDidChangeWindowState` fires on every alt-tab,
 * and without a floor a reader flicking between the editor and a browser would
 * start a full pass each time. Fifteen seconds is short enough that coming back
 * from a terminal feels immediate and long enough that flicking costs nothing.
 */
export const FOCUS_FLOOR_MS = 15_000;

/**
 * Whether regaining focus should cost a read.
 *
 * `lastFinishedAt` of zero means no pass has ever finished, which is the state
 * during the first one - and a second pass stacked on top of the first would
 * read every repository twice before the board has drawn once.
 */
export function shouldRefreshOnFocus(
  lastFinishedAt: number,
  now: number,
  floorMs: number = FOCUS_FLOOR_MS,
): boolean {
  if (lastFinishedAt <= 0) {
    return false;
  }
  return now - lastFinishedAt >= floorMs;
}
