import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { runGit } from '../util/git.ts';
import {
  HEAD_COMMIT_FORMAT,
  REFS_FORMAT,
  headCommitArgs,
  headSymrefArgs,
  legacyRefsArgs,
  parseHeadCommit,
  parseRefs,
  refsArgs,
  refsCommand,
  resetRefsCapability,
  supportsRootRefs,
} from './refs.ts';

/*
 * Two halves.
 *
 * The first half is the parser against output captured from real repositories
 * driven into each state on git 2.52.0.windows.1. The fixtures are written out
 * byte for byte, separators as `\u001f` escapes, rather than assembled from a
 * `fields.join(SEP)` helper: a helper that built the record the same way the
 * parser takes it apart would agree with a mistake in both, and the whole value
 * of these fixtures is that they are evidence rather than a restatement.
 *
 * The second half builds repositories and runs the real command through
 * `runGit`, because the fixtures can only prove the parse. That the command
 * still produces records of this shape - that `--include-root-refs` and the
 * explicit patterns are both still needed, that a subject carrying the
 * separator survives, that a repository with no commits prints nothing at all -
 * is a claim about git, and only git can be asked.
 */

// ---------------------------------------------------------------------------
// Captured output
// ---------------------------------------------------------------------------

/**
 * `insync`: a clone that has neither moved nor been moved past.
 *
 * The two rows are the whole reason the command asks for both `HEAD` and
 * `refs/heads/`. The root `HEAD` row carries a space and, note, an *empty*
 * upstream even though the branch it points at has one - so divergence can
 * never be read off the HEAD row. The branch row carries the `*` and the
 * upstream. `trackshort` is `=`, which is the only positive evidence anywhere
 * in this output that the branch is in sync rather than untracked.
 */
const INSYNC =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  '*\u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';

/** `ahead`: one local commit that has not been pushed. */
const AHEAD =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785747600\u001fa6e050d\u001fLab\u001fWork that is only here\n' +
  '*\u001frefs/heads/main\u001forigin/main\u001f[ahead 1]\u001f>\u001f1785747600\u001fa6e050d\u001fLab\u001fWork that is only here\n';

/** `behind`: the upstream moved on and was fetched. */
const BEHIND =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  '*\u001frefs/heads/main\u001forigin/main\u001f[behind 1]\u001f<\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';

/** `diverged`: a commit here, a commit there. */
const DIVERGED =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n' +
  '*\u001frefs/heads/main\u001forigin/main\u001f[ahead 1, behind 1]\u001f<>\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n';

/**
 * `gone`: HEAD is on a branch whose upstream was deleted on the remote and
 * pruned here. `track` says `[gone]` and `trackshort` is *empty* - the same
 * empty string an untracked branch has, which is why the upstream field has to
 * be consulted as well.
 */
const GONE =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  '*\u001frefs/heads/feature/one\u001forigin/feature/one\u001f[gone]\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  ' \u001frefs/heads/main\u001forigin/main\u001f[behind 1]\u001f<\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';

/**
 * `noupstream`: HEAD is on a branch created locally and never pushed. Its
 * upstream, `track` and `trackshort` are all empty - and the `main` row two
 * lines down, which *is* in sync, differs only by `=`.
 */
const NO_UPSTREAM =
  ' \u001fHEAD\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  '*\u001frefs/heads/local-only\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n' +
  ' \u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';

/**
 * `detached`: the `*` has moved to the root `HEAD` row and no branch row has
 * one. The branch row still shows `main` in sync with its upstream, which is
 * true and is not what the row is about.
 */
const DETACHED =
  '*\u001fHEAD\u001f\u001f\u001f\u001f1785578400\u001f7031c2e\u001fLab\u001fAdd the first file\n' +
  ' \u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';

/**
 * `orphan`: `git checkout --orphan gh-pages` in a repository that already has
 * `main`.
 *
 * The output that made the unborn test worth rewriting. HEAD is unborn, exactly
 * as it is after `git init` - but the repository has a branch, so the answer is
 * not empty, and there is *no* root `HEAD` row, because the `HEAD` pattern
 * resolves nothing when the branch it names does not exist yet. So the only
 * evidence anywhere in this record is the marker that is not on it.
 */
const ORPHAN =
  ' \u001frefs/heads/main\u001f\u001f\u001f\u001f1788789590\u001fea34908\u001fLab Author\u001fbase on main\n';

/**
 * A subject that carries the separator itself, from a commit made with
 * `git commit -m $'... \x1f ...'`. Git accepts it and prints it back verbatim,
 * so this record has ten fields where the format asked for nine.
 */
