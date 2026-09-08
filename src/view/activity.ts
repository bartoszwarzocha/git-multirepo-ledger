/**
 * The cross-repository digest as pure data: what to count, what to group, and
 * what the summary sentence says.
 *
 * Every judgement about the digest is made here, so the page below places
 * strings and nothing else, and every rule is unit-testable without an
 * extension host.
 */

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

/** What the digest is narrowed to. */
export interface ActivityFilter {
  /** Only commits with more than one parent. */
  readonly mergesOnly: boolean;
  /** Exact author name, as git recorded it. Absent means every author. */
  readonly author?: string;
}

export function filterActivity(
  entries: readonly ActivityEntry[],
  filter: ActivityFilter,
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (filter.mergesOnly && entry.commit.parents.length < 2) {
      return false;
    }
    return filter.author === undefined || entry.commit.author === filter.author;
  });
}

/** Every author present, by descending share of the list, then by name. */
export function authorsOf(entries: readonly ActivityEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.commit.author, (counts.get(entry.commit.author) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([author]) => author);
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
  const authors = new Set(entries.map((entry) => entry.commit.author)).size;

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
