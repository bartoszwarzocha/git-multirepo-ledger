/**
 * Path identity: the one place that decides whether two paths are the same
 * repository.
 *
 * Every set, map and de-duplication in discovery is keyed through here rather
 * than on the raw string, because the same directory arrives from the editor's
 * index, from a settings entry and from a filesystem walk in three different
 * spellings - forward and back slashes, a trailing separator, and on Windows a
 * different case. Comparing raw strings would show one repository as two rows.
 */

import * as path from 'node:path';

/** Windows and macOS compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * A path in one spelling: absolute, native separators, no trailing separator.
 *
 * Case is left alone here and folded only in `pathKey`, because this value is
 * shown to people - a label, a tooltip, a log line - and lower-casing a path
 * the user recognises makes it harder to read for no gain.
 */
export function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  if (resolved.length <= 1) {
    return resolved;
  }
  // `path.resolve` already strips a trailing separator except at a root, where
  // it is part of the path and must stay: `C:\` and `/` are not `C:` and ``.
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return resolved;
  }
  return resolved.replace(/[\\/]+$/, '');
}

/**
 * The comparison key for a path. Never displayed.
 *
 * Case folding is by platform rather than always-on: folding on Linux would
 * merge `~/src/Foo` and `~/src/foo`, which really are two different
 * repositories there, and a merged row would silently hide one of them.
 */
export function pathKey(target: string): string {
  const normalized = normalizePath(target);
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Whether `target` is `parent` or sits beneath it.
 *
 * The separator check is what stops `C:\a\bc` from counting as inside
 * `C:\a\b` - a prefix comparison alone says yes, and the consequence would be a
 * repository excluded, or claimed by the wrong workspace folder, because its
 * name happened to start with another directory's name.
 */
export function isPathInside(target: string, parent: string): boolean {
  const t = pathKey(target);
  const p = pathKey(parent);
  if (t === p) {
    return true;
  }
  const withSeparator = p.endsWith(path.sep) ? p : p + path.sep;
  return t.startsWith(withSeparator);
}

/** The identity of a repository row. Its working tree path, folded. */
export function repoKey(worktreePath: string): string {
  return pathKey(worktreePath);
}

/**
 * git's own abbreviation, when there is one, and a fallback that is only
 * reached for a value this extension did not get from git.
 *
 * Deliberately not a fixed width: git chooses an abbreviation long enough to be
 * unambiguous in that repository, which a hard-coded seven characters is not in
 * a large one. So a value that already looks abbreviated is passed through.
 */
export function shortSha(sha: string): string {
  const trimmed = sha.trim();
  return trimmed.length > 12 ? trimmed.slice(0, 7) : trimmed;
}