const SEPARATOR_IN_SUBJECT =
  ' \u001frefs/heads/sep-demo\u001f\u001f\u001f\u001f1785996000\u001fee05250\u001fLab\u001fRefactor a|b and \u001f unit sep plus\ttab\n';

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('the row read is one process, and both halves of it are in the argument list', () => {
  const args = refsArgs();
  // Order matters for the first one only: `--no-optional-locks` is a git-level
  // option, and after the subcommand git exits 129 with "unknown option".
  assert.equal(args[0], '--no-optional-locks');
  assert.equal(args[1], 'for-each-ref');
  assert.ok(args.includes('--include-root-refs'), 'the flag alone: without it HEAD matches nothing');
  assert.ok(args.includes('refs/heads/'), 'the patterns: without them remotes and tags come too');
  assert.ok(args.includes('HEAD'));
});

test('the format keeps the two fields that can carry a separator at the end', () => {
  const fields = REFS_FORMAT.split('%1f');
  assert.equal(fields.length, 9);
  assert.equal(fields[7], '%(authorname)');
  assert.equal(fields[8], '%(contents:subject)');
  // A localised relative date would be git's language, not the extension's.
  assert.ok(!REFS_FORMAT.includes('relative'));
});

test('the fallback drops the flag and the HEAD pattern, and keeps the format', () => {
  const args = legacyRefsArgs();
  assert.ok(!args.includes('--include-root-refs'));
  assert.ok(!args.includes('HEAD'));
  assert.ok(args.includes('refs/heads/'));
  assert.ok(args.includes(`--format=${REFS_FORMAT}`));
});

test('the capability is probed at most once per session and can be forgotten for a test', () => {
  resetRefsCapability();
  const first = supportsRootRefs();
  assert.equal(supportsRootRefs(), first, 'a second caller must join the answer, not re-probe');
  resetRefsCapability();
  assert.notEqual(supportsRootRefs(), first);
  resetRefsCapability();
});

// ---------------------------------------------------------------------------
// The parse: where HEAD is
// ---------------------------------------------------------------------------

test('the branch row carrying the marker is the one HEAD is on', () => {
  const read = parseRefs(INSYNC);
  assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
  assert.equal(read.branchCount, 1);
  assert.equal(read.unborn, false);
  assert.equal(read.incomplete, undefined);
});

test('a branch name with a slash in it survives the prefix strip', () => {
  assert.deepEqual(parseRefs(GONE).head, { kind: 'branch', name: 'feature/one' });
});

test('a marker on the root HEAD row and on no branch row is a detached HEAD', () => {
  const read = parseRefs(DETACHED);
  assert.deepEqual(read.head, { kind: 'detached', sha: '7031c2e' });
  // Both rows are readable, so the branch is still counted: the repository has
  // one, it just is not the one checked out.
  assert.equal(read.branchCount, 1);
});

test('a detached HEAD reports no upstream rather than an unknown one', () => {
  // It is not an unanswered question: a detached HEAD has no branch, so it has
  // no `branch.<name>.remote` and `@{upstream}` errors out.
  assert.deepEqual(parseRefs(DETACHED).divergence, { kind: 'no-upstream' });
});

test('the detached commit is read from the HEAD row, not from the branch below it', () => {
  const read = parseRefs(DETACHED);
  assert.deepEqual(read.lastCommit, {
    shortSha: '7031c2e',
    committedAt: 1785578400,
    subject: 'Add the first file',
    author: 'Lab',
  });
});

test('no output at all from the one-process form is a repository with no commits', () => {
  const read = parseRefs('', { form: 'root-refs' });
  assert.equal(read.unborn, true);
  // The name of the branch HEAD would take is not in this output at any git
  // version, so it is not invented.
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.deepEqual(read.divergence, { kind: 'unknown' });
  assert.equal(read.lastCommit, undefined);
  assert.equal(read.branchCount, 0);
});

test('the branch name of an unborn HEAD is taken from the caller, never guessed', () => {
  const read = parseRefs('', { form: 'heads-only', unbornName: 'refs/heads/trunk' });
  assert.deepEqual(read.head, { kind: 'unborn', name: 'trunk' });
  assert.equal(read.unborn, true);
  assert.deepEqual(read.divergence, { kind: 'unknown' });
});

test('no output from the heads-only form is not claimed to be unborn on its own', () => {
  // It is equally what a detached HEAD in a repository with no branches looks
  // like, and only the extra `symbolic-ref` separates the two.
  const read = parseRefs('', { form: 'heads-only' });
  assert.equal(read.unborn, false);
  assert.deepEqual(read.head, { kind: 'unknown' });
});

test('an orphan branch is unborn even though every other branch printed', () => {
  // The regression this exists for: an earlier parser asked whether the output
  // was empty rather than whether anything carried the marker, so `git init`
  // read as unborn and `git checkout --orphan gh-pages` read as a repository
  // nothing was known about. This fixture is the second one, captured whole.
  const read = parseRefs(ORPHAN, { form: 'root-refs' });
  assert.equal(read.unborn, true);
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.deepEqual(read.divergence, { kind: 'unknown' });
  assert.equal(read.lastCommit, undefined);
  // The branch that does exist is still counted. It is a branch.
  assert.equal(read.branchCount, 1);
});

