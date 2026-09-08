/**
 * The cross-repository digest as pure data: what to count, what to group, and
 * what the summary sentence says.
 *
 * Every judgement about the digest is made here, so the page below places
 * strings and nothing else, and every rule is unit-testable without an
 * extension host.
 */

import type { ActivityAuthor } from '../model/types.ts';
import type { ActivityEntry, ActivityFailure } from '../read/activity.ts';
import { relativeAge } from './row.ts';

/** How far back the digest looks. A closed set, because each is one word. */
export type ActivityPeriod = 'all' | 'today' | 'week' | 'month';

export const ACTIVITY_PERIODS: readonly ActivityPeriod[] = ['all', 'today', 'week', 'month'];

export const PERIOD_LABELS: Record<ActivityPeriod, string> = {
  all: 'All',
  today: 'Today',
  week: '7 days',
  month: '30 days',
};

/**
 * What `git log --since` is given.
 *
 * `midnight` rather than `24 hours ago` for the day, because "today" is a
 * calendar question: at nine in the morning a reader asking what landed today
 * does not mean "since nine last night". git resolves `midnight` in the
 * repository's own timezone, which is the reader's.
 */
export function sinceFor(period: ActivityPeriod): string {
  switch (period) {
    // No date bound at all. Still bounded per repository by the read's own cap,
    // so "all" cannot mean "hand the pane ten years of one busy repository".
    case 'all':
      return '';
    case 'today':
      return 'midnight';
    case 'week':
      return '7 days ago';
    case 'month':
      return '30 days ago';
  }
}

/**
 * Who a commit is by, as a key two spellings of one person share.
 *
 * The address, lowercased. Lowercased because a mailbox that answers to
 * `Ada@example.com` answers to `ada@example.com`, and nobody configures the two
 * intending different people; the domain is case-insensitive by RFC and the
 * local part is only theoretically not.
 *
 * The name is the fallback, not the key. `user.email` can be empty - git writes
 * `<>` and commits it - and two authorless commits by different people would
 * otherwise become one person with an empty address. The fallback is namespaced
 * so a name can never collide with somebody's real address.
 *
 * Deliberately no cleverness beyond that: no stripping of `+` tags, no matching
 * a GitHub noreply address to the account behind it, no comparing names. Each
 * would merge people this extension cannot prove are the same, and a wrongly
 * merged author is invisible - the reader sees a plausible total and no sign
 * that it covers two people.
 */
export function authorIdOf(commit: {
  readonly author: string;
  readonly authorEmail: string;
}): string {
  const email = commit.authorEmail.trim().toLowerCase();
  return email.length > 0 ? email : `name:${commit.author.trim().toLowerCase()}`;
}

/** What the digest is narrowed to. */
export interface ActivityFilter {
  /** Only commits with more than one parent. */
  readonly mergesOnly: boolean;
  /** One person's identity key, from `authorIdOf`. Absent means everybody. */
  readonly authorId?: string;
}

export function filterActivity(
  entries: readonly ActivityEntry[],
  filter: ActivityFilter,
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (filter.mergesOnly && entry.commit.parents.length < 2) {
      return false;
    }
    return filter.authorId === undefined || authorIdOf(entry.commit) === filter.authorId;
  });
}

/**
 * Everyone present, by descending share of the list, then by name.
 *
 * One entry per address, carrying every name that address has committed under.
 * The name shown is the one used most often, so the picker reads the way the
 * team writes their own name rather than however the last machine was set up;
 * ties go to the alphabet so the label cannot flip between two equal spellings
 * from one refresh to the next.
 */
export function authorsOf(entries: readonly ActivityEntry[]): ActivityAuthor[] {
  interface Bucket {
    readonly id: string;
    email: string;
    readonly names: Map<string, number>;
    commits: number;
  }

  const buckets = new Map<string, Bucket>();
  for (const entry of entries) {
    const id = authorIdOf(entry.commit);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { id, email: entry.commit.authorEmail.trim(), names: new Map(), commits: 0 };
      buckets.set(id, bucket);
    }
    bucket.commits += 1;
    bucket.names.set(entry.commit.author, (bucket.names.get(entry.commit.author) ?? 0) + 1);
  }

  return [...buckets.values()]
    .map((bucket) => {
      const names = [...bucket.names.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
      return {
        id: bucket.id,
        // An address with no name behind it labels itself; falling back to the
        // key would print `name:` at somebody.
        label: names[0] !== undefined && names[0].length > 0 ? names[0] : bucket.email,
        email: bucket.email,
        names,
        commits: bucket.commits,
      };
    })
    .sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label));
}

/**
 * What to print on a commit row.
 *
 * The person, as the picker above names them - plus the commit's own spelling
 * when it differs, so the list reads consistently with the control that filters
 * it while the record itself is never overwritten, only annotated.
 */
export function authorOf(
  entry: ActivityEntry,
  labels: ReadonlyMap<string, string>,
): { readonly author: string; readonly recordedAs?: string } {
  const recorded = entry.commit.author;
  const label = labels.get(authorIdOf(entry.commit)) ?? recorded;
  return label === recorded ? { author: label } : { author: label, recordedAs: recorded };
}

