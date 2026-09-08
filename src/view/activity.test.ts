import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActivityEntry } from '../read/activity.ts';
import {
  authorIdOf,
  authorOptions,
  authorOf,
  authorsOf,
  failureSentence,
  filterActivity,
  groupByDay,
  sinceFor,
  summarise,
  timeOf,
} from './activity.ts';

const NOW = new Date(2026, 8, 8, 12, 0, 0).getTime();
const SECONDS = Math.floor(NOW / 1000);

function entry(
  over: Partial<{ repo: string; at: number; author: string; email: string; parents: number }> = {},
): ActivityEntry {
  const parents = over.parents ?? 1;
  return {
    repositoryPath: over.repo ?? 'E:/AI/one',
    label: over.repo ?? 'one',
    commit: {
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      parents: Array.from({ length: parents }, (_, i) => String(i).repeat(40)),
      refs: [],
      committedAt: over.at ?? SECONDS - 3600,
      author: over.author ?? 'Ada',
      // Distinct by default, so a test that means to talk about two people gets
      // two people without having to say so every time.
      authorEmail: over.email ?? `${(over.author ?? 'Ada').toLowerCase().replace(/ /g, '.')}@example.com`,
      subject: 'Something landed',
      unpushed: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('today is a calendar day, not the last twenty-four hours', () => {
  // At nine in the morning, a reader asking what landed today does not mean
  // "since nine last night".
  assert.equal(sinceFor('today'), 'midnight');
});

test('the longer windows are spelled the way git reads them', () => {
  assert.equal(sinceFor('week'), '7 days ago');
  assert.equal(sinceFor('month'), '30 days ago');
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('merges only keeps the commits with more than one parent', () => {
  const entries = [entry({ parents: 1 }), entry({ parents: 2 }), entry({ parents: 3 })];
  assert.equal(filterActivity(entries, { mergesOnly: true }).length, 2);
  assert.equal(filterActivity(entries, { mergesOnly: false }).length, 3);
});

test('two spellings of one address are one person, and the filter keeps both', () => {
  // The defect this exists for: `user.name` is per checkout, so the same person
  // arrives under whatever each machine was set up with. Keyed on the name, the
  // picker offered them twice and each option hid the other's commits.
  const entries = [
    entry({ author: 'Bartosz Warzocha', email: 'b@example.com' }),
    entry({ author: 'bartosz.warzocha', email: 'b@example.com' }),
    entry({ author: 'Bartosz Warzocha', email: 'b@example.com' }),
  ];
  const people = authorsOf(entries);
  assert.equal(people.length, 1);
  assert.equal(people[0]?.label, 'Bartosz Warzocha');
  assert.deepEqual(people[0]?.names, ['Bartosz Warzocha', 'bartosz.warzocha']);
  assert.equal(
    filterActivity(entries, { mergesOnly: false, authorId: people[0]?.id ?? '' }).length,
    3,
  );
});

test('one address is one person however it is capitalised', () => {
  const entries = [
    entry({ author: 'Ada', email: 'Ada@Example.com' }),
    entry({ author: 'Ada', email: 'ada@example.com' }),
  ];
  assert.equal(authorsOf(entries).length, 1);
});

test('two addresses stay two people even when the name is identical', () => {
  // The other half of the same rule: a resemblance is not evidence. Folding
  // these together would report one person's work as two people's, or worse,
  // two people's as one, with nothing on screen saying it had happened.
  const entries = [
    entry({ author: 'Ada', email: 'ada@one.example' }),
    entry({ author: 'Ada', email: 'ada@two.example' }),
  ];
  assert.equal(authorsOf(entries).length, 2);
});

test('a commit with no address falls back to the name, in its own namespace', () => {
  assert.equal(authorIdOf({ author: 'Ada', authorEmail: '' }), 'name:ada');
  // And a name can never collide with somebody's real address.
  assert.notEqual(
    authorIdOf({ author: 'ada@example.com', authorEmail: '' }),
    authorIdOf({ author: 'Ada', authorEmail: 'ada@example.com' }),
  );
});

test('people are offered by how much of the list they wrote', () => {
  const entries = [
    entry({ author: 'Ada' }),
    entry({ author: 'Grace' }),
    entry({ author: 'Grace' }),
  ];
  assert.deepEqual(
    authorsOf(entries).map((author) => author.label),
    ['Grace', 'Ada'],
  );
  assert.deepEqual(
    authorsOf(entries).map((author) => author.commits),
    [2, 1],
  );
});

test('the label is the name used most, and the commit keeps its own spelling', () => {
  const entries = [
    entry({ author: 'Grace Hopper', email: 'g@example.com' }),
    entry({ author: 'Grace Hopper', email: 'g@example.com' }),
    entry({ author: 'ghopper', email: 'g@example.com' }),
  ];
  const labels = new Map(authorsOf(entries).map((author) => [author.id, author.label]));
  assert.deepEqual(authorOf(entries[0] as ActivityEntry, labels), { author: 'Grace Hopper' });
  assert.deepEqual(authorOf(entries[2] as ActivityEntry, labels), {
    author: 'Grace Hopper',
    recordedAs: 'ghopper',
  });
});

test('the summary counts people, not spellings', () => {
  const entries = [
    entry({ author: 'Ada', email: 'a@example.com' }),
    entry({ author: 'ada.l', email: 'a@example.com' }),
  ];
  assert.equal(summarise(entries, 'week').authors, 1);
  // One author is not named in the sentence at all - it is only worth saying
  // when there is more than one.
  assert.ok(!summarise(entries, 'week').sentence.includes('author'));
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test('the two most recent days are named rather than dated', () => {
  const days = groupByDay(
    [entry({ at: SECONDS - 3600 }), entry({ at: SECONDS - 86400 }), entry({ at: SECONDS - 86400 * 5 })],
    NOW,
  );
  assert.equal(days[0]?.heading, 'Today');
  assert.equal(days[1]?.heading, 'Yesterday');
  assert.match(days[2]?.heading ?? '', /^\d{4}-\d{2}-\d{2}$/);
});

test('days come newest first, and commits stay inside their own day', () => {
  const days = groupByDay([entry({ at: SECONDS - 86400 }), entry({ at: SECONDS - 60 })], NOW);
  assert.equal(days.length, 2);
  assert.equal(days[0]?.heading, 'Today');
  assert.equal(days[0]?.entries.length, 1);
});

test('an empty digest groups into no days at all', () => {
  assert.deepEqual(groupByDay([], NOW), []);
});

test('the time is the reader’s own clock, zero-padded', () => {
  const at = Math.floor(new Date(2026, 8, 8, 9, 5, 0).getTime() / 1000);
  assert.equal(timeOf(at), '09:05');
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

test('the summary counts the repositories that contributed, not those asked', () => {
  const entries = [
    entry({ repo: 'one' }),
    entry({ repo: 'one' }),
    entry({ repo: 'two' }),
  ];
  const summary = summarise(entries, 'week');
  assert.equal(summary.commits, 3);
  assert.equal(summary.repositories, 2);
  assert.match(summary.sentence, /3 commits in 2 repositories/);
});

test('merges are named separately, because they answer a different question', () => {
  const summary = summarise([entry({ parents: 2 }), entry()], 'today');
  assert.match(summary.sentence, /1 merge/);
});

test('nothing landed is a sentence, not an empty list', () => {
  assert.match(summarise([], 'today').sentence, /Nothing landed today\./);
});

test('one repository and one commit are not pluralised', () => {
  const summary = summarise([entry()], 'today');
  assert.match(summary.sentence, /1 commit in 1 repository/);
});

// ---------------------------------------------------------------------------
// What could not be read
// ---------------------------------------------------------------------------

test('unreadable repositories are named, never folded into the count', () => {
  // A digest that counted a repository it failed to read would report a quieter
  // week than actually happened, which is the failure this extension exists to
  // avoid.
  const sentence = failureSentence([
    { label: 'b', command: 'git log', stderr: 'x' },
    { label: 'a', command: 'git log', stderr: 'x' },
  ]);
  assert.match(sentence ?? '', /2 repositories could not be read/);
  assert.match(sentence ?? '', /a, b/);
});

test('more than three are summarised rather than listed to the end', () => {
  const failures = ['a', 'b', 'c', 'd', 'e'].map((label) => ({
    label,
    command: 'git log',
    stderr: 'x',
  }));
  assert.match(failureSentence(failures) ?? '', /and 2 more/);
});

test('nothing unreadable is silence, not an empty sentence', () => {
  assert.equal(failureSentence([]), undefined);
});

test('two people with one name are told apart in the option, not only in a tooltip', () => {
  const entries = [
    entry({ author: 'Ada Lovelace', email: 'ada@one.example' }),
    entry({ author: 'Ada Lovelace', email: 'ada@two.example' }),
    entry({ author: 'Grace', email: 'g@example.com' }),
  ];
  const options = authorOptions(authorsOf(entries));
  assert.deepEqual(
    options.map((option) => option.text).sort(),
    ['Ada Lovelace <ada@one.example>', 'Ada Lovelace <ada@two.example>', 'Grace'],
  );
});

test('a chosen person with nothing in the range says so rather than looking broken', () => {
  const [option] = authorOptions([
    { id: 'a@example.com', label: 'Ada', email: 'a@example.com', names: ['Ada'], commits: 0 },
  ]);
  assert.ok(option?.title.includes('nothing in this range'));
});
