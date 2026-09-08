import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { FORMAT } from './activity.ts';
import {
  HISTORY_FORMAT,
  historyArgs,
  parseHistory,
  parseRefs,
  readHistory,
  unpushedArgs,
} from './history.ts';

const FIELD = '\u001f';
const RECORD = '\u001e';

function record(...fields: string[]): string {
  return fields.join(FIELD) + RECORD;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('the git-level option precedes the subcommand, where git requires it', () => {
  const args = historyArgs(50, 0);
  assert.equal(args[0], '--no-optional-locks');
  assert.equal(args[1], 'log');
  // Written the other way round git exits 129 and every read would fall into
  // the "did not answer" path for a reason that is about the command line.
  assert.ok(args.indexOf('--no-optional-locks') < args.indexOf('log'));
});

test('one commit past the page is asked for, and it is how the pane knows there is more', () => {
  assert.ok(historyArgs(50, 0).includes('--max-count=51'));
  assert.ok(historyArgs(50, 100).includes('--skip=100'));
});

test('the unpushed read asks git which commits no remote carries', () => {
  const args = unpushedArgs(50);
  assert.ok(args.includes('--not'));
  assert.ok(args.includes('--remotes'));
  assert.equal(args[args.indexOf('HEAD') + 1], '--not');
});

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

test('the arrow form yields both HEAD and the branch it points at', () => {
  const refs = parseRefs('HEAD -> main, origin/main');
  assert.deepEqual(
    refs.map((ref) => [ref.kind, ref.name]),
    [
      ['head', 'HEAD'],
      ['branch', 'main'],
      ['remote', 'origin/main'],
    ],
  );
});

test('a detached HEAD writes a bare HEAD and is read as one', () => {
  assert.deepEqual(parseRefs('HEAD, tag: v1.2').map((ref) => ref.kind), ['head', 'tag']);
});

test('a tag keeps its name and loses the prefix git puts on it', () => {
  const [tag] = parseRefs('tag: v2.0.0');
  assert.deepEqual([tag?.kind, tag?.name], ['tag', 'v2.0.0']);
});

test('refs are ordered by the question they answer, not by the order git listed them', () => {
  const refs = parseRefs('tag: v1, origin/main, HEAD -> main');
  assert.deepEqual(refs.map((ref) => ref.kind), ['head', 'branch', 'remote', 'tag']);
});

test('no decoration is no refs, not an empty-named one', () => {
  assert.deepEqual(parseRefs(''), []);
  assert.deepEqual(parseRefs('   '), []);
});

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

test('an ordinary record yields every field', () => {
  const [commit] = parseHistory(
    record('a'.repeat(40), 'b'.repeat(40), 'HEAD -> main', '1788000000', 'Ada', 'ada@example.com', 'Fix the walk'),
  );
  assert.equal(commit?.sha, 'a'.repeat(40));
  assert.deepEqual(commit?.parents, ['b'.repeat(40)]);
  assert.equal(commit?.committedAt, 1788000000);
  assert.equal(commit?.author, 'Ada');
  assert.equal(commit?.authorEmail, 'ada@example.com');
  assert.equal(commit?.subject, 'Fix the walk');
  assert.equal(commit?.shortSha.length, 7);
});

test('a merge carries every parent, because a later change draws lanes from them', () => {
  const [commit] = parseHistory(
    record('a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, '', '1788000000', 'Ada', 'ada@example.com', 'Merge'),
  );
  assert.equal(commit?.parents.length, 2);
});

test('a root commit has no parents and is not skipped for it', () => {
  const [commit] = parseHistory(record('a'.repeat(40), '', '', '1788000000', 'Ada', 'ada@example.com', 'Initial'));
  assert.deepEqual(commit?.parents, []);
});

test('a separator committed into the subject rejoins rather than truncating the message', () => {
  // Verified against real git: `git commit -m $'a\x1fb'` is accepted and the
  // byte reaches %s verbatim, so the parse cannot rely on the field count.
  const [commit] = parseHistory(
    record('a'.repeat(40), '', '', '1788000000', 'Ada', 'ada@example.com', `before${FIELD}after`),
  );
  assert.equal(commit?.subject, `before${FIELD}after`);
});

test('a malformed record is skipped and costs the page nothing', () => {
  const stdout =
    record('a'.repeat(40), '', '', '1788000000', 'Ada', 'ada@example.com', 'good') +
    'garbage-with-too-few-fields' +
    RECORD +
    record('c'.repeat(40), '', '', '1788000100', 'Ada', 'ada@example.com', 'also good');
  assert.equal(parseHistory(stdout).length, 2);
});

test('a record with an unparseable date is dropped rather than dated to the epoch', () => {
  // A commit shown as 1 January 1970 would sort to the bottom and read as real.
  assert.deepEqual(parseHistory(record('a'.repeat(40), '', '', 'not-a-date', 'Ada', 'ada@example.com', 'x')), []);
});

test('empty output is an empty page, not a throw', () => {
  assert.deepEqual(parseHistory(''), []);
  assert.deepEqual(parseHistory(RECORD), []);
});

// ---------------------------------------------------------------------------
// Against a real repository
// ---------------------------------------------------------------------------

const made: string[] = [];

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-history-'));
  made.push(dir);
  const run = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ada',
        GIT_AUTHOR_EMAIL: 'ada@example.invalid',
        GIT_COMMITTER_NAME: 'Ada',
        GIT_COMMITTER_EMAIL: 'ada@example.invalid',
      },
    });
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Ada');
  run('config', 'user.email', 'ada@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  run('commit', '-q', '-am', 'second: with a | pipe and a "quote"');
  return dir;
}

