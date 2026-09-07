import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  githubArgs,
  gitlabArgs,
  OWNER_QUERY_LIMIT,
  ownerQueriesFor,
  parseGithubCounts,
  parseGitlabCounts,
  targetKey,
} from './counts.ts';
import type { ForgeTarget } from './remote.ts';

const gh = (owner: string, name: string): ForgeTarget => ({ host: 'github.com', owner, name });
const gl = (owner: string, name: string): ForgeTarget => ({ host: 'gitlab.com', owner, name });

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test('ten repositories under one owner cost one query, which is the whole design', () => {
  // GitHub allows thirty search requests a minute; asked one repository at a
  // time, a directory this size would render a half-populated board.
  const targets = Array.from({ length: 10 }, (_, index) => gh('acme', `service-${index}`));
  assert.equal(ownerQueriesFor(targets).length, 1);
});

test('two owners are two queries, and two hosts are not merged', () => {
  const queries = ownerQueriesFor([
    gh('acme', 'a'),
    gh('other', 'b'),
    { host: 'gitlab.example.com', owner: 'team', name: 'c' },
  ]);
  assert.equal(queries.length, 3);
});

test('a GitHub owner is the first segment; a GitLab group keeps its whole path', () => {
  assert.equal(ownerQueriesFor([gh('acme/extra', 'a')])[0]?.owner, 'acme');
  assert.equal(ownerQueriesFor([gl('group/sub', 'a')])[0]?.owner, 'group/sub');
});

test('a host with no client is not queried at all', () => {
  assert.deepEqual(ownerQueriesFor([{ host: 'bitbucket.org', owner: 'o', name: 'r' }]), []);
});

test('the key a row finds its own count by is folded, so either spelling matches', () => {
  assert.equal(targetKey({ host: 'GitHub.com', owner: 'Acme', name: 'Repo' }), 'github.com/acme/repo');
});

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

test('the GitHub query asks for open pull requests and the repository of each', () => {
  const args = githubArgs({ kind: 'github', host: 'github.com', owner: 'acme' });
  assert.ok(args.includes('--owner'));
  assert.equal(args[args.indexOf('--owner') + 1], 'acme');
  assert.equal(args[args.indexOf('--state') + 1], 'open');
  assert.equal(args[args.indexOf('--json') + 1], 'repository');
});

test('the GitLab query asks a group, because its project list carries no count', () => {
  const args = gitlabArgs({ kind: 'gitlab', host: 'gitlab.com', owner: 'group/sub' });
  assert.equal(args[args.indexOf('--group') + 1], 'group/sub');
  assert.equal(args[args.indexOf('--state') + 1], 'opened');
});

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

test('GitHub results are counted per repository', () => {
  const stdout = JSON.stringify([
    { repository: { nameWithOwner: 'acme/one' } },
    { repository: { nameWithOwner: 'acme/one' } },
    { repository: { nameWithOwner: 'acme/two' } },
  ]);
  const answer = parseGithubCounts(stdout, 'github.com');
  assert.equal(answer.counts.get('github.com/acme/one'), 2);
  assert.equal(answer.counts.get('github.com/acme/two'), 1);
  assert.equal(answer.truncated, false);
});

test('a query that filled its limit says so, so no count renders as an exact total', () => {
  // A repository that genuinely has exactly the limit open is indistinguishable
  // from one whose count stopped short, so the query reports it rather than
  // leaving the number to be trusted.
  const full = JSON.stringify(
    Array.from({ length: OWNER_QUERY_LIMIT }, () => ({
      repository: { nameWithOwner: 'acme/one' },
    })),
  );
  assert.equal(parseGithubCounts(full, 'github.com').truncated, true);
});

test('a repository with nothing open is simply absent from the answer, not zero in it', () => {
  // The zero is supplied later, by the pass, and only for repositories the
  // query actually covered - which is the difference between "none open" and
  // "nobody asked".
  const answer = parseGithubCounts(JSON.stringify([]), 'github.com');
  assert.equal(answer.counts.get('github.com/acme/one'), undefined);
});

test('output that is not the expected shape loses no other row', () => {
  assert.equal(parseGithubCounts('not json at all', 'github.com').counts.size, 0);
  assert.equal(parseGithubCounts(JSON.stringify({ error: 'x' }), 'github.com').counts.size, 0);
  assert.equal(
    parseGithubCounts(JSON.stringify([{ repository: {} }, { nothing: true }]), 'github.com').counts
      .size,
    0,
  );
});

test('GitLab results are attributed by the project path in the merge request URL', () => {
  const stdout = JSON.stringify([
    { web_url: 'https://gitlab.com/group/sub/project/-/merge_requests/1' },
    { web_url: 'https://gitlab.com/group/sub/project/-/merge_requests/4' },
    { web_url: 'https://gitlab.com/group/other/-/merge_requests/2' },
  ]);
  const answer = parseGitlabCounts(stdout, 'gitlab.com');
  assert.equal(answer.counts.get('gitlab.com/group/sub/project'), 2);
  assert.equal(answer.counts.get('gitlab.com/group/other'), 1);
});

test('a GitLab entry without a usable URL is skipped rather than miscounted', () => {
  const stdout = JSON.stringify([{ web_url: 'https://gitlab.com/nothing-useful' }, { id: 7 }]);
  assert.equal(parseGitlabCounts(stdout, 'gitlab.com').counts.size, 0);
});
