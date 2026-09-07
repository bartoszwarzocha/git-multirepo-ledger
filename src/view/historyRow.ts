/**
 * The history pane as pure data: what each commit row says, already decided.
 *
 * Nothing here imports `vscode`, so every sentence the pane shows is decided in
 * a module a test can call. The webview beneath it only places these strings.
 */

import type { Commit, CommitFile, CommitRef } from '../model/types.ts';
import { relativeAge, absoluteTime } from './row.ts';

export interface RenderedCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly age: string;
  readonly author: string;
  readonly subject: string;
  readonly refs: readonly CommitRef[];
  /** True only when the unpushed set was established and this commit is in it. */
  readonly unpushed: boolean;
  /** Set for a merge: it has more than one parent and cannot be diffed in one process. */
  readonly mergeOf?: number;
  readonly tooltip: string;
}

export function buildCommit(commit: Commit, now: number, unpushedKnown: boolean): RenderedCommit {
  const merge = commit.parents.length > 1;
  const lines = [
    commit.subject,
    '',
    `${commit.shortSha} · ${commit.author}`,
    absoluteTime(commit.committedAt),
  ];
  if (merge) {
    // Named rather than left for the reader to work out from an empty file
    // list: a merge with no changed files looks like a failed read, and this is
    // the difference between "nothing to show" and "could not ask".
    lines.push(`A merge of ${commit.parents.length} parents; its changes belong to them.`);
  }
  if (unpushedKnown && commit.unpushed) {
    lines.push('Exists on no remote this repository knows about.');
  }

  const rendered: RenderedCommit = {
    sha: commit.sha,
    shortSha: commit.shortSha,
    age: relativeAge(commit.committedAt, now),
    author: commit.author,
    subject: commit.subject.length > 0 ? commit.subject : '(no subject)',
    refs: commit.refs,
    unpushed: unpushedKnown && commit.unpushed,
    tooltip: lines.join('\n'),
  };
  return merge ? { ...rendered, mergeOf: commit.parents.length } : rendered;
}

export function buildCommits(
  commits: readonly Commit[],
  now: number,
  unpushedKnown: boolean,
): RenderedCommit[] {
  return commits.map((commit) => buildCommit(commit, now, unpushedKnown));
}

/**
 * git's status letter, spelled out.
 *
 * The letter alone is a convention this extension has no reason to assume its
 * reader shares, and the word costs one column in a pane that has room for it.
 */
const STATUS_WORDS: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

export interface RenderedFile {
  readonly status: string;
  readonly word: string;
  readonly path: string;
  /** The directory part, dimmed ahead of the name, so the name wins the width. */
  readonly directory: string;
  readonly name: string;
  readonly tooltip: string;
  /** A file the commit removed has no "after" side; one it added has no "before". */
  readonly deleted: boolean;
  readonly added: boolean;
}

export function buildFile(file: CommitFile): RenderedFile {
  const slash = file.path.lastIndexOf('/');
  const word = STATUS_WORDS[file.status] ?? file.status;
  const tooltip =
    file.oldPath === undefined
      ? `${word}: ${file.path}`
      : `${word}: ${file.oldPath} → ${file.path}`;
  return {
    status: file.status,
    word,
    path: file.path,
    directory: slash >= 0 ? file.path.slice(0, slash + 1) : '',
    name: slash >= 0 ? file.path.slice(slash + 1) : file.path,
    tooltip,
    deleted: file.status === 'D',
    added: file.status === 'A',
  };
}

export function buildFiles(files: readonly CommitFile[]): RenderedFile[] {
  return files.map(buildFile);
}
