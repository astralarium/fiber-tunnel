// React internals this package reads. Identical in React 19.2 and 19.3.
import type { Component } from "react";

/** The React fiber fields this package reads. */
export interface Fiber {
  tag: number;
  key: string | null;
  /** Context object on a context provider. */
  type: unknown;
  /** Position among siblings at the last reconciliation. */
  index: number;
  mode: number;
  flags: number;
  subtreeFlags: number;
  /** Render lanes, until the fiber begins. */
  lanes: number;
  memoizedState: unknown;
  pendingProps: unknown;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
}

/** FiberRoot: stateNode of a HostRoot fiber. */
export interface FiberRootLike {
  current?: Fiber;
  pendingLanes?: number;
  suspendedLanes?: number;
  pingedLanes?: number;
  warmLanes?: number;
}

export const ClassComponentTag = 1;
export const HostRootTag = 3;
export const ContextProviderTag = 10;
export const SuspenseTag = 13;
export const OffscreenTag = 22;

/** Fiber flag: inserted or moved this commit. */
export const Placement = 2;
/** Fiber flag: unwound after a throw this pass. */
export const Incomplete = 32768;

/** Fiber mode: under StrictMode. */
export const StrictLegacyMode = 8;

/** Sync, hydration, input-continuous, default, gesture. */
const UrgentLanes = 127;
export const TransitionLanes = 4194048;
const RetryLanes = 62914560;
export const OffscreenLane = 536870912;
const NonIdleLanes = 134217727;
const DeferredLane = 1073741824;

/** A class instance's fiber: the generation from its mount. */
export function fiberOf(instance: Component): Fiber {
  return (instance as unknown as { _reactInternals: Fiber })._reactInternals;
}

/** True for client fibers; server renderers set other objects. */
export function isFiber(value: unknown): value is Fiber {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Fiber).tag === "number" &&
    "return" in value &&
    "alternate" in value
  );
}

/** The generation of a class instance's fiber that is rendering now:
 * the one holding the rendering props. Null outside a client render. */
export function renderingFiberOf(instance: Component): Fiber | null {
  const fiber = fiberOf(instance);
  if (!isFiber(fiber)) return null;
  if (fiber.pendingProps === instance.props) return fiber;
  const alt = fiber.alternate;
  if (alt) return alt.pendingProps === instance.props ? alt : null;
  // Mounting: React copies props without `ref` and with defaults.
  return sameProps(fiber.pendingProps, instance.props) ? fiber : null;
}