after(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real repository reads back newest first, with its subjects intact', async () => {
  const dir = repo();
  const result = await readHistory({ cwd: dir, limit: 10 });
  assert.equal(result.failure, undefined);
  assert.equal(result.commits.length, 2);
  assert.equal(result.commits[0]?.subject, 'second: with a | pipe and a "quote"');
  assert.equal(result.commits[1]?.subject, 'first');
  assert.ok((result.commits[0]?.committedAt ?? 0) >= (result.commits[1]?.committedAt ?? 0));
  assert.equal(result.more, false);
});

test('a page smaller than the history reports that there is more', async () => {
  const dir = repo();
  const result = await readHistory({ cwd: dir, limit: 1 });
  assert.equal(result.commits.length, 1);
  assert.equal(result.more, true);
});

test('skipping past the whole history is an empty page, not a failure', async () => {
  const dir = repo();
  const result = await readHistory({ cwd: dir, limit: 10, skip: 99 });
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.commits, []);
});

test('a directory that is not a repository reports the command that failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-nothing-'));
  made.push(dir);
  const result = await readHistory({ cwd: dir, limit: 10 });
  assert.ok(result.failure, 'a failure should be reported');
  assert.match(result.failure?.command ?? '', /^git /);
  assert.ok((result.failure?.stderr ?? '').length > 0, 'git should have said why');
});

test('the digest and the pane ask git for the same fields', () => {
  // They are two constants so that changing one surface's fields cannot quietly
  // change the other's, and `parseHistory` reads the output of both - so if
  // they ever disagree, one of the two surfaces parses garbage. This is the
  // check that says so out loud rather than at a reader's expense.
  assert.equal(FORMAT, HISTORY_FORMAT);
});

test('the address is read, and the subject still absorbs a separator after it', () => {
  const [commit] = parseHistory(
    record('a'.repeat(40), '', '', '1788000000', 'Ada', 'ada@example.com', `x${FIELD}y`),
  );
  assert.equal(commit?.authorEmail, 'ada@example.com');
  assert.equal(commit?.subject, `x${FIELD}y`);
});

test('a commit with no address is kept, because git permits one', () => {
  const [commit] = parseHistory(record('a'.repeat(40), '', '', '1788000000', 'Ada', '', 'Anon'));
  assert.equal(commit?.authorEmail, '');
  assert.equal(commit?.subject, 'Anon');
});
