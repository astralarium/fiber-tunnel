import {
  type Fiber,
  type FiberRootLike,
  getFiberRoot,
  sameFiber,
} from "./fiber";

/** One level of a position path: a fiber within one React root. */
export interface FiberStep {
  /** Anchor or In fiber; either generation. */
  fiber: Fiber;
  /** Root its rank path is relative to. */
  root: FiberRootLike;
}

/** Sort key: per path level, each chain fiber's rank among its parent's
 * current children, root down. */
export type PathKey = (readonly number[])[];

/** Sibling count past which a parent's child ranks are mapped. */
const wideParent = 32;

/** Per-sort child ranks of wide parents, by either child generation. */
export type RankCache = Map<Fiber, Map<Fiber, [current: Fiber, rank: number]>>;

/** Ranks of `fiber`'s chain below `root`'s current HostRoot, or null when
 * the chain leaves that tree. `return` from either generation yields the
 * logical chain; descent finds current generations. */
function levelKey(
  fiber: Fiber,
  root: FiberRootLike,
  cache: RankCache,
): number[] | null {
  const top = root.current;
  if (!top) return null;
  const chain: Fiber[] = [];
  for (let n: Fiber | null = fiber; n; n = n.return) chain.push(n);
  if (!sameFiber(chain.pop()!, top)) return null;
  const key = new Array<number>(chain.length);
  let parent = top;
  for (let i = chain.length - 1, k = 0; i >= 0; i--, k++) {
    const want = chain[i];
    const ranks = cache.get(parent);
    if (ranks) {
      const hit = ranks.get(want);
      if (!hit) return null;
      [parent, key[k]] = hit;
      continue;
    }
    let rank = 0;
    let c = parent.child;
    while (c && c !== want && c.alternate !== want) {
      c = c.sibling;
      if (++rank === wideParent) {
        const map: Map<Fiber, [Fiber, number]> = new Map();
        let r = 0;
        for (let s = parent.child; s; s = s.sibling, r++) {
          map.set(s, [s, r]);
          if (s.alternate) map.set(s.alternate, [s, r]);
        }
        cache.set(parent, map);
        const hit = map.get(want);
        if (!hit) return null;
        [c, rank] = hit;
        break;
      }
    }
    if (!c) return null;
    key[k] = rank;
    parent = c;
  }
  return key;
}

/** Key of a path; `below` extends its last level. Null when a level does
 * not resolve. */
export function pathKey(
  path: readonly FiberStep[],
  cache: RankCache,
  below?: readonly number[],
): PathKey | null {
  if (path.length === 0) return null;
  const key: PathKey = [];
  for (const step of path) {
    const level = levelKey(step.fiber, step.root, cache);
    if (!level) return null;
    key.push(level);
  }
  if (below) key[key.length - 1] = [...key[key.length - 1], ...below];
  return key;
}

function compareLevels(a: readonly number[], b: readonly number[]) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Orders keys level by level; an ancestor precedes its descendants. */
export function compareKeys(a: PathKey, b: PathKey) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareLevels(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** An entry to sort by key. */
export interface KeyedEntry<T> {
  item: T;
  key: PathKey | null;
  /** Tiebreak: earlier first. */
  order: number;
}

/** Sorts by key; null keys sort last; ties keep `order`. */
export function sortByKey<T>(entries: readonly KeyedEntry<T>[]): T[] {
  return [...entries]
    .sort((a, b) => {
      if (a.key && b.key) return compareKeys(a.key, b.key) || a.order - b.order;
      if (a.key) return -1;
      if (b.key) return 1;
      return a.order - b.order;
    })
    .map((entry) => entry.item);
}

/**
 * Sorts items by React tree position. Items must share a React root.
 * Unresolvable items keep input order, after the sorted ones.
 */
export function sortByFiberOrder<
  T extends {
    /** The item's React fiber, e.g. from its-fine's `useFiber`. */
    fiber?: object | null;
  },
>(items: readonly T[]): T[] {
  const cache: RankCache = new Map();
  return sortByKey(
    items.map((item, order) => {
      const fiber = item.fiber as Fiber | null | undefined;
      const root = fiber && getFiberRoot(fiber);
      const key = fiber && root ? pathKey([{ fiber, root }], cache) : null;
      return { item, key, order };
    }),
  );
}