/** Shallow match, ignoring `ref` and props a default filled. */
function sameProps(pending: unknown, props: object) {
  if (typeof pending !== "object" || pending === null) return false;
  const a = pending as Record<string, unknown>;
  const b = props as Record<string, unknown>;
  for (const key in a) {
    if (key === "ref" || a[key] === undefined) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** Same fiber, or its other generation. */
export function sameFiber(a: Fiber, b: Fiber) {
  return a === b || a.alternate === b;
}

/** True when `ancestor`, either generation, is on `fiber`'s `return`
 * chain. */
export function isAncestor(ancestor: Fiber, fiber: Fiber) {
  for (let node = fiber.return; node; node = node.return) {
    if (sameFiber(node, ancestor)) return true;
  }
  return false;
}

/** Top of a `return` chain. */
export function topOf(fiber: Fiber): Fiber {
  let node = fiber;
  while (node.return) node = node.return;
  return node;
}

/** True when the `return` chain reaches a HostRoot. Deletion nulls the
 * deleted subtree's top `return`, both generations. */
export function isAttached(fiber: Fiber) {
  return topOf(fiber).tag === HostRootTag;
}

/** The fiber's FiberRoot, or null if detached. Works for stale fibers:
 * both HostRoot generations share a stateNode. */
export function getFiberRoot(fiber: Fiber): FiberRootLike | null {
  const top = topOf(fiber);
  if (top.tag !== HostRootTag) return null;
  const root = top.stateNode as FiberRootLike | null;
  return root?.current ? root : null;
}

/** Lanes of the pass rendering `fiber`, read from a sibling created in this
 * pass: fiber creation stores the render lanes; `beginWork` zeroes them
 * once the sibling begins. Null without a fresh sibling. */
export function renderLanesOf(fiber: Fiber): number | null {
  const sibling = fiber.sibling;
  if (!sibling || sibling.alternate !== null) return null;
  if (sibling.return !== fiber.return) return null;
  return typeof sibling.lanes === "number" ? sibling.lanes : null;
}

/** Kind of render a lane set belongs to. */
export type RenderKind =
  "urgent" | "transition" | "retry" | "offscreen" | "other";

export function classifyLanes(lanes: number): RenderKind {
  if (lanes & UrgentLanes) return "urgent";
  if (lanes & TransitionLanes) return "transition";
  if (lanes & RetryLanes) return "retry";
  if (lanes & OffscreenLane) return "offscreen";
  return "other";
}

/** Lanes React's `getNextLanes` picks: the highest-priority pending group
 * neither suspended-unpinged nor warm. */
function nextLanesOf(root: Required<FiberRootLike>): number {
  const nonIdle = root.pendingLanes & NonIdleLanes;
  let next = nonIdle & ~root.suspendedLanes;
  if (!next) next = root.pingedLanes & nonIdle;
  if (!next) next = nonIdle & ~root.warmLanes;
  const sync = next & 42;
  if (sync) return sync;
  const lowest = next & -next;
  if (lowest & 262144) return next & 3932160;
  if (lowest & RetryLanes) return next & RetryLanes;
  if (lowest === DeferredLane) return 0;
  return lowest;
}

/** True when `root`'s reconciler renders Activity: React 19.0 roots keep
 * `finishedWork`, removed in 19.1. */
export function rendersActivity(root: FiberRootLike) {
  return !("finishedWork" in root);
}

/** Outcome of {@link internalsLookSane}. */
export type InternalsCheck = "sane" | "failed" | "inconclusive";

/** Checks the internals transitions read, for a class instance rendering
 * now with a fresh sibling. Lanes that disagree with the root's next lanes
 * are inconclusive: an urgent update or a hidden pass entangles others. */
export function internalsLookSane(instance: Component): InternalsCheck {
  try {
    const fiber = renderingFiberOf(instance);
    if (!fiber || fiber.tag !== ClassComponentTag) return "failed";
    const top = topOf(fiber);
    if (top.tag !== HostRootTag) return "failed";
    const root = top.stateNode as Required<FiberRootLike>;
    const fields = [
      root.pendingLanes,
      root.suspendedLanes,
      root.pingedLanes,
      root.warmLanes,
      fiber.flags,
      fiber.index,
    ];
    if (fields.some((n) => typeof n !== "number")) return "failed";
    const lanes = renderLanesOf(fiber);
    if (lanes === null || lanes === 0) return "failed";
    if ((lanes & root.pendingLanes) === 0) return "failed";
    if ((lanes & root.pendingLanes) !== lanes) return "inconclusive";
    return classifyLanes(lanes) === classifyLanes(nextLanesOf(root))
      ? "sane"
      : "inconclusive";
  } catch {
    return "failed";
  }
}

/** Position of a mounting fiber that holds across restarted passes: its
 * nearest committed ancestor and the index/key path below it. */
export interface MountPosition {
  /** Nearest ancestor with a committed generation. */
  anchor: Fiber;
  /** `index` or `index:key` per level, anchor's child first. */
  path: string[];
}

export function mountPositionOf(fiber: Fiber): MountPosition {
  const path: string[] = [];
  let node = fiber;
  while (node.alternate === null && node.return) {
    path.push(stepOf(node));
    node = node.return;
  }
  return { anchor: node, path: path.reverse() };
}

/** The committed fiber at `position`: undefined while a level is missing. */
export function committedAt(position: MountPosition): Fiber | undefined {
  let node = currentOf(position.anchor);
  for (const step of position.path) {
    let child = node?.child ?? null;
    while (child && stepOf(child) !== step) child = child.sibling;
    node = child;
  }
  return node ?? undefined;
}

function stepOf(fiber: Fiber) {
  return fiber.key === null ? `${fiber.index}` : `${fiber.index}:${fiber.key}`;
}

/** The generation of `fiber` reachable from its root's `current`. */
export function currentOf(fiber: Fiber): Fiber | null {
  const chain: Fiber[] = [];
  for (let n: Fiber | null = fiber; n; n = n.return) chain.push(n);
  const top = chain[chain.length - 1];
  if (top.tag !== HostRootTag) return null;
  let node = (top.stateNode as FiberRootLike).current ?? null;
  for (let i = chain.length - 2; node && i >= 0; i--) {
    let c: Fiber | null = node.child;
    while (c && c !== chain[i] && c.alternate !== chain[i]) c = c.sibling;
    node = c;
  }
  return node;
}

/** True when every fiber rendered this pass before `gate` under `top`
 * completed: nothing unwound and no Suspense boundary newly showing its
 * fallback. Bailed-out children keep a stale `return` and count as
 * complete. Unknown shapes count as complete. */
export function priorWorkCompleted(gate: Fiber, top: Fiber): boolean {
  try {
    for (let node = gate; node !== top && node.return; node = node.return) {
      const parent = node.return;
      for (let s = parent.child; s && s !== node; s = s.sibling) {
        if (!subtreeCompleted(s, parent)) return false;
      }
    }
  } catch {
    // Fail open.
  }
  return true;
}

/** Component types whose subtrees count as completed. */
const completedTypes = new WeakSet<object>();

/** Marks a component whose subtree never holds readiness. */
export function markCompleted(type: object) {
  completedTypes.add(type);
}

function subtreeCompleted(fiber: Fiber, parent: Fiber): boolean {
  if (fiber.return !== parent) return true;
  if (typeof fiber.type === "function" && completedTypes.has(fiber.type)) {
    return true;
  }
  if (typeof fiber.flags === "number" && fiber.flags & Incomplete) return false;
  if (fiber.tag === SuspenseTag && fiber.memoizedState != null) {
    // Newly in fallback: the committed generation showed content.
    const alt = fiber.alternate;
    return alt !== null && alt.memoizedState != null;
  }
  if (fiber.tag === OffscreenTag && fiber.memoizedState != null) return true;
  for (let c = fiber.child; c; c = c.sibling) {
    if (!subtreeCompleted(c, fiber)) return false;
  }
  return true;
}

/** Nearest ancestor with `tag`. */
export function ancestorWithTag(fiber: Fiber, tag: number): Fiber | null {
  let node = fiber.return;
  while (node && node.tag !== tag) node = node.return;
  return node;
}
