import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Tally } from '../model/types.ts';
import { BADGE_MODES, DEFAULT_BADGE_MODE, badgeFor } from './badge.ts';

function tally(over: Partial<Tally> = {}): Tally {
  return {
    total: 10,
    clean: 4,
    dirty: 0,
    unpushed: 0,
    behind: 0,
    attention: 0,
    unreadable: 0,
    unknown: 0,
    ...over,
  };
}

test('the badge counts what its mode names, and says so in words', () => {
  const badge = badgeFor(tally({ unpushed: 3 }), 'unpushed');
  assert.equal(badge?.value, 3);
  assert.equal(badge?.tooltip, '3 repositories with commits that exist only on this machine');
});

test('one repository is not "1 repositorys"', () => {
  assert.equal(
    badgeFor(tally({ attention: 1 }), 'attention')?.tooltip,
    '1 repository needing a decision',
  );
});

test('a count of none draws nothing rather than a nought', () => {
  // A permanent `0` on the Activity Bar catches the eye every time and says
  // nothing when it does.
  assert.equal(badgeFor(tally({ unpushed: 0 }), 'unpushed'), undefined);
});

test('an empty board draws nothing, because the answer has not arrived', () => {
  assert.equal(badgeFor(tally({ total: 0, unpushed: 0 }), 'unpushed'), undefined);
});

test('off means off, whatever the counts say', () => {
  assert.equal(badgeFor(tally({ unpushed: 9, dirty: 9 }), 'off'), undefined);
});

test('the working-tree read being switched off shows silence, not a clean board', () => {
  // With `dirty.enabled` off every row counts as not dirty, which is a count
  // nobody established. It must not reach the icon as a confident zero - and it
  // does not, because zero draws no badge.
  assert.equal(badgeFor(tally({ dirty: 0 }), 'dirty'), undefined);
});

test('every mode is a filter the board can also show', () => {
  // The rule the badge exists under: a number is only worth showing if one
  // click shows the things it counted.
  const filters = ['unpushed', 'dirty', 'behind', 'attention', 'unreadable'];
  for (const mode of BADGE_MODES) {
    if (mode !== 'off') {
      assert.ok(filters.includes(mode), `${mode} has no matching filter chip`);
    }
  }
  assert.ok(BADGE_MODES.includes(DEFAULT_BADGE_MODE));
});
