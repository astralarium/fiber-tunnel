import type { Component } from "react";

/** The React fiber fields this package reads. */
export interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
}

/** A mounted class component's own fiber. */
export function fiberOf(instance: Component): Fiber {
  return (instance as unknown as { _reactInternals: Fiber })._reactInternals;
}

/** FiberRoot: stateNode of a root's top fiber. */
export interface FiberRootLike {
  current?: Fiber;
}

/** The fiber's FiberRoot, or null if detached. Works for stale fibers:
 * both HostRoot generations share a stateNode. */
export function getFiberRoot(fiber: Fiber): FiberRootLike | null {
  let node = fiber;
  while (node.return) node = node.return;
  const root = node.stateNode as FiberRootLike | null;
  return root?.current ? root : null;
}

/** One level of a position path: a fiber within one React root. */
export interface FiberStep {
  /** Anchor or In fiber. */
  fiber: Fiber;
  /** Root its tree index is relative to. */
  root: FiberRootLike;
}

/** Maps targets to preorder indices in the live tree; alternates match,
 * as targets may be stale. */
function indexTargets(
  root: FiberRootLike,
  targets: Set<Fiber>,
  indices: Map<Fiber, number>,
) {
  const start = root.current;
  if (!start) return;
  let found = 0;
  let index = 0;
  // Iterative: long sibling chains overflow recursion.
  // Follows child/sibling only: stale return pointers dangle.
  const stack: Fiber[] = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const isTarget =
      targets.has(node) ||
      (node.alternate != null && targets.has(node.alternate));
    if (isTarget) {
      indices.set(node, index);
      if (node.alternate) indices.set(node.alternate, index);
      if (++found >= targets.size) return;
    }
    index++;
    if (node.sibling) stack.push(node.sibling);
    if (node.child) stack.push(node.child);
  }
}

/** Same fiber, or its other generation. */
export function sameFiber(a: Fiber, b: Fiber) {
  return a === b || a.alternate === b;
}

/** Leading levels every path shares; sorting can skip them. */
function sharedLevels(paths: readonly (readonly FiberStep[])[]) {
  let n = 0;
  for (;;) {
    const first = paths[0]?.[n];
    if (
      !first ||
      paths.some((p) => !p[n] || !sameFiber(p[n].fiber, first.fiber))
    )
      return n;
    n++;
  }
}

/** Orders keys level by level. */
function compareKeys(a: readonly number[], b: readonly number[]) {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Sorts by path, outermost level first, by tree index; levels compare
 * only within one root. Empty or unresolvable paths sort last; ties keep
 * `order`. */
export function sortByFiberPath<T>(
  entries: readonly {
    item: T;
    path: readonly FiberStep[];
    order: number;
  }[],
): T[] {
  if (entries.length <= 1) return entries.map((entry) => entry.item);
  // Shared levels need no walk of their outer root.
  const skip = sharedLevels(entries.map((entry) => entry.path));
  const paths = entries.map((entry) => entry.path.slice(skip));
  const targetsByRoot = new Map<FiberRootLike, Set<Fiber>>();
  for (const path of paths) {
    for (const { root, fiber } of path) {
      let targets = targetsByRoot.get(root);
      if (!targets) targetsByRoot.set(root, (targets = new Set()));
      targets.add(fiber);
    }
  }
  const indices = new Map<Fiber, number>();
  for (const [root, targets] of targetsByRoot) {
    indexTargets(root, targets, indices);
  }

  return entries
    .map((entry, i) => ({
      ...entry,
      key: paths[i].length
        ? paths[i].map((step) => indices.get(step.fiber) ?? Infinity)
        : [Infinity],
    }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.order - b.order)
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
  return sortByFiberPath(
    items.map((item, order) => {
      const fiber = item.fiber as Fiber | null | undefined;
      const root = fiber && getFiberRoot(fiber);
      const path = fiber && root ? [{ fiber, root }] : [];
      return { item, path, order };
    }),
  );
}