test('an orphan branch takes its name from the caller too', () => {
  const read = parseRefs(ORPHAN, { form: 'root-refs', unbornName: 'refs/heads/gh-pages' });
  assert.deepEqual(read.head, { kind: 'unborn', name: 'gh-pages' });
  assert.equal(read.unborn, true);
});

test('a cut-off answer with no marker is not read as a repository with no commits', () => {
  // Truncation can drop the marked row, and "no commits yet" over a repository
  // that has them is the worst sentence this parser could print.
  const read = parseRefs(ORPHAN, { form: 'root-refs', truncated: true });
  assert.equal(read.unborn, false);
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.ok(read.incomplete);
});

test('a branch name is not enough to call a cut-off read unborn', () => {
  // `symbolic-ref` answers with the branch name whether or not the branch has
  // commits, so on a listing that may have lost its marked row it proves
  // nothing. This is the one place a caller could hand the parser a fact that
  // outranks its own evidence, and it does not.
  const read = parseRefs(ORPHAN, {
    form: 'root-refs',
    truncated: true,
    unbornName: 'refs/heads/gh-pages',
  });
  assert.equal(read.unborn, false);
  assert.deepEqual(read.head, { kind: 'unknown' });
});

test('the legacy detached case is completed by the commit the caller fetched', () => {
  // `heads-only` output for a detached HEAD: branch rows, no marker anywhere,
  // and the commit HEAD is on mentioned by none of them.
  const headsOnly =
    ' \u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';
  const headCommit = parseHeadCommit(
    '1785578400\u001f7031c2e\u001fLab\u001fAdd the first file\n',
  );
  assert.ok(headCommit);
  const read = parseRefs(headsOnly, { form: 'heads-only', headCommit });
  assert.deepEqual(read.head, { kind: 'detached', sha: '7031c2e' });
  assert.deepEqual(read.divergence, { kind: 'no-upstream' });
  assert.deepEqual(read.lastCommit, headCommit);
  assert.equal(read.unborn, false);
});

test('a commit handed in for a repository that has none cannot make it detached', () => {
  // Belt and braces on the order of the two follow-up processes: an unborn
  // repository has no commit to fetch, so a commit arriving with one is a
  // caller bug, and the parser refuses it rather than inventing a HEAD.
  const headCommit = parseHeadCommit(
    '1785578400\u001f7031c2e\u001fLab\u001fAdd the first file\n',
  );
  assert.ok(headCommit);
  const read = parseRefs(ORPHAN, { form: 'root-refs', headCommit });
  assert.equal(read.unborn, true);
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.equal(read.lastCommit, undefined);
});

test('branches with no marker leave HEAD unknown rather than picking one', () => {
  // What the fallback sees for a detached HEAD: rows, none of them current.
  const headsOnly =
    ' \u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001f1785670200\u001fe2b2252\u001fLab\u001fTeach the parser about a|pipe and more\n';
  const read = parseRefs(headsOnly, { form: 'heads-only' });
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.deepEqual(read.divergence, { kind: 'unknown' });
  assert.equal(read.lastCommit, undefined);
  assert.equal(read.branchCount, 1);
  assert.equal(read.unborn, false);
});

// ---------------------------------------------------------------------------
// The parse: the three facts that are not zero
// ---------------------------------------------------------------------------

test('in sync is a fact of its own, carrying the upstream it agrees with', () => {
  assert.deepEqual(parseRefs(INSYNC).divergence, { kind: 'in-sync', upstream: 'origin/main' });
});

test('a branch that tracks nothing is not a branch that is level with something', () => {
  const read = parseRefs(NO_UPSTREAM);
  assert.deepEqual(read.head, { kind: 'branch', name: 'local-only' });
  assert.deepEqual(read.divergence, { kind: 'no-upstream' });
  // The distinguishing byte is one `=` on a different row: `local-only` and the
  // in-sync `main` below it are otherwise identical in this output.
  assert.equal(read.branchCount, 2);
});

test('an upstream that no longer exists is neither missing nor level', () => {
  assert.deepEqual(parseRefs(GONE).divergence, {
    kind: 'gone',
    upstream: 'origin/feature/one',
  });
});

test('ahead only reports the behind side as a measured zero', () => {
  assert.deepEqual(parseRefs(AHEAD).divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
  });
});

test('behind only reports the ahead side as a measured zero', () => {
  assert.deepEqual(parseRefs(BEHIND).divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 0,
    behind: 1,
  });
});

test('both directions are read in the order git names them', () => {
  assert.deepEqual(parseRefs(DIVERGED).divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 1,
    behind: 1,
  });
});

test('the two figures are told apart by git own words, not by their position', () => {
  // The same record with the clauses swapped, which is what a translation is
  // free to do. `trackshort` still says both directions are non-zero.
  const swapped =
    '*\u001frefs/heads/main\u001forigin/main\u001f[behind 2, ahead 7]\u001f<>\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n';
  assert.deepEqual(parseRefs(swapped).divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 7,
    behind: 2,
  });
});

