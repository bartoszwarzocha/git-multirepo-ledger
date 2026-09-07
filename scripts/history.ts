/**
 * Prints the history pane's content for one repository, through exactly the
 * modules the pane uses - no extension host, no webview.
 *
 *   node scripts/history.ts <repository> [sha]
 *
 * With a commit id it also prints that commit's changed files, which is what
 * the pane shows when a commit is expanded. Not shipped: `.vscodeignore`
 * excludes this directory.
 */

import { readCommitFiles } from '../src/read/commitFiles.ts';
import { readHistory, readUnpushed } from '../src/read/history.ts';
import { buildCommits, buildFiles } from '../src/view/historyRow.ts';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: node scripts/history.ts <repository> [sha]');
  process.exit(1);
}

const started = Date.now();
const page = await readHistory({ cwd: target, limit: 12 });
const read = Date.now();

if (page.failure) {
  console.error(`could not read: ${page.failure.command}\n${page.failure.stderr}`);
  process.exit(1);
}

const unpushed = await readUnpushed({ cwd: target, limit: 50 });
const now = Date.now();

const commits = page.commits.map((commit) =>
  unpushed.has(commit.sha) ? { ...commit, unpushed: true } : commit,
);

console.log(`\n${page.commits.length} commits in ${read - started} ms (more: ${page.more})\n`);

for (const commit of buildCommits(commits, now, true)) {
  const refs = commit.refs.map((ref) => `[${ref.kind}:${ref.name}]`).join(' ');
  const marks = [commit.unpushed ? 'only here' : '', commit.mergeOf ? `merge of ${commit.mergeOf}` : '']
    .filter((part) => part.length > 0)
    .join(' · ');
  console.log(`  ${commit.shortSha}  ${commit.age.padEnd(9)} ${commit.author}${marks ? '  (' + marks + ')' : ''}`);
  console.log(`      ${commit.subject}`);
  if (refs.length > 0) {
    console.log(`      ${refs}`);
  }
  console.log('');
}

const sha = process.argv[3] ?? page.commits[0]?.sha;
if (sha !== undefined) {
  const files = await readCommitFiles({ cwd: target, sha });
  console.log(`files of ${sha.slice(0, 7)}:`);
  if (files.failure) {
    console.log(`  ! ${files.failure.command}\n    ${files.failure.stderr}`);
  } else if (files.files.length === 0) {
    console.log('  (none - a merge, or a commit that changed nothing)');
  } else {
    for (const file of buildFiles(files.files)) {
      console.log(`  ${file.status}  ${file.word.padEnd(12)} ${file.path}`);
    }
  }
}
