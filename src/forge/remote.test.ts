import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forgeKindOf, parseForgeTarget, parseRemotes, primaryRemote } from './remote.ts';

// ---------------------------------------------------------------------------
// .git/config
// ---------------------------------------------------------------------------

const CONFIG = `[core]
\trepositoryformatversion = 0
\tbare = false
[remote "origin"]
\turl = https://github.com/owner/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "upstream"]
\turl = git@github.com:other/repo.git
[branch "main"]
\tremote = origin
`;

test('remotes are read out of the config, and nothing else is', () => {
  assert.deepEqual(parseRemotes(CONFIG), [
    { name: 'origin', url: 'https://github.com/owner/repo.git' },
    { name: 'upstream', url: 'git@github.com:other/repo.git' },
  ]);
});

test('a section header is matched however git spelled its keyword', () => {
  assert.deepEqual(parseRemotes('[REMOTE "o"]\n url = https://example.com/a/b.git\n'), [
    { name: 'o', url: 'https://example.com/a/b.git' },
  ]);
});

test('a subsection name keeps its case, because git treats it as case-sensitive', () => {
  assert.equal(parseRemotes('[remote "Origin"]\n url = x\n')[0]?.name, 'Origin');
});

test('comments and blank lines are ignored', () => {
  const config = '# a comment\n; another\n\n[remote "o"]\n\turl = https://h/a/b.git\n';
  assert.equal(parseRemotes(config).length, 1);
});

test('a key outside any remote section is not mistaken for a remote url', () => {
  assert.deepEqual(parseRemotes('[core]\n\turl = not-a-remote\n'), []);
});

test('an empty or unreadable config yields no remotes rather than throwing', () => {
  assert.deepEqual(parseRemotes(''), []);
});

test('origin wins, then upstream, then whatever came first', () => {
  assert.equal(primaryRemote(parseRemotes(CONFIG))?.name, 'origin');
  assert.equal(
    primaryRemote([
      { name: 'fork', url: 'a' },
      { name: 'upstream', url: 'b' },
    ])?.name,
    'upstream',
  );
  assert.equal(primaryRemote([{ name: 'fork', url: 'a' }])?.name, 'fork');
  assert.equal(primaryRemote([]), undefined);
});

// ---------------------------------------------------------------------------
// Remote URLs
// ---------------------------------------------------------------------------

test('an https URL yields host, owner and name without the .git suffix', () => {
  assert.deepEqual(parseForgeTarget('https://github.com/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
  });
});

test('the scp-like form is not a URL, and its colon is not a port', () => {
  // `new URL()` reads `github.com:owner` as a host and a port, which is the
  // specific mistake this parser exists to avoid.
  assert.deepEqual(parseForgeTarget('git@github.com:owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    name: 'repo',
  });
});

test('an ssh URL with a real port keeps the host and drops the port', () => {
  assert.deepEqual(parseForgeTarget('ssh://git@gitlab.example.com:2222/group/sub/repo.git'), {
    host: 'gitlab.example.com',
    owner: 'group/sub',
    name: 'repo',
  });
});

test('a GitLab subgroup path stays whole, because that is what glab takes', () => {
  assert.equal(parseForgeTarget('https://gitlab.com/a/b/c/repo')?.owner, 'a/b/c');
});

test('the host is folded, because a query keyed on it must match either spelling', () => {
  assert.equal(parseForgeTarget('https://GitHub.COM/o/r')?.host, 'github.com');
});

test('a local path has no forge, which is the answer rather than a failure', () => {
  assert.equal(parseForgeTarget('/srv/git/repo.git'), undefined);
  assert.equal(parseForgeTarget('file:///srv/git/repo.git'), undefined);
  assert.equal(parseForgeTarget('C:\\src\\repo'), undefined);
});

test('a URL with too few segments to name a repository yields nothing', () => {
  assert.equal(parseForgeTarget('https://github.com/owner'), undefined);
  assert.equal(parseForgeTarget(''), undefined);
});

// ---------------------------------------------------------------------------
// Which tool speaks to which host
// ---------------------------------------------------------------------------

test('the two hosted forges are recognised', () => {
  assert.equal(forgeKindOf('github.com'), 'github');
  assert.equal(forgeKindOf('gitlab.com'), 'gitlab');
});

test('a self-hosted instance is recognised by its name, which is the common case', () => {
  assert.equal(forgeKindOf('gitlab.example.internal'), 'gitlab');
  assert.equal(forgeKindOf('github.enterprise.example'), 'github');
});

test('a host with no client this version speaks gets no query rather than a wrong one', () => {
  assert.equal(forgeKindOf('bitbucket.org'), undefined);
  assert.equal(forgeKindOf('git.sr.ht'), undefined);
  assert.equal(forgeKindOf('gitea.example.com'), undefined);
});
