/**
 * Builds a directory of git repositories to take screenshots against.
 *
 * The board is only worth a picture when it has something to say - one
 * repository three commits ahead, one behind, one diverged, one on a detached
 * HEAD, one with nothing committed yet - and none of that can be faked in a
 * static fixture, because every figure on the row is read out of a real `.git`.
 * So this builds real repositories, pushes to real (local) remotes, and lets
 * the extension derive the rest.
 *
 * Nothing here comes from anybody's real work. The products are invented, the
 * people are invented, and the remotes are bare repositories in a sibling
 * directory - so a screenshot taken against this exposes no directory name, no
 * branch name and no colleague's address that belongs to somebody.
 *
 *   node scripts/make-demo-workspace.ts [target] [--force]
 *
 * The default target is a sibling of this repository. `--force` replaces an
 * existing one; without it, an existing directory is left alone.
 *
 * Commit dates are relative to the moment it runs, not fixed. The sibling
 * project fixes its dates because its subject is a curve through the past;
 * here the board leads with "moved 20 minutes ago" and the report has a Today
 * row, so a workspace built from fixed dates would take a picture of a week
 * that ended months ago.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The invented people
// ---------------------------------------------------------------------------

interface Person {
  readonly name: string;
  readonly email: string;
}

const ADA: Person = { name: 'Ada Lovelace', email: 'ada@example.com' };
/**
 * The same person, from a second machine whose `user.name` was set differently.
 *
 * Deliberately in the demo: the picker folds these into one entry, and a
 * screenshot that only ever showed tidy identities would not show the one thing
 * about authorship this extension gets right.
 */
const ADA_OTHER_MACHINE: Person = { name: 'ada.lovelace', email: 'ada@example.com' };
const GRACE: Person = { name: 'Grace Hopper', email: 'grace@example.com' };
const ALAN: Person = { name: 'Alan Turing', email: 'alan@example.com' };

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / 1000);

