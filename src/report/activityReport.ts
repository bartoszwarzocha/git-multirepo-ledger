/**
 * The digest as a document: every repository at once, in tables, in the editor.
 *
 * The pane in the sidebar answers "what happened" in a column two hundred
 * pixels wide, which is enough to notice something and not enough to add
 * anything up. This is the same data arranged to be read rather than scanned -
 * per repository, per author, per day - in a window with room for a table.
 *
 * Two renderings from one decision. `buildActivityReport` produces the figures
 * the panel draws; `renderActivityReport` produces the same thing as markdown,
 * which is what the panel's Copy button hands over so the report can be pasted
 * into a stand-up note or diffed against last week's.
 *
 * Nothing here imports `vscode`, so every count and every sentence is decided
 * in a module a test can call.
 */

import type { ActivityEntry, ActivityFailure } from '../read/activity.ts';
import { relativeAge } from '../view/row.ts';
import {
  PERIOD_LABELS,
  authorIdOf,
  groupByDay,
  timeOf,
  type ActivityPeriod,
} from '../view/activity.ts';

/** One bar of the commits-per-day chart. */
export interface ReportBar {
  readonly heading: string;
  /** The heading shortened for an axis label: `Mon`, `08-31`. */
  readonly short: string;
  readonly commits: number;
  readonly repositories: number;
}

export interface ReportRepositoryRow {
  readonly label: string;
  readonly commits: number;
  readonly merges: number;
  readonly authors: number;
  readonly last: string;
}

export interface ReportAuthorRow {
  /** The name this person used for most of these commits. */
  readonly author: string;
  /**
   * The address the row is keyed on, so two people who happen to share a
   * display name are still tellable apart. Empty when the commits carried none.
   */
  readonly email: string;
  /** Other names the same address committed under, if any. */
  readonly aliases: readonly string[];
  readonly commits: number;
  readonly merges: number;
  readonly repositories: number;
  readonly last: string;
}

export interface ReportEntry {
  readonly time: string;
  readonly label: string;
  readonly subject: string;
  readonly author: string;
  readonly shortSha: string;
  readonly merge: boolean;
}

export interface ReportDay {
  readonly heading: string;
  readonly entries: readonly ReportEntry[];
}

export interface ReportFailureRow {
  readonly label: string;
  /** git's own first line, quoted rather than paraphrased. */
  readonly reason: string;
}

/**
 * The report, decided.
 *
 * Every figure, ordering and sentence is settled here so the panel places
 * strings and nothing else - the same rule the board and the digest follow.
 */
export interface ActivityReport {
  readonly periodLabel: string;
  /** `today`, `in the last 7 days`, `in all the history read`. */
  readonly windowPhrase: string;
  readonly summary: string;
  readonly generatedFor: string;
  readonly commits: number;
  readonly merges: number;
  readonly discovered: number;
  readonly repositories: readonly ReportRepositoryRow[];
  readonly authors: readonly ReportAuthorRow[];
  readonly days: readonly ReportDay[];
  readonly bars: readonly ReportBar[];
  readonly failures: readonly ReportFailureRow[];
  /** The sentence above the unreadable table. Empty when nothing failed. */
  readonly failureLede: string;
}

export interface ReportInput {
  readonly entries: readonly ActivityEntry[];
  readonly failures: readonly ActivityFailure[];
  readonly period: ActivityPeriod;
  /** How many repositories were discovered, including the ones that failed. */
  readonly discovered: number;
  /** Milliseconds since the epoch; passed in so the report is a function of its inputs. */
  readonly now: number;
}

interface RepositoryTotals {
  label: string;
  commits: number;
  merges: number;
  authors: Set<string>;
  latest: number;
}

interface AuthorTotals {
  id: string;
  /** Most-used name first. */
  names: string[];
  email: string;
  commits: number;
  merges: number;
  repositories: Set<string>;
  latest: number;
}

function plural(count: number, noun: string, plural_?: string): string {
  return `${count} ${count === 1 ? noun : (plural_ ?? `${noun}s`)}`;
}

/** A table cell that will not break the table if the text contains a bar. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function windowPhrase(period: ActivityPeriod): string {
  if (period === 'all') {
    return 'in all the history read';
  }
  return period === 'today' ? 'today' : `in the last ${PERIOD_LABELS[period]}`;
}

export function byRepository(entries: readonly ActivityEntry[]): RepositoryTotals[] {
  const totals = new Map<string, RepositoryTotals>();
  for (const entry of entries) {
    const existing = totals.get(entry.repositoryPath);
    const merge = entry.commit.parents.length > 1;
    if (existing) {
      existing.commits += 1;
      existing.merges += merge ? 1 : 0;
      existing.authors.add(authorIdOf(entry.commit));
      existing.latest = Math.max(existing.latest, entry.commit.committedAt);
    } else {
      totals.set(entry.repositoryPath, {
        label: entry.label,
        commits: 1,
        merges: merge ? 1 : 0,
        authors: new Set([authorIdOf(entry.commit)]),
        latest: entry.commit.committedAt,
      });
    }
  }
  // Busiest first, then most recent: the question a reader opens this with is
  // "where did the work go", and ties are broken by what is still warm.
  return [...totals.values()].sort(
    (a, b) => b.commits - a.commits || b.latest - a.latest || a.label.localeCompare(b.label),
  );
}

/**
 * Totals per person, not per spelling.
 *
 * Keyed on the identity `authorIdOf` decides, so one person committing as
 * `Ada Lovelace` from one machine and `ada.lovelace` from another is one row
 * with one total. Keyed on the display name - which is what this did - the same
 * person appeared twice, each row understating their work, and the "Authors"
 * count above the table was simply wrong.
 */