test('a translated track string still yields the direction, from the punctuation alone', () => {
  // `trackshort` is `>`, `<`, `<>` or `=` on every git in every language, so the
  // direction survives even when not one word of the prose is recognised.
  const translated =
    '*\u001frefs/heads/main\u001forigin/main\u001f[vorne 3]\u001f>\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n';
  assert.deepEqual(parseRefs(translated).divergence, {
    kind: 'diverged',
    upstream: 'origin/main',
    ahead: 3,
    behind: 0,
  });
});

test('a direction with no figure to go with it is reported as unknown, not as zero', () => {
  const figureless =
    '*\u001frefs/heads/main\u001forigin/main\u001f[weiter]\u001f<>\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n';
  assert.deepEqual(parseRefs(figureless).divergence, { kind: 'unknown' });
});

test('an upstream with neither marker nor prose establishes nothing', () => {
  const silent =
    '*\u001frefs/heads/main\u001forigin/main\u001f\u001f\u001f1785913200\u001fc64dd1a\u001fLab\u001fDiverging work\n';
  assert.deepEqual(parseRefs(silent).divergence, { kind: 'unknown' });
});

// ---------------------------------------------------------------------------
// The parse: the commit
// ---------------------------------------------------------------------------

test('the commit is taken whole from the row HEAD is on', () => {
  assert.deepEqual(parseRefs(DIVERGED).lastCommit, {
    shortSha: 'c64dd1a',
    committedAt: 1785913200,
    subject: 'Diverging work',
    author: 'Lab',
  });
});

test('a vertical bar in a subject is ordinary text here', () => {
  // It is the reason the separator is not a bar. Nothing in the parse touches it.
  assert.equal(parseRefs(INSYNC).lastCommit?.subject, 'Teach the parser about a|pipe and more');
});

test('a subject carrying the separator itself is rejoined rather than truncated', () => {
  // The record has ten fields where the format asked for nine. It is still one
  // record, and the surplus belongs to the last field.
  assert.equal(parseRefs(SEPARATOR_IN_SUBJECT, { form: 'heads-only' }).branchCount, 1);

  // The captured row is not the current one - the repository it came from was on
  // another branch - so the marker is moved to reach the subject through HEAD.
  const marked = SEPARATOR_IN_SUBJECT.replace(' \u001frefs', '*\u001frefs');
  assert.equal(
    parseRefs(marked, { form: 'heads-only' }).lastCommit?.subject,
    'Refactor a|b and \u001f unit sep plus\ttab',
  );
});

test('a record whose date is not a unix stamp is dropped rather than dated to 1970', () => {
  const bad =
    '*\u001frefs/heads/main\u001forigin/main\u001f\u001f=\u001fnot-a-date\u001fc64dd1a\u001fLab\u001fDiverging work\n';
  const read = parseRefs(bad);
  assert.deepEqual(read.head, { kind: 'unknown' });
  assert.equal(read.lastCommit, undefined);
  // A dropped record is a hole in the answer, and the count says so by refusing
  // to be a number.
  assert.equal(read.branchCount, undefined);
  assert.ok(read.incomplete?.includes('One line'));
});

// ---------------------------------------------------------------------------
// The parse: answers that did not finish
// ---------------------------------------------------------------------------

test('a malformed line costs its own record and nothing else', () => {
  const withJunk = INSYNC + 'this is not a record at all\n';
  const read = parseRefs(withJunk);
  assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
  assert.equal(read.branchCount, undefined);
  assert.ok(read.incomplete);
});

test('several malformed lines are counted in the sentence that reports them', () => {
  const read = parseRefs(`${INSYNC}junk one\njunk two\n`);
  assert.ok(read.incomplete?.startsWith('2 lines'));
});

test('a truncated answer is never presented as a complete one', () => {
  const read = parseRefs(INSYNC, { truncated: true });
  // What was read is still true, and is still shown.
  assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
  assert.deepEqual(read.divergence, { kind: 'in-sync', upstream: 'origin/main' });
  // What was not read is not guessed at.
  assert.equal(read.branchCount, undefined);
  assert.ok(read.incomplete?.includes('size limit'));
  assert.equal(read.unborn, false, 'a cut-off answer is not an empty one');
});

test('the half record a byte cap leaves behind is dropped, not counted as damage', () => {
  const cut = INSYNC + '*\u001frefs/heads/fea';
  const read = parseRefs(cut, { truncated: true });
  assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
  assert.ok(read.incomplete?.includes('size limit'));
});

test('an empty truncated answer is not an unborn repository', () => {
  const read = parseRefs('', { form: 'root-refs', truncated: true });
  assert.equal(read.unborn, false);
  assert.deepEqual(read.head, { kind: 'unknown' });
});

test('the parser never throws, whatever it is handed', () => {
  for (const input of ['', '\n', '\u001f', '\u001f'.repeat(50), 'a\nb\nc', '\r\n\r\n']) {
    assert.doesNotThrow(() => parseRefs(input));
  }
});

