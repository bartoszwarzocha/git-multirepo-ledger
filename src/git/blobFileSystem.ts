/**
 * A read-only filesystem over `git cat-file`, so a commit's changes can open in
 * the editor's own diff.
 *
 * The obvious route is the `git:` URI scheme the built-in Git extension
 * registers, and it does not work here. That provider resolves only for
 * repositories its own model has opened - which is the workspace's - and every
 * repository this extension exists to show is one the editor has *not* opened.
 * `readFile` throws `FileNotFound` for them, and the fallback that exists on
 * newer builds fires only in an empty window.
 *
 * Rejected, and the reason it is worth naming: calling the Git extension's
 * exported `openRepository()` to make those URIs resolve. It works, and it
 * silently adds every repository the reader clicked into their Source Control
 * view, which is a change to their editor that they did not ask for and cannot
 * easily undo. Doing it behind their back to make a diff render is not a trade
 * this extension gets to make on their behalf; the same call as a labelled
 * action they pressed is fine, and that is where it lives instead.
 *
 * Rejected: a `TextDocumentContentProvider`, which is far less code. It returns
 * a `string`, and the API documents its content as end-of-line normalised - so
 * a file with CRLF endings would diff as though every line had changed, or as
 * though none had, depending on which side was normalised. A diff that lies
 * about whitespace is worse than no diff.
 */

import * as vscode from 'vscode';

import { runGitBuffer } from '../util/git.ts';

/**
 * The scheme. Private to this extension, and registered read-only, so nothing
 * outside can be written through it.
 */
export const BLOB_SCHEME = 'repo-ledger';

/**
 * Build the URI for one path at one commit.
 *
 * The repository and the object id travel in the query rather than the path
 * because the path segment is what the editor shows in the diff title and in
 * the tab: keeping it to the repository-relative path is what makes the tab
 * read `src/app.ts (7c86ebf)` rather than a URL. The fragment carries the short
 * hash for the same reason - it is what the diff title picks up.
 *
 * `vscode.Uri.from` percent-encodes the query, so a repository path with a
 * space or a hash in it survives the round trip; hand-building the string does
 * not, and that is exactly the case a Windows user hits first.
 */
export function blobUri(repositoryPath: string, sha: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BLOB_SCHEME,
    path: `/${filePath.replace(/^\/+/, '')}`,
    query: JSON.stringify({ repo: repositoryPath, sha }),
  });
}

interface BlobRef {
  readonly repo: string;
  readonly sha: string;
  readonly path: string;
}

function parse(uri: vscode.Uri): BlobRef | undefined {
  try {
    const query = JSON.parse(uri.query) as { repo?: unknown; sha?: unknown };
    if (typeof query.repo !== 'string' || typeof query.sha !== 'string') {
      return undefined;
    }
    return { repo: query.repo, sha: query.sha, path: uri.path.replace(/^\/+/, '') };
  } catch {
    return undefined;
  }
}

/**
 * The empty side of a diff.
 *
 * A file added by a commit has no "before", and a file deleted by it has no
 * "after". The editor's diff wants two documents either way, so the missing
 * side is an empty one - which is also what git itself shows.
 */
export const EMPTY = new Uint8Array(0);

export class BlobFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  /**
   * Nothing here ever changes: a blob is named by its content and a commit is
   * immutable. The event exists because the interface requires it, and it never
   * fires - which is why the editor never re-reads one of these documents.
   */
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changed.event;

  dispose(): void {
    this.changed.dispose();
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.readFile(uri);
    // The timestamps are zero rather than invented. Nothing about a blob has a
    // modification time, and a plausible-looking one would be a fabrication the
    // editor might display.
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: content.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = parse(uri);
    if (!ref) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // An empty object id is how the caller asks for the empty side of a diff:
    // a file that the commit added has no previous revision to read.
    if (ref.sha.length === 0) {
      return EMPTY;
    }

    const result = await runGitBuffer(
      ['--no-optional-locks', 'cat-file', 'blob', `${ref.sha}:${ref.path}`],
      { cwd: ref.repo },
    );

    if (result.code !== 0) {
      // A path that did not exist at that commit is the ordinary case - the
      // other side of an add or a delete - and reads as an empty document
      // rather than an error dialog, because that is what it means.
      if (/does not exist|exists on disk, but not in|unknown revision/i.test(result.stderr)) {
        return EMPTY;
      }
      throw vscode.FileSystemError.FileNotFound(
        `${result.command}\n${result.stderr.trim()}`,
      );
    }
    return new Uint8Array(result.stdout);
  }

  // Everything below is the read-only half of the contract. Each throws rather
  // than silently doing nothing, so a future caller that tries to write through
  // this scheme fails loudly here instead of appearing to succeed.
  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions('Repo Ledger blobs are files, not directories');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Repo Ledger never writes to a repository');
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('Repo Ledger never writes to a repository');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Repo Ledger never writes to a repository');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Repo Ledger never writes to a repository');
  }
}
