import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_REFRESH_MINUTES,
  FOCUS_FLOOR_MS,
  MAX_REFRESH_MINUTES,
  MIN_REFRESH_MINUTES,
  WATCHED_GIT_PATHS,
  refreshIntervalMs,
  shouldRefreshOnFocus,
} from './refresh.ts';

// ---------------------------------------------------------------------------
// What is watched
// ---------------------------------------------------------------------------

test('a branch tip that lives only in packed-refs is still watched', () => {
  // Verified against git 2.52: a fresh clone keeps `refs/remotes/origin/main`
  // in `packed-refs` and writes no file under `refs/` for it at all.
  assert.ok(WATCHED_GIT_PATHS.includes('packed-refs'));
});

test('a repository with no refs directory at all is still watched', () => {
  // `git init --ref-format=reftable` has no `refs/`. Not the default in 2.52,
  // but a board that silently stopped updating for such a repository would
  // give no clue why.
  assert.ok(WATCHED_GIT_PATHS.includes('reftable/**'));
});

test('every operation the row reports is watched, because starting one is a change', () => {
  for (const marker of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_START',
    'rebase-merge/**',
    'rebase-apply/**',
  ]) {
    assert.ok(WATCHED_GIT_PATHS.includes(marker), `${marker} must be watched`);
  }
});

test('the working tree is not watched', () => {
  // It changes on every keystroke in every repository on the board.
  assert.ok(!WATCHED_GIT_PATHS.includes('**/*'));
});

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

test('the default is a period, not silence', () => {
  assert.equal(refreshIntervalMs(DEFAULT_REFRESH_MINUTES), DEFAULT_REFRESH_MINUTES * 60_000);
});

test('zero is off, and off is a real answer', () => {
  // Somebody reading twenty repositories over a network share may want nothing
  // to happen unless they ask for it.
  assert.equal(refreshIntervalMs(0), undefined);
  assert.equal(refreshIntervalMs(-5), undefined);
});

test('a period below the floor is raised rather than honoured', () => {
  // A board re-reading every few seconds spends the morning running `git` to
  // answer a question nobody asks that often.
  assert.equal(refreshIntervalMs(0.1), MIN_REFRESH_MINUTES * 60_000);
});

test('a period beyond the ceiling is capped', () => {
  assert.equal(refreshIntervalMs(99_999), MAX_REFRESH_MINUTES * 60_000);
});

test('a value that is not a number switches the timer off rather than throwing', () => {
  // It can only come from a settings file somebody wrote by hand, and a typo
  // there must not cost them the whole board.
  assert.equal(refreshIntervalMs(Number.NaN), undefined);
});

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

test('coming back after a while costs a read', () => {
  assert.equal(shouldRefreshOnFocus(1_000, 1_000 + FOCUS_FLOOR_MS), true);
});

test('flicking between windows costs nothing', () => {
  // `onDidChangeWindowState` fires on every alt-tab.
  assert.equal(shouldRefreshOnFocus(1_000, 2_000), false);
});

test('focus during the very first pass does not stack a second one', () => {
  // Nothing has finished yet, so there is nothing stale to replace - and two
  // passes would read every repository twice before the board has drawn once.
  assert.equal(shouldRefreshOnFocus(0, 10_000_000), false);
});