test('a carriage return inside a subject is kept and one at the end is not', () => {
  const inside =
    '*\u001frefs/heads/main\u001f\u001f\u001f\u001f1785670200\u001fe2b2252\u001fLab\u001fHas a \r carriage return\n';
  assert.equal(parseRefs(inside).lastCommit?.subject, 'Has a \r carriage return');
  const crlf = inside.replace('\n', '\r\n');
  assert.equal(parseRefs(crlf).lastCommit?.subject, 'Has a \r carriage return');
});

// ---------------------------------------------------------------------------
// The parse: the legacy detached commit
// ---------------------------------------------------------------------------

test('the log record for a detached HEAD reads back as a commit', () => {
  const captured = '1785578400\u001f7031c2e\u001fLab\u001fAdd the first file\n';
  assert.deepEqual(parseHeadCommit(captured), {
    shortSha: '7031c2e',
    committedAt: 1785578400,
    subject: 'Add the first file',
    author: 'Lab',
  });
});

test('the log record puts the subject last too, so a separator in it is harmless', () => {
  assert.equal(
    parseHeadCommit('1785578400\u001f7031c2e\u001fLab\u001fa\u001fb\n')?.subject,
    'a\u001fb',
  );
});

test('a log record that is not the shape asked for yields no commit at all', () => {
  assert.equal(parseHeadCommit(''), undefined);
  assert.equal(parseHeadCommit('fatal: bad revision\n'), undefined);
  assert.equal(parseHeadCommit('later\u001f7031c2e\u001fLab\u001fx\n'), undefined);
});

test('the log format asks for the same four fields as the ref format', () => {
  assert.equal(HEAD_COMMIT_FORMAT, '%ct%x1f%h%x1f%an%x1f%s');
});

// ---------------------------------------------------------------------------
// Against a real git
// ---------------------------------------------------------------------------

let gitPresent: boolean | undefined;

function hasGit(): boolean {
  if (gitPresent === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      gitPresent = true;
    } catch {
      gitPresent = false;
    }
  }
  return gitPresent;
}

/** Skips rather than fails where git is not installed. */
function gitTest(name: string, run: () => Promise<void>): void {
  test(name, async (t) => {
    if (!hasGit()) {
      t.skip('git is not on PATH');
      return;
    }
    await run();
  });
}

interface Lab {
  /** The clone under test. */
  readonly repo: string;
  /** The bare repository it was cloned from, so an upstream exists to diverge from. */
  readonly origin: string;
  readonly root: string;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: labEnv(cwd),
  });
}

/**
 * A git that cannot see the machine's own configuration.
 *
 * Without this the fixtures inherit whatever the person running the tests has
 * set - `init.defaultBranch`, a commit template, a `core.hooksPath`, a signing
 * key that prompts - and a suite that passes only on its author's machine is
 * worse than no suite. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at
 * files that do not exist are git's own supported way of saying "no config".
 */
function labEnv(cwd: string): NodeJS.ProcessEnv {
  const nowhere = path.join(cwd, 'no-such-gitconfig');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: nowhere,
    GIT_CONFIG_SYSTEM: nowhere,
    GIT_AUTHOR_NAME: 'Lab',
    GIT_AUTHOR_EMAIL: 'lab@example.invalid',
    GIT_COMMITTER_NAME: 'Lab',
    GIT_COMMITTER_EMAIL: 'lab@example.invalid',
    GIT_AUTHOR_DATE: '2026-08-01T10:00:00+0000',
    GIT_COMMITTER_DATE: '2026-08-01T10:00:00+0000',
  };
}

async function makeLab(): Promise<Lab> {
  // `realpath`: the temp directory is a symlink on macOS, and git reports the
  // resolved path, so an unresolved one would not compare equal to git's answer.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'multirepo-ledger-refs-')));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');

  await fs.mkdir(origin);
  git(origin, ['init', '--quiet', '--bare', '--initial-branch=main']);

  await fs.mkdir(repo);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'Add the first file']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '--quiet', '--set-upstream', 'origin', 'main']);

  return { repo, origin, root };
}