/** One entry of the Author control. */
export interface AuthorOption {
  readonly id: string;
  /** What the option reads. */
  readonly text: string;
  /** The hover. Empty when there is nothing to add. */
  readonly title: string;
}

/**
 * The Author control's options.
 *
 * Two colleagues genuinely called the same thing are told apart in the option
 * itself, not only in a tooltip: a `<select>` shows one line at a time, and two
 * identical lines are a control a reader cannot use. Everyone else keeps a bare
 * name, because appending an address to every option would make the common case
 * unreadable to fix the rare one.
 */
export function authorOptions(authors: readonly ActivityAuthor[]): AuthorOption[] {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const author of authors) {
    if (seen.has(author.label)) {
      shared.add(author.label);
    }
    seen.add(author.label);
  }

  return authors.map((author) => ({
    id: author.id,
    text:
      shared.has(author.label) && author.email.length > 0
        ? `${author.label} <${author.email}>`
        : author.label,
    title: [
      author.email.length > 0 ? author.email : 'no address on these commits',
      author.names.length > 1 ? `also commits as ${author.names.slice(1).join(', ')}` : undefined,
      // Said out loud, because an option that selects nothing otherwise looks
      // like a filter that has stopped working.
      author.commits === 0 ? 'nothing in this range' : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(' \u2014 '),
  }));
}

/** Identity key to display name, for surfaces that show one commit at a time. */
export function authorLabels(authors: readonly ActivityAuthor[]): Map<string, string> {
  return new Map(authors.map((author) => [author.id, author.label]));
}

/** One calendar day of the digest. */
export interface ActivityDay {
  /** `YYYY-MM-DD` in the reader's own timezone. */
  readonly date: string;
  /** `Today`, `Yesterday`, or the date spelled out. */
  readonly heading: string;
  readonly entries: readonly ActivityEntry[];
}

function dayKey(seconds: number): string {
  const date = new Date(seconds * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Grouped by the day the work landed, newest first.
 *
 * The local calendar day rather than a rolling window, because that is the unit
 * a person asking "what did we do yesterday" means, and because a heading of
 * `Yesterday` is worth more than a timestamp on every row.
 */
export function groupByDay(entries: readonly ActivityEntry[], now: number): ActivityDay[] {
  const today = dayKey(Math.floor(now / 1000));
  const yesterday = dayKey(Math.floor(now / 1000) - 86400);

  const days = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.commit.committedAt);
    const bucket = days.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      days.set(key, [entry]);
    }
  }

  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, dayEntries]) => ({
      date,
      heading: date === today ? 'Today' : date === yesterday ? 'Yesterday' : date,
      entries: dayEntries,
    }));
}

/** The clock time a commit landed, in the reader's own timezone. */
export function timeOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export { relativeAge };

export interface ActivitySummary {
  readonly commits: number;
  readonly merges: number;
  readonly repositories: number;
  readonly authors: number;
  /** The sentence the header shows. */
  readonly sentence: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The one sentence at the top of the digest.
 *
 * It counts the repositories that *contributed*, not the repositories that were
 * asked: "17 commits in 5 repositories" is a fact about the work, and a reader
 * who wants to know how many were scanned has the board above. Merges are named
 * separately because they answer a different question - what was integrated, as
 * against what was written.
 */
export function summarise(
  entries: readonly ActivityEntry[],
  period: ActivityPeriod,
): ActivitySummary {
  const repositories = new Set(entries.map((entry) => entry.repositoryPath)).size;
  const merges = entries.filter((entry) => entry.commit.parents.length > 1).length;
  // Counted by identity, not by spelling: one person committing under two
  // `user.name` settings is one author, and saying otherwise inflated every
  // digest they appeared in.
  const authors = new Set(entries.map((entry) => authorIdOf(entry.commit))).size;

  const window =
    period === 'all'
      ? 'in all the history read'
      : period === 'today'
        ? 'today'
        : `in the last ${PERIOD_LABELS[period]}`;
  const sentence =
    entries.length === 0
      ? `Nothing landed ${window}.`
      : `${plural(entries.length, 'commit')} in ${plural(repositories, 'repository').replace('repositorys', 'repositories')}` +
        `${merges > 0 ? `, ${plural(merges, 'merge')}` : ''}` +
        `${authors > 1 ? `, ${plural(authors, 'author')}` : ''} ${window}.`;

  return { commits: entries.length, merges, repositories, authors, sentence };
}

/**
 * The sentence naming repositories that could not be read.
 *
 * Separate from the summary and never folded into it: a digest that counted a
 * repository it failed to read would be reporting a quiet week that nobody
 * established. Absent when everything answered.
 */
export function failureSentence(failures: readonly ActivityFailure[]): string | undefined {
  if (failures.length === 0) {
    return undefined;
  }
  const names = failures.map((failure) => failure.label).sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return `${plural(names.length, 'repository').replace('repositorys', 'repositories')} could not be read, so nothing from ${names.length === 1 ? 'it' : 'them'} is counted: ${shown}${rest}.`;
}
