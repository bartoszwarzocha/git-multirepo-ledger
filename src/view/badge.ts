/**
 * The number on the Activity Bar icon.
 *
 * The badge is the one thing this extension says while nobody is looking at it,
 * so it has to be worth interrupting for. The rule the sibling project settled
 * on holds here: a badge is only useful if one click shows exactly the things it
 * counted - which is why every mode below is also a filter chip on the board.
 *
 * Nothing here imports `vscode`, so what the number means is decided in one
 * unit-tested place rather than at the call site that happens to set it.
 */

import type { Tally } from '../model/types.ts';

/**
 * What the badge counts.
 *
 * A preference, not a measurement: which of these matters depends on how
 * somebody works. Somebody who pushes at the end of every day wants `unpushed`;
 * somebody minding a fleet of checkouts wants `attention`. There is no answer
 * that is right for both, so this is a setting with a default rather than a
 * constant.
 */
export type BadgeMode = 'unpushed' | 'dirty' | 'behind' | 'attention' | 'unreadable' | 'off';

export const BADGE_MODES: readonly BadgeMode[] = [
  'unpushed',
  'dirty',
  'behind',
  'attention',
  'unreadable',
  'off',
];

export const DEFAULT_BADGE_MODE: BadgeMode = 'unpushed';

export interface Badge {
  readonly value: number;
  readonly tooltip: string;
}

function repositories(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/**
 * The badge, or nothing.
 *
 * Nothing when the count is zero, which is deliberate and is why this returns
 * `undefined` rather than a badge reading `0`: the badge exists to say there is
 * something here, and a zero on the icon is a permanent mark that says nothing
 * while still catching the eye every time.
 *
 * Nothing, too, while the board is empty - a fresh window has read no repository
 * yet, and a badge during the first pass would be counting an answer that is
 * still arriving. `dirty` deserves the same care for a different reason: the
 * working-tree read ships behind a setting, and with it off every repository
 * counts as not dirty. That is a count nobody established, so it must not become
 * a confident zero on an icon - but since zero draws no badge at all, silence is
 * what the reader gets, which is the correct answer.
 */
export function badgeFor(tally: Tally, mode: BadgeMode): Badge | undefined {
  if (mode === 'off' || tally.total === 0) {
    return undefined;
  }

  const value = tally[mode];
  if (value === 0) {
    return undefined;
  }

  switch (mode) {
    case 'unpushed':
      return {
        value,
        tooltip: `${repositories(value)} with commits that exist only on this machine`,
      };
    case 'dirty':
      return { value, tooltip: `${repositories(value)} with uncommitted changes` };
    case 'behind':
      return { value, tooltip: `${repositories(value)} behind their upstream` };
    case 'attention':
      return { value, tooltip: `${repositories(value)} needing a decision` };
    case 'unreadable':
      return { value, tooltip: `${repositories(value)} git would not answer for` };
  }
}