async function removeLab(lab: Lab): Promise<void> {
  try {
    await fs.rm(lab.root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A locked object file under .git is not worth failing a passing test over.
  }
}

async function commit(repo: string, message: string, file = 'a.txt'): Promise<void> {
  await fs.appendFile(path.join(repo, file), `${message}\n`, 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', message]);
}

/**
 * The read exactly as the extension will run it, probe and all.
 *
 * `timeoutMs` is raised well above the extension's own because these tests build
 * their repositories from scratch, sometimes with hundreds of refs, on whatever
 * machine and whatever disk CI happens to give them. The extension's ten seconds
 * is a guard against a repository that hangs; here it would be a guard against a
 * busy build agent, and a suite that goes red when the machine is loaded teaches
 * everyone to ignore it.
 */
async function readRefs(repo: string): Promise<ReturnType<typeof parseRefs>> {
  const command = await refsCommand();
  const result = await runGit(command.args, { cwd: repo, timeoutMs: 120_000 });
  assert.equal(result.code, 0, `${result.command} exited ${result.code}: ${result.stderr}`);
  return parseRefs(result.stdout, { form: command.form, truncated: result.truncated });
}

gitTest('a clone that has not moved reads as in sync with its upstream', async () => {
  const lab = await makeLab();
  try {
    const read = await readRefs(lab.repo);
    assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
    assert.deepEqual(read.divergence, { kind: 'in-sync', upstream: 'origin/main' });
    assert.equal(read.lastCommit?.subject, 'Add the first file');
    assert.equal(read.lastCommit?.committedAt, 1785578400);
    assert.equal(read.lastCommit?.author, 'Lab');
    assert.equal(read.branchCount, 1);
    assert.equal(read.unborn, false);
    assert.equal(read.incomplete, undefined);
  } finally {
    await removeLab(lab);
  }
});

gitTest('an unpushed commit reads as ahead, with behind measured at zero', async () => {
  const lab = await makeLab();
  try {
    await commit(lab.repo, 'Work that is only here');
    const read = await readRefs(lab.repo);
    assert.deepEqual(read.divergence, {
      kind: 'diverged',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    });
    assert.equal(read.lastCommit?.subject, 'Work that is only here');
  } finally {
    await removeLab(lab);
  }
});

gitTest('an upstream that moved on reads as behind', async () => {
  const lab = await makeLab();
  try {
    await commit(lab.repo, 'Upstream moved on');
    git(lab.repo, ['push', '--quiet', 'origin', 'main']);
    // The remote-tracking ref stays where the push left it while the branch is
    // walked back, which is exactly the shape of a repository that has fetched.
    git(lab.repo, ['reset', '--hard', '--quiet', 'HEAD~1']);
    const read = await readRefs(lab.repo);
    assert.deepEqual(read.divergence, {
      kind: 'diverged',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
    });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a commit on each side reads as both ahead and behind', async () => {
  const lab = await makeLab();
  try {
    await commit(lab.repo, 'Upstream moved on');
    git(lab.repo, ['push', '--quiet', 'origin', 'main']);
    git(lab.repo, ['reset', '--hard', '--quiet', 'HEAD~1']);
    await commit(lab.repo, 'Diverging work', 'b.txt');
    const read = await readRefs(lab.repo);
    assert.deepEqual(read.divergence, {
      kind: 'diverged',
      upstream: 'origin/main',
      ahead: 1,
      behind: 1,
    });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a branch never pushed reads as tracking nothing, not as level', async () => {
  const lab = await makeLab();
  try {
    git(lab.repo, ['checkout', '--quiet', '-b', 'local-only']);
    const read = await readRefs(lab.repo);
    assert.deepEqual(read.head, { kind: 'branch', name: 'local-only' });
    assert.deepEqual(read.divergence, { kind: 'no-upstream' });
    assert.equal(read.branchCount, 2);
  } finally {
    await removeLab(lab);
  }
});

gitTest('an upstream deleted on the remote reads as gone, not as no upstream', async () => {
  const lab = await makeLab();
  try {
    git(lab.repo, ['push', '--quiet', 'origin', 'main:feature/one']);
    git(lab.repo, ['fetch', '--quiet']);
    git(lab.repo, ['checkout', '--quiet', '-b', 'feature/one', '--track', 'origin/feature/one']);
    git(lab.origin, ['branch', '--quiet', '--delete', '--force', 'feature/one']);
    git(lab.repo, ['fetch', '--quiet', '--prune']);

    const read = await readRefs(lab.repo);
    assert.deepEqual(read.head, { kind: 'branch', name: 'feature/one' });
    assert.deepEqual(read.divergence, { kind: 'gone', upstream: 'origin/feature/one' });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a detached HEAD is named by the root ref row, with its own commit', async () => {
  const lab = await makeLab();
  try {
    await commit(lab.repo, 'Second commit');
    git(lab.repo, ['checkout', '--quiet', '--detach', 'HEAD~1']);
    const expected = git(lab.repo, ['rev-parse', '--short', 'HEAD']).trim();

    const read = await readRefs(lab.repo);
    assert.deepEqual(read.head, { kind: 'detached', sha: expected });
    assert.equal(read.lastCommit?.subject, 'Add the first file');
    assert.deepEqual(read.divergence, { kind: 'no-upstream' });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a repository with no commits prints nothing at all, and says so', async () => {
  const lab = await makeLab();
  try {
    const empty = path.join(lab.root, 'unborn');
    await fs.mkdir(empty);
    git(empty, ['init', '--quiet', '--initial-branch=trunk']);

    const command = await refsCommand();
    const result = await runGit(command.args, { cwd: empty });
    // Not an error: git succeeds and has nothing to report.
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');

    const blind = parseRefs(result.stdout, { form: command.form });
    assert.equal(blind.unborn, true);
    assert.deepEqual(blind.head, { kind: 'unknown' });

    // The name comes from the one command that can produce it.
    const symref = await runGit(headSymrefArgs(), { cwd: empty });
    assert.equal(symref.code, 0);
    const named = parseRefs(result.stdout, {
      form: command.form,
      unbornName: symref.stdout.trim(),
    });
    assert.deepEqual(named.head, { kind: 'unborn', name: 'trunk' });
  } finally {
    await removeLab(lab);
  }
});

gitTest('an orphan branch is unborn too, and this output is not empty', async () => {
  const lab = await makeLab();
  try {
    git(lab.repo, ['checkout', '--quiet', '--orphan', 'gh-pages']);

    const command = await refsCommand();
    const result = await runGit(command.args, { cwd: lab.repo });
    assert.equal(result.code, 0);
    // The half of this that a parser can get wrong: `main` still prints, so the
    // answer is not empty - and no row carries the marker, because the branch
    // HEAD names has no commit and so has no ref for the pattern to match.
    assert.ok(result.stdout.includes('refs/heads/main'));
    assert.ok(!result.stdout.includes('HEAD'), 'no root HEAD row resolves');
    assert.ok(!result.stdout.startsWith('*') && !result.stdout.includes('\n*'));

    const read = parseRefs(result.stdout, { form: command.form });
    assert.equal(read.unborn, true);
    assert.equal(read.branchCount, 1);

    const symref = await runGit(headSymrefArgs(), { cwd: lab.repo });
    const named = parseRefs(result.stdout, {
      form: command.form,
      unbornName: symref.stdout.trim(),
    });
    assert.deepEqual(named.head, { kind: 'unborn', name: 'gh-pages' });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a bare repository answers the same read, from the branch HEAD names', async () => {
  const lab = await makeLab();
  try {
    // `lab.origin` is the bare repository the clone was pushed to. It has no
    // working tree, so nothing about this read may depend on there being one -
    // which is the property being checked, since discovery classifies bare
    // repositories as their own kind and still puts a row on the board for them.
    const read = await readRefs(lab.origin);
    assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
    assert.equal(read.lastCommit?.subject, 'Add the first file');
    // A bare repository has no upstream configured for its branches, and that is
    // a fact rather than a gap.
    assert.deepEqual(read.divergence, { kind: 'no-upstream' });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a linked worktree reports its own HEAD, not the checkout it was made from', async () => {
  const lab = await makeLab();
  try {
    const wt = path.join(lab.root, 'wt');
    git(lab.repo, ['worktree', 'add', '--quiet', '-b', 'side', wt, 'main']);
    await fs.writeFile(path.join(wt, 'b.txt'), 'side\n', 'utf8');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '--quiet', '-m', 'Work in the linked worktree']);

    // This is the reason the read is spawned in the working tree rather than in
    // the git directory. Both directories share one ref store, so `refs/heads/`
    // is identical from either - but `%(HEAD)` and the root `HEAD` ref are
    // resolved per worktree, and a read run in the wrong place would put the
    // main checkout's branch and commit on the worktree's row.
    const fromWorktree = await readRefs(wt);
    assert.deepEqual(fromWorktree.head, { kind: 'branch', name: 'side' });
    assert.equal(fromWorktree.lastCommit?.subject, 'Work in the linked worktree');

    const fromMain = await readRefs(lab.repo);
    assert.deepEqual(fromMain.head, { kind: 'branch', name: 'main' });
    assert.equal(fromMain.lastCommit?.subject, 'Add the first file');
  } finally {
    await removeLab(lab);
  }
});

gitTest('symbolic-ref separates unborn from detached, which is what it is there for', async () => {
  const lab = await makeLab();
  try {
    git(lab.repo, ['checkout', '--quiet', '--detach', 'HEAD']);
    const detached = await runGit(headSymrefArgs(), { cwd: lab.repo });
    assert.notEqual(detached.code, 0);
    assert.equal(detached.stdout.trim(), '');

    // And the commit the fallback would then have to fetch separately.
    const log = await runGit(headCommitArgs(), { cwd: lab.repo });
    assert.equal(log.code, 0);
    assert.equal(parseHeadCommit(log.stdout)?.subject, 'Add the first file');
  } finally {
    await removeLab(lab);
  }
});

gitTest('the HEAD pattern needs the flag, and the flag needs the pattern', async () => {
  const lab = await makeLab();
  try {
    // Without the flag the HEAD pattern matches nothing - silently, exit 0.
    const noFlag = await runGit(['for-each-ref', '--format=%(refname)', 'HEAD'], {
      cwd: lab.repo,
    });
    assert.equal(noFlag.code, 0);
    assert.equal(noFlag.stdout, '');

    // Without the patterns the flag drags in remotes as well.
    const noPattern = await runGit(
      ['for-each-ref', '--include-root-refs', '--format=%(refname)'],
      { cwd: lab.repo },
    );
    assert.equal(noPattern.code, 0);
    assert.ok(noPattern.stdout.includes('refs/remotes/origin/main'));

    // And the patterns exclude more than remotes and tags. `ORIG_HEAD` is a
    // root ref like `HEAD`, so the flag alone lists it after any reset - a row
    // this parser would otherwise have to know to ignore.
    git(lab.repo, ['reset', '--quiet', '--hard', 'HEAD']);
    const withOrigHead = await runGit(
      ['for-each-ref', '--include-root-refs', '--format=%(refname)'],
      { cwd: lab.repo },
    );
    assert.ok(withOrigHead.stdout.includes('ORIG_HEAD'));

    // Both together give the two rows the parse is built on and nothing else.
    const both = await runGit(refsArgs(), { cwd: lab.repo });
    const refnames = both.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\u001f')[1]);
    assert.deepEqual(refnames.sort(), ['HEAD', 'refs/heads/main']);
  } finally {
    await removeLab(lab);
  }
});

gitTest('a subject carrying the separator survives the round trip through git', async () => {
  const lab = await makeLab();
  try {
    // Verified rather than assumed: git accepts a control character in a commit
    // message and prints it back, which is why the subject is the last field.
    const subject = 'Refactor a|b and \u001f unit sep';
    await fs.writeFile(path.join(lab.repo, 'c.txt'), 'x\n', 'utf8');
    git(lab.repo, ['add', '-A']);
    git(lab.repo, ['commit', '--quiet', '-m', subject]);

    const read = await readRefs(lab.repo);
    assert.equal(read.lastCommit?.subject, subject);
    assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
    assert.deepEqual(read.divergence, {
      kind: 'diverged',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    });
  } finally {
    await removeLab(lab);
  }
});

gitTest('a wrapped first paragraph arrives as one line, so records stay one line', async () => {
  const lab = await makeLab();
  try {
    await fs.writeFile(path.join(lab.repo, 'd.txt'), 'x\n', 'utf8');
    git(lab.repo, ['add', '-A']);
    git(lab.repo, ['commit', '--quiet', '--file', '-'], 'First line\nthat wraps\n\nAnd a body.\n');

    const read = await readRefs(lab.repo);
    assert.equal(read.lastCommit?.subject, 'First line that wraps');
    assert.equal(read.incomplete, undefined);
  } finally {
    await removeLab(lab);
  }
});

gitTest('several hundred refs are read and counted in the one process', async () => {
  const lab = await makeLab();
  try {
    const sha = git(lab.repo, ['rev-parse', 'HEAD']).trim();
    // One process rather than 400 `git branch` calls: the point of the test is
    // the read, and building the fixture should not dominate its runtime.
    const creates = Array.from(
      { length: 400 },
      (_unused, index) => `create refs/heads/wip/branch-${index} ${sha}\n`,
    ).join('');
    git(lab.repo, ['update-ref', '--stdin'], creates);

    const read = await readRefs(lab.repo);
    assert.equal(read.branchCount, 401);
    assert.deepEqual(read.head, { kind: 'branch', name: 'main' });
    assert.equal(read.incomplete, undefined);
  } finally {
    await removeLab(lab);
  }
});

gitTest('a read cut off by its byte cap withholds the count rather than reporting zero', async () => {
  const lab = await makeLab();
  try {
    const command = await refsCommand();
    // A cap of zero is the one value that truncates whatever the pipe hands
    // over first. `runGit` keeps a chunk that started under the cap, so any
    // other value needs an answer big enough to arrive in more than one chunk -
    // which depends on the pipe buffer, and a test that depends on that passes
    // or fails by machine. What this asserts is the wiring: a truncated
    // `GitResult` reaching the parse as a truncated answer.
    const result = await runGit(command.args, { cwd: lab.repo, maxBytes: 0 });
    assert.equal(result.truncated, true);

    const read = parseRefs(result.stdout, { form: command.form, truncated: result.truncated });
    assert.equal(read.branchCount, undefined, 'a count nobody finished must not render as a number');
    assert.ok(read.incomplete);
    assert.equal(read.unborn, false, 'a cut-off answer is not a repository without commits');
  } finally {
    await removeLab(lab);
  }
});

gitTest('the fallback form answers the same for a repository on a branch', async () => {
  const lab = await makeLab();
  try {
    await commit(lab.repo, 'Work that is only here');
    const legacy = await runGit(legacyRefsArgs(), { cwd: lab.repo });
    assert.equal(legacy.code, 0);

    const read = parseRefs(legacy.stdout, { form: 'heads-only' });
    const modern = await readRefs(lab.repo);
    assert.deepEqual(read.head, modern.head);
    assert.deepEqual(read.divergence, modern.divergence);
    assert.deepEqual(read.lastCommit, modern.lastCommit);
    assert.equal(read.branchCount, modern.branchCount);
  } finally {
    await removeLab(lab);
  }
});

gitTest('this git supports the one-process form, and the probe says so', async () => {
  resetRefsCapability();
  try {
    // The probe reads usage text rather than comparing version numbers, and
    // works outside a repository - which is where the extension host runs.
    const supported = await supportsRootRefs();
    const command = await refsCommand();
    assert.equal(command.form, supported ? 'root-refs' : 'heads-only');
    assert.equal(command.args.includes('--include-root-refs'), supported);
  } finally {
    resetRefsCapability();
  }
});
