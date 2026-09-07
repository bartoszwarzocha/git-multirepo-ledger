/**
 * Prints the board for a directory, through exactly the modules the extension
 * uses - no extension host, no webview.
 *
 * This exists so the reading half can be checked against real repositories
 * before the surface that renders it exists, and afterwards whenever a row
 * looks wrong: the terminal shows the same decisions the panel would make, with
 * nothing in between to blame.
 *
 *   node scripts/dump.ts <directory>
 *
 * Not shipped: `.vscodeignore` excludes this directory.
 */

import { discoverRepositories } from '../src/discovery/repositories.ts';
import { readDirtyState, readRows } from '../src/read/reader.ts';
import type { RepositoryRow } from '../src/model/types.ts';
import { sortRows, tallyOf } from '../src/view/order.ts';
import { buildRows } from '../src/view/row.ts';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: node scripts/dump.ts <directory>');
  process.exit(1);
}

const startedAt = Date.now();

const repositories = await discoverRepositories({
  workspaceFolders: [target],
  additionalRoots: [],
  onMissingRoot: (path) => console.error(`missing root: ${path}`),
});

const discoveredAt = Date.now();
console.log(`\n${repositories.length} repositories found in ${discoveredAt - startedAt} ms\n`);

const rows: RepositoryRow[] = [];
const pass = await readRows({
  repositories,
  onRow: (row) => rows.push(row),
});
const readAt = Date.now();

// Tier two, over every row rather than only the visible ones: a terminal has no
// viewport to be visible in, and the point here is to exercise the read.
await readDirtyState({
  rows,
  onRow: (row) => {
    const at = rows.findIndex((existing) => existing.repository.path === row.repository.path);
    if (at >= 0) {
      rows[at] = row;
    }
  },
});
const dirtyAt = Date.now();

const sorted = sortRows(rows, 'recent');
for (const row of buildRows(sorted, Date.now())) {
  const one = [
    row.qualifier ? `${row.qualifier}${row.name}` : row.name,
    row.divergence,
    row.dirty,
    row.freshness,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join('   ');
  const two = [row.age, row.subject].filter((part) => part !== undefined && part !== '').join('  ');
  const three = [row.headState, row.kind]
    .filter((part) => part !== undefined && part !== '')
    .join('  ·  ');

  console.log(`  ${one}`);
  if (two.length > 0) {
    console.log(`      ${two}`);
  }
  if (three.length > 0) {
    console.log(`      ${three}`);
  }
  if (row.unreadableReason !== undefined) {
    console.log(`      ! ${row.unreadableReason}`);
  }
  console.log('');
}

const tally = tallyOf(sorted);
console.log(
  `tally   clean ${tally.clean} · dirty ${tally.dirty} · unpushed ${tally.unpushed} · ` +
    `behind ${tally.behind} · attention ${tally.attention} · unreadable ${tally.unreadable} · ` +
    `unknown ${tally.unknown}`,
);
console.log(
  `timing  walk ${discoveredAt - startedAt} ms · rows ${readAt - discoveredAt} ms · ` +
    `dirty ${dirtyAt - readAt} ms · concurrency ${pass.concurrency}`,
);
