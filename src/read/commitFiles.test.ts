import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { commitFilesArgs, parseCommitFiles, readCommitFiles } from './commitFiles.ts';

const NUL = '\u0000';

test('the git-level option precedes the subcommand', () => {
  const args = commitFilesArgs('abc');
  assert.equal(args[0], '--no-optional-locks');
  assert.equal(args[1], 'diff-tree');
});

test('--root is asked for, because without it the first commit lists nothing', () => {
  assert.ok(commitFilesArgs('abc').includes('--root'));
});

test('-z is asked for, so a path with a space arrives as bytes rather than quoted', () => {
  assert.ok(commitFilesArgs('abc').includes('-z'));
});

test('an ordinary change is a status and a path', () => {
  assert.deepEqual(parseCommitFiles(`M${NUL}src/app.ts${NUL}`), [
    { status: 'M', path: 'src/app.ts' },
  ]);
});

test('a rename takes three fields, and reading it as two would shift everything after it', () => {
  const stdout = `R100${NUL}old.ts${NUL}new.ts${NUL}M${NUL}other.ts${NUL}`;
  assert.deepEqual(parseCommitFiles(stdout), [
    { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'M', path: 'other.ts' },
  ]);
});

test('a copy is read like a rename', () => {
  assert.deepEqual(parseCommitFiles(`C75${NUL}from.ts${NUL}to.ts${NUL}`), [
    { status: 'C', path: 'to.ts', oldPath: 'from.ts' },
  ]);
});

test('a path with a space survives, which is the whole reason for -z', () => {
  assert.deepEqual(parseCommitFiles(`A${NUL}docs/a file.md${NUL}`), [
    { status: 'A', path: 'docs/a file.md' },
  ]);
});

test('a truncated stream yields what it can and stops rather than throwing', () => {
  assert.deepEqual(parseCommitFiles(`M${NUL}one.ts${NUL}M`), [{ status: 'M', path: 'one.ts' }]);
});

test('empty output is no files, not a throw', () => {
  assert.deepEqual(parseCommitFiles(''), []);
});

// ---------------------------------------------------------------------------
// Against a real repository
// ---------------------------------------------------------------------------

const made: string[] = [];

after(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): { dir: string; first: string; second: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-files-'));
  made.push(dir);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.invalid',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.invalid',
  };
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();

  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Ada');
  run('config', 'user.email', 'ada@example.invalid');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a file.ts'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'first');
  const first = run('rev-parse', 'HEAD');

  fs.writeFileSync(path.join(dir, 'src', 'a file.ts'), 'two\n');
  fs.writeFileSync(path.join(dir, 'added.txt'), 'new\n');
  run('add', '.');
  run('commit', '-q', '-m', 'second');
  const second = run('rev-parse', 'HEAD');

  return { dir, first, second };
}

test('the first commit lists its files, which it cannot do without --root', async () => {
  const { dir, first } = repo();
  const result = await readCommitFiles({ cwd: dir, sha: first });
  assert.equal(result.failure, undefined);
  assert.deepEqual(
    result.files.map((file) => [file.status, file.path]),
    [['A', 'src/a file.ts']],
  );
});

test('a later commit lists what it added and what it changed', async () => {
  const { dir, second } = repo();
  const result = await readCommitFiles({ cwd: dir, sha: second });
  const byPath = new Map(result.files.map((file) => [file.path, file.status]));
  assert.equal(byPath.get('added.txt'), 'A');
  assert.equal(byPath.get('src/a file.ts'), 'M');
});

test('an object id that does not exist reports the command rather than empty files', async () => {
  const { dir } = repo();
  const result = await readCommitFiles({ cwd: dir, sha: 'f'.repeat(40) });
  assert.ok(result.failure, 'a failure should be reported');
  assert.match(result.failure?.command ?? '', /^git /);
});
