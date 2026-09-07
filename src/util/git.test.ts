import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatCommand } from './git.ts';

/*
 * `formatCommand` is user-facing, not a debugging aid: every fact the extension
 * reports about a repository can be shown next to the command that produced it,
 * and the point of showing it is that the user can retype it and get the same
 * answer. That makes the quoting rule a contract, so these assertions are on
 * exact strings rather than on "contains a quote" - a shape assertion would
 * still pass if the quoting stopped round-tripping.
 *
 * It is also the first test in the repository, and it exists from the first
 * commit so that `npm test` and CI have something that can actually fail. A
 * suite that is green because it is empty proves nothing about the wiring it is
 * supposed to prove.
 */

test('arguments that need no quoting are passed through unchanged', () => {
  assert.equal(formatCommand(['log', '-1', '--format=%H%x00%s']), 'git log -1 --format=%H%x00%s');
});

test('an argument containing a space is quoted, so the command survives being retyped', () => {
  assert.equal(formatCommand(['log', '--format=%an %ar']), 'git log "--format=%an %ar"');
});

test('a double quote inside an argument is escaped rather than left to close the quoting', () => {
  assert.equal(formatCommand(['log', '--grep=say "yes"']), 'git log "--grep=say \\"yes\\""');
});

test('an empty argument list still names the program that would run', () => {
  // The trailing space is real: it is the join of nothing onto the `git ` prefix.
  // Asserted as it is rather than trimmed, because trimming here would hide a
  // change in how arguments are joined behind a test that still passed.
  assert.equal(formatCommand([]), 'git ');
});
