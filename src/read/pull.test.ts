import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryRow } from '../model/types.ts';
import { eligibleForFastForward, pullArgs, pullSentence, type PullReport } from './pull.ts';

function row(over: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    repository: { path: 'E:/AI/one', label: 'one', kind: 'plain', gitDir: 'E:/AI/one/.git' },
    head: { kind: 'branch', name: 'main' },
    divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 0, behind: 4 },
    workingTree: { kind: 'counted', counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } },
    fetch: { kind: 'no-record' },
    ...over,
  } as RepositoryRow;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('the command is the one a person would type, and git enforces the rest', () => {
  assert.deepEqual(pullArgs(), ['pull', '--ff-only']);
});

test('nothing that could rewrite history is on the command line', () => {
  for (const forbidden of ['--rebase', '--force', '-f', '--autostash', '--no-ff']) {
    assert.ok(!pullArgs().includes(forbidden), `${forbidden} must not be here`);
  }
});

// ---------------------------------------------------------------------------
// Who is eligible
// ---------------------------------------------------------------------------

test('behind and nothing else is exactly the case this exists for', () => {
  assert.deepEqual(eligibleForFastForward(row()), { ok: true });
});

test('in sync is run rather than skipped, because pull fetches before it decides', () => {
  // The row says "in sync" as of the last fetch, which may be a month old.
  assert.deepEqual(
    eligibleForFastForward(row({ divergence: { kind: 'in-sync', upstream: 'origin/main' } })),
    { ok: true },
  );
});

test('diverged is left alone, and told apart from merely behind', () => {
  const verdict = eligibleForFastForward(
    row({ divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 2, behind: 2 } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.reason.includes('2 ahead and 2 behind'));
});

test('ahead only has nothing to catch up on', () => {
  const verdict = eligibleForFastForward(
    row({ divergence: { kind: 'diverged', upstream: 'origin/main', ahead: 3, behind: 0 } }),
  );
  assert.equal(verdict.ok, false);
});

test('uncommitted work is never written over', () => {
  const verdict = eligibleForFastForward(
    row({
      workingTree: {
        kind: 'counted',
        counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
      },
    }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.reason.includes('uncommitted'));
});

test('an untracked file alone is enough to leave a repository alone', () => {
  const verdict = eligibleForFastForward(
    row({
      workingTree: {
        kind: 'counted',
        counts: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
      },
    }),
  );
  assert.equal(verdict.ok, false);
});

test('a working tree nobody read is not a clean one', () => {
  // With `dirty.enabled` off every row carries `not-read`. Reading that as "no
  // changes" would write over somebody's work on the strength of a question
  // that was never asked.
  const verdict = eligibleForFastForward(row({ workingTree: { kind: 'not-read' } }));
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.reason.includes('cannot be called clean'));
});

test('a half-finished operation is left where it is', () => {
  for (const kind of ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'] as const) {
    const verdict = eligibleForFastForward(row({ operation: { kind } }));
    assert.equal(verdict.ok, false, `${kind} must be skipped`);
    assert.ok(!verdict.ok && verdict.reason.includes(kind));
  }
});

test('a detached HEAD has no branch to move', () => {
  const verdict = eligibleForFastForward(row({ head: { kind: 'detached', sha: 'a'.repeat(40) } }));
  assert.equal(verdict.ok, false);
});

test('a branch that tracks nothing is left alone', () => {
  const verdict = eligibleForFastForward(row({ divergence: { kind: 'no-upstream' } }));
  assert.equal(verdict.ok, false);
});

test('a repository git would not answer for is not pulled on a guess', () => {
  const verdict = eligibleForFastForward(
    row({
      failure: {
        command: 'git for-each-ref',
        stderr: 'dubious ownership',
        summary: 'git refused to read it',
      },
    }),
  );
  assert.equal(verdict.ok, false);
});

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

function report(over: Partial<PullReport> = {}): PullReport {
  return {
    advanced: 0,
    alreadyCurrent: 0,
    skipped: [],
    failures: [],
    cancelled: false,
    ...over,
  };
}

test('what moved is said first, because that is what the button was pressed for', () => {
  assert.ok(pullSentence(report({ advanced: 3 })).startsWith('3 repositories caught up'));
});

test('what was left alone is named, not counted', () => {
  // "3 left alone" is a number nobody can act on.
  const sentence = pullSentence(
    report({ skipped: [{ label: 'billing', reason: 'uncommitted changes' }] }),
  );
  assert.ok(sentence.includes('billing (uncommitted changes)'));
});

test('a long list of skipped repositories does not become the whole message', () => {
  const sentence = pullSentence(
    report({
      skipped: Array.from({ length: 6 }, (_, i) => ({ label: `r${i}`, reason: 'diverged' })),
    }),
  );
  assert.ok(sentence.includes('and 3 more'));
});

test('running and finding nothing is still an answer', () => {
  assert.equal(pullSentence(report()), 'Nothing to catch up on.');
});

test('having nothing to bring is not the same as having caught up', () => {
  const sentence = pullSentence(report({ alreadyCurrent: 4 }));
  assert.ok(sentence.includes('4 already current'));
  assert.ok(!sentence.includes('caught up'));
});
