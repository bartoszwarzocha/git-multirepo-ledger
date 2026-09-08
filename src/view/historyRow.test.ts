import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Commit } from '../model/types.ts';
import { buildCommit, buildCommits, buildFile, buildFiles } from './historyRow.ts';

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);

function commit(over: Partial<Commit> = {}): Commit {
  return {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    parents: ['b'.repeat(40)],
    refs: [],
    committedAt: SECONDS - 7200,
    author: 'Ada',
    authorEmail: 'ada@example.com',
    subject: 'Fix the walk',
    unpushed: false,
    ...over,
  };
}

test('an ordinary commit carries its hash, age, author and subject', () => {
  const row = buildCommit(commit(), NOW, false);
  assert.equal(row.shortSha, 'aaaaaaa');
  assert.equal(row.age, '2h ago');
  assert.equal(row.author, 'Ada');
  assert.equal(row.subject, 'Fix the walk');
  assert.equal(row.mergeOf, undefined);
});

test('a commit with no subject says so rather than rendering an empty line', () => {
  assert.equal(buildCommit(commit({ subject: '' }), NOW, false).subject, '(no subject)');
});

test('a merge is named as one, because an empty file list otherwise reads as a failed read', () => {
  const row = buildCommit(commit({ parents: ['b'.repeat(40), 'c'.repeat(40)] }), NOW, false);
  assert.equal(row.mergeOf, 2);
  assert.match(row.tooltip, /merge of 2 parents/i);
});

test('unpushed is only claimed when the set was established', () => {
  // The distinction this whole model exists for: not asking and asking-and-
  // finding-nothing must not render the same way.
  assert.equal(buildCommit(commit({ unpushed: true }), NOW, false).unpushed, false);
  assert.equal(buildCommit(commit({ unpushed: true }), NOW, true).unpushed, true);
  assert.equal(buildCommit(commit({ unpushed: false }), NOW, true).unpushed, false);
});

test('the tooltip says what "only here" means, rather than leaving it to be guessed', () => {
  const row = buildCommit(commit({ unpushed: true }), NOW, true);
  assert.match(row.tooltip, /no remote this repository knows about/i);
});

test('the tooltip carries the absolute time, because two relative ages do not compare', () => {
  assert.match(buildCommit(commit(), NOW, false).tooltip, /2026-09-07/);
});

test('a page keeps its order and its unpushed knowledge', () => {
  const rows = buildCommits(
    [commit({ sha: 'a'.repeat(40) }), commit({ sha: 'c'.repeat(40), unpushed: true })],
    NOW,
    true,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.unpushed, true);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test('a path splits into a dimmed directory and the name that wins the width', () => {
  const file = buildFile({ status: 'M', path: 'src/view/row.ts' });
  assert.equal(file.directory, 'src/view/');
  assert.equal(file.name, 'row.ts');
});

test('a file at the root has no directory part', () => {
  const file = buildFile({ status: 'A', path: 'README.md' });
  assert.equal(file.directory, '');
  assert.equal(file.name, 'README.md');
});

test('the status letter is spelled out, because the letter is a convention not everyone shares', () => {
  assert.equal(buildFile({ status: 'A', path: 'a' }).word, 'added');
  assert.equal(buildFile({ status: 'D', path: 'a' }).word, 'deleted');
  assert.equal(buildFile({ status: 'R', path: 'a' }).word, 'renamed');
});

test('an unknown status letter is passed through rather than dropped', () => {
  assert.equal(buildFile({ status: 'X', path: 'a' }).word, 'X');
});

test('a rename names where it came from', () => {
  const file = buildFile({ status: 'R', path: 'new.ts', oldPath: 'old.ts' });
  assert.match(file.tooltip, /old\.ts → new\.ts/);
});

test('added and deleted are flagged, because each has only one side of a diff', () => {
  assert.equal(buildFile({ status: 'A', path: 'a' }).added, true);
  assert.equal(buildFile({ status: 'D', path: 'a' }).deleted, true);
  assert.equal(buildFile({ status: 'M', path: 'a' }).added, false);
});

test('a list of files keeps git order, which is the order git chose to report', () => {
  const files = buildFiles([
    { status: 'M', path: 'b.ts' },
    { status: 'A', path: 'a.ts' },
  ]);
  assert.deepEqual(files.map((file) => file.path), ['b.ts', 'a.ts']);
});
