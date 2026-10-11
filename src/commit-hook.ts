// React writes `root.current = finishedWork` once per commit, after the
// mutation phase and before layout effects. React offers no commit hook;
// redefining `current` as an accessor is this package's only write into
// React's objects.
import { isDevEnv } from "./env";
import { type Fiber, type FiberRootLike, Placement } from "./fiber";

/** Shared across fiber-tunnel copies on one root. */
const hookKey = Symbol.for("fiber-tunnel.commit-hook");
const protocolVersion = 1;

/** Runs inside React's commit, after mutation, before layout effects. */
export type CommitListener = (finishedWork: Fiber, root: FiberRootLike) => void;

/** The accessor one root carries, shared by every fiber-tunnel copy. */
export interface CommitHook {
  version: number;
  /** One per fiber-tunnel copy. */
  listeners: Set<CommitListener>;
  /** Last value React wrote. */
  last: Fiber | null;
  /** Installed setter; identifies the descriptor. */
  set: (value: Fiber) => void;
}

/** Observes commits of roots holding its items. */
export interface RootObserver {
  /** `moved`: a path fiber's kept children changed order. */
  onCommit(root: FiberRootLike, moved: boolean): void;
}

const observersByRoot = new WeakMap<FiberRootLike, Set<RootObserver>>();

/** Chain fibers of registered paths, both generations. Entries stay; a
 * stale one costs at most a re-sort. */
const pathFibers = new WeakSet<Fiber>();

/** Adds `fiber`'s chain to the path fibers. */
export function addPathFibers(fiber: Fiber) {
  for (let n: Fiber | null = fiber; n; n = n.return) {
    pathFibers.add(n);
    if (n.alternate) pathFibers.add(n.alternate);
  }
}

/** Removes one fiber, both generations, from the path fibers. Testing. */
export function forgetPathFiber(fiber: Fiber) {
  pathFibers.delete(fiber);
  if (fiber.alternate) pathFibers.delete(fiber.alternate);
}

export function observeRoot(root: FiberRootLike, observer: RootObserver) {
  let observers = observersByRoot.get(root);
  if (!observers) observersByRoot.set(root, (observers = new Set()));
  observers.add(observer);
}

export function unobserveRoot(root: FiberRootLike, observer: RootObserver) {
  observersByRoot.get(root)?.delete(observer);
}

/** This copy's listener: one walk per commit, for every observer. */
function onCommit(finishedWork: Fiber, root: FiberRootLike) {
  const observers = observersByRoot.get(root);
  if (!observers?.size) return;
  const moved = pathsMoved(finishedWork);
  for (const observer of observers) {
    try {
      observer.onCommit(root, moved);
    } catch (error) {
      reportListenerError(error);
    }
  }
}

function reportListenerError(error: unknown) {
  if (isDevEnv) console.error(error);
}

/**
 * Installs the shared commit hook on `root`, or joins it. Idempotent.
 * Null when `current` is missing or non-configurable, or install throws.
 * An accessor of another kind is chained: get and set delegate to it.
 */
export function installCommitHook(root: FiberRootLike): CommitHook | null {
  const target = root as Record<PropertyKey, unknown>;
  try {
    const existing = target[hookKey] as CommitHook | undefined;
    if (existing?.version === protocolVersion) {
      existing.listeners.add(onCommit);
      return existing;
    }
    const desc = Object.getOwnPropertyDescriptor(target, "current");
    if (!desc || !desc.configurable) return null;
    let foreign = desc.get || desc.set ? desc : null;
    let value = foreign ? undefined : (desc.value as Fiber);
    const hook: CommitHook = {
      version: protocolVersion,
      listeners: new Set([onCommit]),
      last: null,
      set(next: Fiber) {
        // A throw here would abort React's commit and leave the root
        // pending.
        if (foreign?.set) {
          try {
            foreign.set.call(target, next);
          } catch (error) {
            foreign = null;
            reportListenerError(error);
          }
        }
        if (!foreign) value = next;
        hook.last = next;
        for (const listener of hook.listeners) {
          try {
            listener(next, root);
          } catch (error) {
            reportListenerError(error);
          }
        }
      },
    };
    Object.defineProperty(target, "current", {
      configurable: true,
      enumerable: desc.enumerable ?? true,
      get: () => (foreign?.get ? foreign.get.call(target) : value) as Fiber,
      set: hook.set,
    });
    Object.defineProperty(target, hookKey, {
      configurable: true,
      writable: true,
      value: hook,
    });
    return hook;
  } catch {
    return null;
  }
}

/** True while `root`'s `current` is still `hook`'s accessor. */
export function hookIntact(root: FiberRootLike, hook: CommitHook) {
  return Object.getOwnPropertyDescriptor(root, "current")?.set === hook.set;
}

/** The hook installed on `root`, if any. */
export function commitHookOf(root: FiberRootLike): CommitHook | null {
  const hook = (root as Record<PropertyKey, unknown>)[hookKey] as
    CommitHook | undefined;
  return hook?.version === protocolVersion ? hook : null;
}

/** True when a path fiber's kept children changed relative order this
 * commit. Descends only where `subtreeFlags` carries Placement: React
 * clears it on placed fibers in the mutation phase; ancestors keep it. */
function pathsMoved(finishedWork: Fiber): boolean {
  const stack: Fiber[] = [finishedWork];
  while (stack.length) {
    const node = stack.pop()!;
    if (!(node.subtreeFlags & Placement)) continue;
    const onPath =
      pathFibers.has(node) ||
      (node.alternate !== null && pathFibers.has(node.alternate));
    if (onPath && childrenReordered(node)) return true;
    for (let c = node.child; c; c = c.sibling) {
      if (c.subtreeFlags & Placement) stack.push(c);
    }
  }
  return false;
}

/** React's `placeChild` test: a kept child whose old index falls below an
 * earlier kept child's moved. Inserts and deletions keep relative order. */
export function childrenReordered(parent: Fiber): boolean {
  let lastOld = -1;
  for (let c = parent.child; c; c = c.sibling) {
    const alt = c.alternate;
    if (!alt) continue;
    if (alt.index < lastOld) return true;
    lastOld = alt.index;
  }
  return false;
}
