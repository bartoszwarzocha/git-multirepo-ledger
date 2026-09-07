/**
 * Filesystem helpers that answer with `undefined` instead of throwing.
 *
 * The extension reads directories it does not own: a repository can be renamed,
 * moved or deleted between being listed and being read, and a permission error
 * on one root must not empty the list. Letting those throw would hand one
 * unreadable directory the power to decide what the whole view shows.
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export async function statSafe(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}

export async function exists(target: string): Promise<boolean> {
  return (await statSafe(target)) !== undefined;
}

export async function isDirectory(target: string): Promise<boolean> {
  const stats = await statSafe(target);
  return stats?.isDirectory() ?? false;
}

export async function isFile(target: string): Promise<boolean> {
  const stats = await statSafe(target);
  return stats?.isFile() ?? false;
}

/**
 * The stamp a cache is keyed on: modification time and size, rather than a hash
 * of the contents. A stat is one syscall and a hash is a full read, so a refresh
 * that hashed everything it had already seen would cost more than the re-read
 * the cache exists to avoid.
 */
export async function stamp(target: string): Promise<FileStamp | undefined> {
  const stats = await statSafe(target);
  return stats ? { mtimeMs: stats.mtimeMs, size: stats.size } : undefined;
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function readTextSafe(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

/** Immediate subdirectory names, sorted. Empty when the directory is unreadable. */
export async function listDirectories(target: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Immediate file names, sorted. Empty when the directory is unreadable. */
export async function listFiles(target: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// The three functions below are the only ones here that write, and where they
// are allowed to write is fixed now rather than argued about later: the
// extension's own storage, `context.globalStorageUri`, and nowhere else. Every
// other path this extension holds is a directory somebody else's repository
// lives in, and dropping so much as a cache file inside one would put an
// untracked file in a working tree the user is about to commit from - which
// contradicts the one promise the whole thing rests on, that everything it runs
// is a read. Nothing calls them yet; a cache is the expected first caller.

export async function ensureDirectory(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

/**
 * Write through a sibling temporary file so a crash mid-write cannot leave a
 * half-written file behind.
 */
export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, contents, 'utf8');
  await fs.rename(temp, target);
}

export async function removeFile(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}