/** `agoDays: 2, atHour: 14` -> two days ago, early afternoon, as a git date. */
function when(agoSeconds: number): string {
  return `${NOW - agoSeconds} +0000`;
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // Signing is off and the identity is passed per call: this must build the
      // same workspace on a machine with a global `user.name`, one with none,
      // and one that signs every commit.
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      { cwd, env: { ...process.env, ...env }, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} in ${cwd}\n${stderr || String(error)}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function commit(
  cwd: string,
  person: Person,
  subject: string,
  agoSeconds: number,
  file = 'src/main.txt',
): Promise<void> {
  const target = path.join(cwd, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${subject}\n`, 'utf8');
  await git(cwd, ['add', '--all']);
  await git(
    cwd,
    [
      '-c',
      `user.name=${person.name}`,
      '-c',
      `user.email=${person.email}`,
      'commit',
      '--quiet',
      '-m',
      subject,
    ],
    { GIT_AUTHOR_DATE: when(agoSeconds), GIT_COMMITTER_DATE: when(agoSeconds) },
  );
}

async function init(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  // `-b` is not available on every git this might meet; the config form is.
  await git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
}

/** A bare repository outside the walked directory, standing in for a forge. */
async function origin(originsDir: string, name: string, workingTree: string): Promise<string> {
  const bare = path.join(originsDir, `${name}.git`);
  await fs.mkdir(path.dirname(bare), { recursive: true });
  // The default branch has to be named here as well as in the working tree. A
  // bare repository initialised without it keeps whatever this machine's git
  // is configured to call the first branch, its HEAD then points at a ref that
  // the push never creates, and a later clone starts on an unborn branch of
  // that name - so the commits meant to put the remote ahead land on an
  // unrelated history and the push is refused.
  await git(originsDir, ['-c', 'init.defaultBranch=main', 'init', '--bare', '--quiet', `${name}.git`]);
  await git(workingTree, ['remote', 'add', 'origin', bare]);
  await git(workingTree, ['push', '--quiet', '-u', 'origin', 'main']);
  return bare;
}

/**
 * Put commits on the remote that the working tree has not seen.
 *
 * Done through a throwaway clone rather than by pushing from the demo
 * repository itself, because the point is to leave the demo repository's own
 * refs behind - which is what "behind" means.
 */
async function advanceOrigin(
  bare: string,
  scratch: string,
  person: Person,
  subjects: readonly string[],
  agoSeconds: number,
): Promise<void> {
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await git(path.dirname(scratch), ['clone', '--quiet', bare, path.basename(scratch)]);
  for (const [index, subject] of subjects.entries()) {
    await commit(scratch, person, subject, agoSeconds - index * HOUR);
  }
  await git(scratch, ['push', '--quiet', 'origin', 'HEAD:main']);
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---------------------------------------------------------------------------
// The repositories
// ---------------------------------------------------------------------------

async function build(target: string, originsDir: string): Promise<void> {
  const scratch = path.join(originsDir, '_scratch');

  // 1. Clean, in sync, busy - and the only one carrying a merge, so the merges
  //    filter and the merge count have something to find.
  {
    const root = path.join(target, 'atlas-api');
    await init(root);
    await commit(root, GRACE, 'Set up the service skeleton', 22 * DAY);
    await commit(root, ADA, 'Read the tariff table at start-up', 9 * DAY);
    await origin(originsDir, 'atlas-api', root);

    await git(root, ['checkout', '--quiet', '-b', 'rate-limits']);
    await commit(root, ALAN, 'Hold requests over the per-minute ceiling', 2 * DAY);
    await commit(root, ALAN, 'Return the retry hint the client needs', 2 * DAY - 3 * HOUR);
    await git(root, ['checkout', '--quiet', 'main']);
    await git(
      root,
      [
        '-c',
        `user.name=${GRACE.name}`,
        '-c',
        `user.email=${GRACE.email}`,
        'merge',
        '--quiet',
        '--no-ff',
        '-m',
        'Merge rate limits',
        'rate-limits',
      ],
      { GIT_AUTHOR_DATE: when(20 * HOUR), GIT_COMMITTER_DATE: when(20 * HOUR) },
    );
    await commit(root, ADA_OTHER_MACHINE, 'Log the ceiling that was hit', 3 * HOUR);
    await git(root, ['push', '--quiet', 'origin', 'main']);
  }

  // 2. Uncommitted work, and three commits that exist nowhere else - the two
  //    states the row's second line is for.
  {
    const root = path.join(target, 'atlas-web');
    await init(root);
    await commit(root, ADA, 'Stand up the dashboard shell', 16 * DAY);
    await origin(originsDir, 'atlas-web', root);
    await commit(root, ADA, 'Group the board by owner', 4 * DAY);
    await commit(root, GRACE, 'Keep the filter when the list reloads', 26 * HOUR);
    await commit(root, ADA_OTHER_MACHINE, 'Narrow the column on a small screen', 40 * 60);

    // Modified, staged and untracked at once, so the row shows all three marks.
    await fs.appendFile(path.join(root, 'src', 'main.txt'), 'work in progress\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'staged.txt'), 'ready\n', 'utf8');
    await git(root, ['add', 'src/staged.txt']);
    await fs.writeFile(path.join(root, 'notes.md'), '# scratch\n', 'utf8');
  }

  // 3. Behind: the remote moved and this has not caught up.
  {
    const root = path.join(target, 'billing-service');
    await init(root);
    await commit(root, ALAN, 'Post invoices to the ledger', 25 * DAY);
    const bare = await origin(originsDir, 'billing-service', root);
    await advanceOrigin(bare, scratch, GRACE, ['Round to the currency', 'Retry a failed post'], 5 * DAY);
    await git(root, ['fetch', '--quiet', 'origin']);
  }

  // 4. Diverged, which is the state the board exists to catch early.
  {
    const root = path.join(target, 'notify-worker');
    await init(root);
    await commit(root, GRACE, 'Send on the queue, not on the request', 19 * DAY);
    const bare = await origin(originsDir, 'notify-worker', root);
    await advanceOrigin(bare, scratch, ALAN, ['Back off on a 429', 'Drop the duplicate send'], 6 * DAY);
    await git(root, ['fetch', '--quiet', 'origin']);
    await commit(root, ADA, 'Batch the digest mail', 3 * DAY);
  }

  // 5. A branch with no upstream at all - not behind, not ahead, unpublished.
  {
    const root = path.join(target, 'design-tokens');
    await init(root);
    await commit(root, ADA, 'First pass at the palette', 12 * DAY);
    await commit(root, ADA, 'Name the spacing scale', 7 * DAY);
  }

  // 6. Detached HEAD, one level down, so the walk is visibly not stopping at
  //    the top of the directory.
  {
    const root = path.join(target, 'spikes', 'graph-lanes');
    await init(root);
    await commit(root, ALAN, 'Try the lane assignment', 11 * DAY);
    await commit(root, ALAN, 'Draw the first parent straight', 10 * DAY);
    const previous = await git(root, ['rev-parse', 'HEAD~1']);
    await git(root, ['checkout', '--quiet', previous]);
  }

  // 7. Two levels down, and quiet for weeks: the age column needs a spread or
  //    every row reads the same.
  {
    const root = path.join(target, 'vendor', 'legacy', 'import-tool');
    await init(root);
    await commit(root, GRACE, 'Import the old format once', 26 * DAY);
    await origin(originsDir, 'import-tool', root);
  }

  // 8. Nothing committed yet. A row that says so beats a row that is missing.
  {
    const root = path.join(target, 'docs-site');
    await init(root);
    await fs.writeFile(path.join(root, 'README.md'), '# Docs\n', 'utf8');
  }

  // 9. A linked worktree, so the row's kind marker has something to mark. It is
  //    a `.git` file rather than a directory, which is classified from the
  //    filesystem before anything is spawned.
  {
    const root = path.join(target, 'tooling');
    await init(root);
    await commit(root, ADA, 'Collect the release scripts', 15 * DAY);
    await commit(root, GRACE, 'Check the tag before publishing', 8 * DAY);
    await origin(originsDir, 'tooling', root);
    await git(root, ['branch', '--quiet', 'hotfix']);
    await git(root, ['worktree', 'add', '--quiet', path.join(target, 'tooling-hotfix'), 'hotfix']);
    await commit(path.join(target, 'tooling-hotfix'), ALAN, 'Pin the signing key', 5 * HOUR);
  }

  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const positional = process.argv[2];
const target =
  positional !== undefined && !positional.startsWith('--')
    ? path.resolve(positional)
    : path.resolve(here, '..', '..', 'multirepo-ledger-demo');
const originsDir = `${target}-origins`;
const force = process.argv.includes('--force');

const exists = await fs
  .stat(target)
  .then(() => true)
  .catch(() => false);

if (exists && !force) {
  console.error(`${target} already exists. Pass --force to replace it.`);
  process.exit(1);
}
if (exists) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
await fs.rm(originsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

console.log(`Building the demo workspace in ${target}`);
await fs.mkdir(target, { recursive: true });
await fs.mkdir(originsDir, { recursive: true });
await build(target, originsDir);

console.log(`Done. The remotes are bare repositories in ${originsDir}, outside the walk.`);
console.log('');
console.log('To take the screenshot, point the extension at it:');
console.log(`  "multirepoLedger.additionalRoots": ["${target.replace(/\\/g, '\\\\')}"]`);
