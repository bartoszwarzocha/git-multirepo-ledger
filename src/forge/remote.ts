/**
 * Which forge a repository points at, read from `.git/config` rather than asked
 * of git.
 *
 * Zero processes. The alternative is `git config --get remote.origin.url`, or
 * `git remote -v`, and either is one more spawn per repository for a fact that
 * is four lines of an INI file the extension is already standing next to.
 * Spawn count is the whole budget of this board: a directory of two hundred
 * repositories would pay two hundred processes for a string.
 *
 * The parse is deliberately small. It reads `[remote "name"] url = ...` and
 * nothing else - not includes, not conditional includes, not `insteadOf`
 * rewrites. A repository whose remote URL is only reachable through one of
 * those reads as having no remote this can classify, which costs a review count
 * and costs nothing else; guessing at it would put the wrong owner in a query.
 */

/** One remote, as `.git/config` spells it. */
export interface Remote {
  readonly name: string;
  readonly url: string;
}

/** A remote URL taken apart far enough to query a forge with. */
export interface ForgeTarget {
  /** Lower-cased host: `github.com`, `gitlab.com`, `gitlab.example.internal`. */
  readonly host: string;
  /**
   * Everything between the host and the repository name.
   *
   * A single segment on GitHub, and possibly several on GitLab, where a project
   * can sit under a group and any number of subgroups. Kept whole because that
   * is what `glab --group` wants and what `gh --owner` wants the first part of.
   */
  readonly owner: string;
  /** The repository name, without `.git`. */
  readonly name: string;
}

/**
 * `.git/config` in, remotes out.
 *
 * Section headers are matched case-insensitively because git accepts them that
 * way, and a subsection name - the part in quotes - is case-sensitive, which is
 * why only the keyword is folded.
 */
export function parseRemotes(config: string): Remote[] {
  const remotes = new Map<string, string>();
  let current: string | undefined;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const section = /^\[([^\]\s]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (section) {
      current =
        (section[1] ?? '').toLowerCase() === 'remote' && section[2] !== undefined
          ? section[2]
          : undefined;
      continue;
    }

    if (current === undefined) {
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) {
      continue;
    }
    if ((line.slice(0, equals).trim().toLowerCase()) !== 'url') {
      continue;
    }
    // The first `url` in a section wins, which is what git does: a later one is
    // an override only when the config is read with the later file's precedence,
    // and this parser reads one file.
    if (!remotes.has(current)) {
      remotes.set(current, line.slice(equals + 1).trim());
    }
  }

  return [...remotes].map(([name, url]) => ({ name, url }));
}

/**
 * Which remote a review count should be about.
 *
 * `origin` when there is one, `upstream` next, then whichever came first. A
 * directory can hold forks, mirrors and repositories with four remotes, and
 * asking about all of them would multiply the queries by the remotes; asking
 * about the one the reader pushes to is the question they meant.
 */
export function primaryRemote(remotes: readonly Remote[]): Remote | undefined {
  return (
    remotes.find((remote) => remote.name === 'origin') ??
    remotes.find((remote) => remote.name === 'upstream') ??
    remotes[0]
  );
}

/**
 * A remote URL taken apart, in every spelling git accepts.
 *
 * Four shapes, and the third is the one that catches a naive parser:
 *
 *   https://github.com/owner/repo.git
 *   ssh://git@gitlab.example.com:2222/group/sub/repo.git
 *   git@github.com:owner/repo.git          <- scp-like, no scheme, colon not a port
 *   /srv/git/repo.git                      <- a local path, and no forge at all
 *
 * The scp-like form is not a URL and `new URL()` either rejects it or reads
 * `github.com:owner` as a host and a port. A local path has no host, which is
 * the answer rather than a failure: a repository nobody publishes has no review
 * state to count, and saying so is different from failing to work it out.
 */
export function parseForgeTarget(url: string): ForgeTarget | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let host: string;
  let pathname: string;

  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scpLike[1] ?? '';
    pathname = scpLike[2] ?? '';
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'file:' || parsed.hostname.length === 0) {
        return undefined;
      }
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
  }

  const segments = pathname
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    return undefined;
  }

  return {
    host: host.toLowerCase(),
    owner: segments.slice(0, -1).join('/'),
    name: segments[segments.length - 1] ?? '',
  };
}

/**
 * Which command line tool, if any, speaks to this host.
 *
 * Matched on the host name rather than on a list of known hosts, because a
 * self-hosted GitLab is the common case and its host is whatever the company
 * called it. `gh` reaches GitHub Enterprise the same way. A host that matches
 * neither gets no query, which is the honest answer for a Gitea or a Bitbucket
 * this version has no client for.
 */
export type ForgeKind = 'github' | 'gitlab';

export function forgeKindOf(host: string): ForgeKind | undefined {
  const lower = host.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com') || lower.startsWith('github.')) {
    return 'github';
  }
  if (lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.startsWith('gitlab.')) {
    return 'gitlab';
  }
  return undefined;
}
