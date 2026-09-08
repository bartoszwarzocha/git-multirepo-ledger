import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyFetch,
  fetchArgs,
  fetchEnvironment,
  fetchSentence,
  type FetchFailure,
  type FetchReport,
} from './fetch.ts';

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('the command is exactly what a person would type', () => {
  assert.deepEqual(fetchArgs(), ['fetch']);
});

test('nothing that writes beyond the fetch is on the command line', () => {
  const args = fetchArgs();
  for (const forbidden of ['--prune', '--all', '--tags', '-p', '--force']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not be here`);
  }
});

test('the read-only flag is absent, because this is the one thing that is not a read', () => {
  assert.ok(!fetchArgs().includes('--no-optional-locks'));
});

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

test('git cannot ask for a password it has nowhere to ask on', () => {
  const env = fetchEnvironment({ GIT_ASKPASS: '/usr/bin/askpass', SSH_ASKPASS: 'x', PATH: '/bin' });
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
  // Removed, not emptied: an empty value is still a value, and git would try
  // to run it.
  assert.ok(!('GIT_ASKPASS' in env));
  assert.ok(!('SSH_ASKPASS' in env));
  // Everything else the host had is still there.
  assert.equal(env['PATH'], '/bin');
});

test('ssh refuses rather than waiting on a passphrase', () => {
  assert.equal(fetchEnvironment({})['GIT_SSH_COMMAND'], 'ssh -oBatchMode=yes');
});

test("an ssh command the user set themselves is left alone", () => {
  // They know something about their setup that this does not, and appending
  // options to a command string of unknown shape would break it.
  const env = fetchEnvironment({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' });
  assert.equal(env['GIT_SSH_COMMAND'], 'ssh -i ~/.ssh/work');
});

// ---------------------------------------------------------------------------
// What went wrong
// ---------------------------------------------------------------------------

test('a fetch that worked is not classified at all', () => {
  assert.equal(classifyFetch({ code: 0, stderr: '', timedOut: false }), undefined);
});

test('the guard firing is reported as time, not as a refusal', () => {
  assert.equal(classifyFetch({ code: 143, stderr: '', timedOut: true }), 'timed-out');
});

test('a prompt that could not be shown is a credentials problem', () => {
  assert.equal(
    classifyFetch({
      code: 128,
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      timedOut: false,
    }),
    'credentials',
  );
});

test('a name that does not resolve is a reachability problem', () => {
  assert.equal(
    classifyFetch({
      code: 128,
      stderr: "fatal: unable to access 'https://x/': Could not resolve host: x",
      timedOut: false,
    }),
    'unreachable',
  );
});

test('anything unrecognised claims nothing', () => {
  // git is translated, so matching English is a convenience and never the
  // evidence. What the reader is shown is git's own words either way.
  assert.equal(
    classifyFetch({ code: 1, stderr: 'fatal: quelque chose est arrivé', timedOut: false }),
    'refused',
  );
});

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

function failure(over: Partial<FetchFailure> = {}): FetchFailure {
  return {
    label: 'one',
    path: 'E:/AI/one',
    reason: 'credentials',
    command: 'git fetch',
    stderr: 'fatal: authentication failed',
    ...over,
  };
}

function report(over: Partial<FetchReport> = {}): FetchReport {
  return { attempted: 0, fetched: 0, skipped: 0, failures: [], cancelled: false, ...over };
}

test('what failed is named before what worked', () => {
  const sentence = fetchSentence(
    report({
      attempted: 3,
      fetched: 2,
      failures: [failure()],
    }),
  );
  assert.ok(sentence.startsWith('1 repository did not fetch: 1 needed credentials'));
  assert.ok(sentence.includes('2 repositories fetched'));
});

test('failures are counted by kind, so the sentence says what to do about them', () => {
  const sentence = fetchSentence(
    report({
      failures: [
        failure({ reason: 'credentials' }),
        failure({ reason: 'credentials' }),
        failure({ reason: 'unreachable' }),
      ],
    }),
  );
  assert.ok(sentence.includes('2 needed credentials'));
  assert.ok(sentence.includes('1 could not reach their server'));
});

test('a repository with no remote has not failed at anything', () => {
  const sentence = fetchSentence(report({ skipped: 4 }));
  assert.ok(sentence.includes('4 had no remote'));
  assert.ok(!sentence.includes('did not fetch'));
});

test('stopping early is said out loud', () => {
  assert.ok(fetchSentence(report({ fetched: 2, cancelled: true })).includes('stopped early'));
});

test('nothing happening is still an answer', () => {
  // Silence after a button press reads as a button that does not work.
  assert.equal(fetchSentence(report()), 'Nothing to fetch.');
});