export function byAuthor(entries: readonly ActivityEntry[]): AuthorTotals[] {
  const totals = new Map<string, AuthorTotals>();
  const names = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    const id = authorIdOf(entry.commit);
    const merge = entry.commit.parents.length > 1;
    const existing = totals.get(id);
    if (existing) {
      existing.commits += 1;
      existing.merges += merge ? 1 : 0;
      existing.repositories.add(entry.repositoryPath);
      existing.latest = Math.max(existing.latest, entry.commit.committedAt);
    } else {
      totals.set(id, {
        id,
        names: [],
        email: entry.commit.authorEmail.trim(),
        commits: 1,
        merges: merge ? 1 : 0,
        repositories: new Set([entry.repositoryPath]),
        latest: entry.commit.committedAt,
      });
      names.set(id, new Map());
    }
    const seen = names.get(id);
    if (seen) {
      seen.set(entry.commit.author, (seen.get(entry.commit.author) ?? 0) + 1);
    }
  }

  for (const total of totals.values()) {
    total.names = [...(names.get(total.id) ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  }

  return [...totals.values()].sort(
    (a, b) => b.commits - a.commits || displayName(a).localeCompare(displayName(b)),
  );
}

/** What to call a person in a table: their most-used name, else their address. */
export function displayName(total: AuthorTotals): string {
  const first = total.names[0];
  if (first !== undefined && first.length > 0) {
    return first;
  }
  return total.email.length > 0 ? total.email : total.id;
}

/**
 * The whole report.
 *
 * The order is the order the questions are asked in: how much, where, by whom,
 * when, and only then what. A reader who wants the commit list scrolls to it;
 * a reader who wants to know whether Thursday was busy never has to.
 */
export function renderActivityReport(input: ReportInput): string {
  const { entries, failures, period, discovered, now } = input;
  const repositories = byRepository(entries);
  const authors = byAuthor(entries);
  const days = groupByDay(entries, now);
  const merges = entries.filter((entry) => entry.commit.parents.length > 1).length;
  // Every commit line names the person, not whichever spelling that particular
  // commit carried, so the list agrees with the table above it.
  const labels = new Map(authors.map((author) => [author.id, displayName(author)]));

  const lines: string[] = [];

  lines.push(`# Multirepo Ledger — activity ${windowPhrase(period)}`);
  lines.push('');

  if (entries.length === 0) {
    lines.push(
      `Nothing landed ${windowPhrase(period)} in any of the ${plural(discovered, 'repository', 'repositories')} that were read.`,
    );
  } else {
    lines.push(
      `**${plural(entries.length, 'commit')}** in **${plural(repositories.length, 'repository', 'repositories')}**, ` +
        `by **${plural(authors.length, 'author')}**` +
        `${merges > 0 ? `, including ${plural(merges, 'merge')}` : ''}.`,
    );
    lines.push('');
    lines.push(
      `Read from ${plural(discovered, 'repository', 'repositories')} discovered on this machine. ` +
        `Every figure below comes from a \`git log\` that returned; nothing is estimated.`,
    );
  }

  // Named, never counted. A report that quietly omitted repositories it could
  // not read would describe a quieter week than actually happened, and it is
  // the one error in a document like this that nobody can see.
  if (failures.length > 0) {
    lines.push('');
    lines.push(
      `> **${plural(failures.length, 'repository', 'repositories')} could not be read, and nothing from ` +
        `${failures.length === 1 ? 'it' : 'them'} is counted anywhere in this report.**`,
    );
    lines.push('>');
    for (const failure of [...failures].sort((a, b) => a.label.localeCompare(b.label))) {
      const reason = failure.stderr.split('\n')[0] ?? 'no reason given';
      lines.push(`> - \`${failure.label}\` — ${reason}`);
    }
  }

  if (entries.length === 0) {
    lines.push('');
    return lines.join('\n') + '\n';
  }

  lines.push('');
  lines.push('## Where the work went');
  lines.push('');
  lines.push('| Repository | Commits | Merges | Authors | Last commit |');
  lines.push('|---|--:|--:|--:|---|');
  for (const repository of repositories) {
    lines.push(
      `| ${cell(repository.label)} | ${repository.commits} | ${repository.merges} | ` +
        `${repository.authors.size} | ${relativeAge(repository.latest, now)} |`,
    );
  }

  lines.push('');
  lines.push('## Who did it');
  lines.push('');
  // The address gets its own column rather than being folded into the name: it
  // is what the row is keyed on, and without it two colleagues who share a
  // display name are two identical-looking rows.
  lines.push('| Author | Email | Commits | Merges | Repositories | Last commit |');
  lines.push('|---|---|--:|--:|--:|---|');
  for (const author of authors) {
    const also =
      author.names.length > 1 ? ` _(also ${author.names.slice(1).map(cell).join(', ')})_` : '';
    lines.push(
      `| ${cell(displayName(author))}${also} | ${cell(author.email)} | ${author.commits} | ` +
        `${author.merges} | ${author.repositories.size} | ${relativeAge(author.latest, now)} |`,
    );
  }

  lines.push('');
  lines.push('## When');
  lines.push('');
  lines.push('| Day | Commits | Repositories | Authors |');
  lines.push('|---|--:|--:|--:|');
  for (const day of days) {
    const repos = new Set(day.entries.map((entry) => entry.repositoryPath)).size;
    const people = new Set(day.entries.map((entry) => authorIdOf(entry.commit))).size;
    lines.push(`| ${cell(day.heading)} | ${day.entries.length} | ${repos} | ${people} |`);
  }

  lines.push('');
  lines.push('## Every commit');
  for (const day of days) {
    lines.push('');
    lines.push(`### ${day.heading}`);
    lines.push('');
    for (const entry of day.entries) {
      const merge = entry.commit.parents.length > 1 ? ' _(merge)_' : '';
      lines.push(
        `- \`${timeOf(entry.commit.committedAt)}\` **${cell(entry.label)}** — ` +
          `${cell(entry.commit.subject)}${merge} · ${cell(labels.get(authorIdOf(entry.commit)) ?? entry.commit.author)} · ` +
          `\`${entry.commit.shortSha}\``,
      );
    }
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * The same read, decided once, for the panel.
 *
 * `renderActivityReport` above still produces the markdown, because the panel's
 * Copy button hands it over and because a report that cannot leave the editor
 * is half a report. Both are built from this.
 */
export function buildActivityReport(input: ReportInput): ActivityReport {
  const { entries, failures, period, discovered, now } = input;
  const repositories = byRepository(entries);
  const authors = byAuthor(entries);
  const days = groupByDay(entries, now);
  const merges = entries.filter((entry) => entry.commit.parents.length > 1).length;
  const labels = new Map(authors.map((author) => [author.id, displayName(author)]));

  const summary =
    entries.length === 0
      ? `Nothing landed ${windowPhrase(period)} in any of the ${plural(discovered, 'repository', 'repositories')} that were read.`
      : `${plural(entries.length, 'commit')} in ${plural(repositories.length, 'repository', 'repositories')}, ` +
        `by ${plural(authors.length, 'author')}` +
        `${merges > 0 ? `, including ${plural(merges, 'merge')}` : ''}.`;

  const generated = new Date(now);
  const stamp =
    `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-` +
    `${String(generated.getDate()).padStart(2, '0')} ` +
    `${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`;

  return {
    periodLabel: PERIOD_LABELS[period],
    windowPhrase: windowPhrase(period),
    summary,
    generatedFor: `Read ${stamp} from ${plural(discovered, 'repository', 'repositories')}`,
    commits: entries.length,
    merges,
    discovered,
    repositories: repositories.map((repository) => ({
      label: repository.label,
      commits: repository.commits,
      merges: repository.merges,
      authors: repository.authors.size,
      last: relativeAge(repository.latest, now),
    })),
    authors: authors.map((author) => ({
      author: displayName(author),
      email: author.email,
      aliases: author.names.slice(1),
      commits: author.commits,
      merges: author.merges,
      repositories: author.repositories.size,
      last: relativeAge(author.latest, now),
    })),
    days: days.map((day) => ({
      heading: day.heading,
      entries: day.entries.map((entry) => ({
        time: timeOf(entry.commit.committedAt),
        label: entry.label,
        subject: entry.commit.subject,
        author: labels.get(authorIdOf(entry.commit)) ?? entry.commit.author,
        shortSha: entry.commit.shortSha,
        merge: entry.commit.parents.length > 1,
      })),
    })),
    // Oldest first, so the chart reads left to right the way a calendar does -
    // the opposite of the list below it, which leads with what is newest.
    bars: [...days].reverse().map((day) => ({
      heading: day.heading,
      short: day.heading === 'Today' || day.heading === 'Yesterday' ? day.heading : day.date.slice(5),
      commits: day.entries.length,
      repositories: new Set(day.entries.map((entry) => entry.repositoryPath)).size,
    })),
    failures: [...failures]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((failure) => ({
        label: failure.label,
        reason: failure.stderr.split('\n')[0] ?? 'no reason given',
      })),
    failureLede:
      failures.length === 0
        ? ''
        : `${plural(failures.length, 'repository', 'repositories')} could not be read, and nothing from ` +
          `${failures.length === 1 ? 'it' : 'them'} is counted anywhere above.`,
  };
}
