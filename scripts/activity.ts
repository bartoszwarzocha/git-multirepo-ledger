/**
 * Prints the cross-repository digest, through the modules the pane uses.
 *
 *   node scripts/activity.ts <directory> [today|week|month]
 *
 * Not shipped: `.vscodeignore` excludes this directory.
 */

import { discoverRepositories } from '../src/discovery/repositories.ts';
import { readActivity } from '../src/read/activity.ts';
import {
  authorsOf,
  failureSentence,
  groupByDay,
  sinceFor,
  summarise,
  timeOf,
  type ActivityPeriod,
} from '../src/view/activity.ts';

const target = process.argv[2];
const period = (process.argv[3] ?? 'week') as ActivityPeriod;
if (target === undefined) {
  console.error('usage: node scripts/activity.ts <directory> [today|week|month]');
  process.exit(1);
}

const started = Date.now();
const repositories = await discoverRepositories({ workspaceFolders: [target], additionalRoots: [] });
const result = await readActivity({ repositories, since: sinceFor(period) });
const took = Date.now() - started;

const summary = summarise(result.entries, period);
console.log(`\n${summary.sentence}`);
const failed = failureSentence(result.failures);
if (failed) {
  console.log(failed);
}
console.log(`(${repositories.length} repositories walked and read in ${took} ms)\n`);

for (const day of groupByDay(result.entries, Date.now())) {
  console.log(`  ${day.heading}`);
  for (const entry of day.entries) {
    const merge = entry.commit.parents.length > 1 ? ' [merge]' : '';
    console.log(
      `    ${timeOf(entry.commit.committedAt)}  ${entry.label.padEnd(22)} ${entry.commit.author.padEnd(18)} ${entry.commit.subject}${merge}`,
    );
  }
  console.log('');
}

console.log('authors:', authorsOf(result.entries).join(', ') || '(none)');
