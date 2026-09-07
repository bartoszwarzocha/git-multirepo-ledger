import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { isPathInside, normalizePath, pathKey, pathsEqual, shortSha } from './keys.ts';

const windows = process.platform === 'win32';
const caseFolding = windows || process.platform === 'darwin';

/** An absolute path for whichever platform the suite is running on. */
function abs(...segments: string[]): string {
  return windows ? path.join('C:\\', ...segments) : path.join('/', ...segments);
}

test('a trailing separator does not make a second path', () => {
  assert.equal(normalizePath(abs('src', 'app')), normalizePath(abs('src', 'app') + path.sep));
});

test('a root keeps its separator, because stripping it would name a different thing', () => {
  const root = windows ? 'C:\\' : '/';
  assert.equal(normalizePath(root), root);
});

test('mixed separators normalise to one spelling', () => {
  assert.equal(normalizePath(abs('src', 'app')), normalizePath(abs('src') + '/app'));
});

test('normalizePath leaves case alone, because the value is shown to people', () => {
  const mixed = abs('Src', 'App');
  assert.equal(normalizePath(mixed), mixed);
});

test('pathKey folds case only where the filesystem does', () => {
  const upper = pathKey(abs('Src', 'App'));
  const lower = pathKey(abs('src', 'app'));
  if (caseFolding) {
    assert.equal(upper, lower);
  } else {
    assert.notEqual(upper, lower);
  }
});

test('pathsEqual sees through spelling differences', () => {
  assert.ok(pathsEqual(abs('src', 'app'), abs('src', 'app') + path.sep));
});

test('a path is inside itself', () => {
  assert.ok(isPathInside(abs('work'), abs('work')));
});

test('a child is inside its parent', () => {
  assert.ok(isPathInside(abs('work', 'repo', 'src'), abs('work')));
});

test('a sibling sharing a name prefix is NOT inside', () => {
  // The case the separator check exists for: without it, a prefix comparison
  // says yes and the repository is excluded or attributed to the wrong folder.
  assert.equal(isPathInside(abs('a', 'bc'), abs('a', 'b')), false);
});

test('a parent is not inside its child', () => {
  assert.equal(isPathInside(abs('work'), abs('work', 'repo')), false);
});

test('shortSha abbreviates a full hash and passes an abbreviated one through', () => {
  assert.equal(shortSha('11c855f0d4e2a9b7c3f1e8d6a4b2c0f9e7d5b3a1'), '11c855f');
  // git chooses a width long enough to be unambiguous in that repository, so a
  // value that already looks abbreviated is left exactly as git wrote it.
  assert.equal(shortSha('11c855f'), '11c855f');
  assert.equal(shortSha('  6e202a6  '), '6e202a6');
});
