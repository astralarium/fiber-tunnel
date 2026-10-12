// Render-phase writes are deliberate: probes are idempotent per position.

// Default import: production React lacks captureOwnerStack; webpack
// rejects the missing named export.
import React, {
  Component,
  type ComponentType,
  type Context,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  StrictMode,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  type Canary,
  CanaryView,
  createCanary,
  createMicrotaskCheck,
  Group,
  Hideable,
  ItemView,
  LaneReader,
  type MicrotaskCheck,
  MicrotaskCheckView,
  MountGate,
  type StatusOwner,
  StatusView,
  type TunnelCore,
} from "./bridge-views";
import {
  addPathFibers,
  commitHookOf,
  hookIntact,
  installCommitHook,
  observeRoot,
  type RootObserver,
  unobserveRoot,
} from "./commit-hook";
import { isDevEnv } from "./env";
import {
  classifyLanes,
  committedAt,
  type Fiber,
  fiberOf,
  type FiberRootLike,
  getFiberRoot,
  HostRootTag,
  internalsLookSane,
  isAttached,
  mountPositionOf,
  OffscreenTag,
  Placement,
  renderingFiberOf,
  renderLanesOf,
  rendersActivity,
  sameFiber,
  SuspenseTag,
  topOf,
} from "./fiber";
import {
  FiberAnchorContext,
  type FiberAnchorValue,
} from "./fiber-anchor-context";
import { type Item, type ItemStatus, type Probe, readyStatus } from "./item";
import { createSignal } from "./signal";
import {
  ackWindowMs,
  type Capture,
  captureAbove,
  emptyCapture,
  expiryMs,
  join,
  leave,
  type Member,
  type Source,
  SourceReader,
  watchdogMs,
} from "./sources";
import { type FiberStep, pathKey, type RankCache, sortByKey } from "./util";

/** Options of {@link fiberTunnel}. */
export interface FiberTunnelOptions {
  /** Ins carry their ancestor context and StrictMode to the Out;
   * content suspensions and transitions surface at the In.
   * An urgent suspend commits the In's siblings once before the
   * fallback shows. */
  bridge?: boolean;
  /** Bridged: where content errors surface. `"in"` (default) rethrows at
   * the In; `"out"` lets them rise from the Out. Unbridged: always the
   * Out. */
  errors?: "in" | "out";
}

/** Props of {@link FiberTunnel.In}. */
export interface FiberTunnelInProps {
  /** Rendered at the Out. */
  children: ReactNode;
}

/** A tunnel created by {@link fiberTunnel}. */
export interface FiberTunnel {
  /** Sends its children to the Out. Content appears one commit after
   * mount. */
  In: ComponentType<FiberTunnelInProps>;
  /** Renders the content. Mount one per tunnel: each Out renders a copy.
   * Mounted together with Ins, paints empty once. */
  Out: () => ReactNode;
  /** Re-reads order from the fiber tree. Needed only while the commit
   * hook is off; dev warns when it falls back. */
  refresh: () => void;
}

/** Store snapshot; a new object per emit. */
interface Snapshot {
  generation: number;
}

// Stable server snapshot for useSyncExternalStore.
const serverSnapshot: Snapshot = { generation: -1 };
const getServerSnapshot = () => serverSnapshot;

/** Dev error: extra Out mounted. */
const multipleOutsError = "Multiple tunnel Outs mounted; each renders a copy.";

/** Dev warning: Ins' paths diverge across roots. */
const multipleRootsWarning =
  "Tunnel Ins span React roots in undefined order. Wrap nested React roots " +
  "in FiberAnchor; nested roots must bridge context.";

/** Dev warning prefix: the tunnel sorts on every change. */
const hookFallbackWarning =
  "fiber-tunnel: move detection is off; the tunnel sorts on every change " +
  "and refresh() re-reads moves. Cause: ";

/** Dev warning prefix: transitions publish after commit. */
const transitionFallbackWarning =
  "fiber-tunnel: transitions publish after commit and show fallbacks. Cause: ";

const missedProbeAckWarning =
  "fiber-tunnel: the Out did not render a transition mount's content " +
  `within ${ackWindowMs} ms; the mount commits unverified.`;

const probeWatchdogWarning =
  "fiber-tunnel: a transition mount's content did not finish at the Out " +
  `within ${watchdogMs} ms; the mount commits unverified.`;

const probeExpiryWarning =
  "fiber-tunnel: a transition mount did not commit within " +
  `${expiryMs} ms; its content leaves the Out.`;

/** Readiness re-arms per probe; restarted passes re-create children. */
const maxRearms = 2;

/** Dev cross-check interval per tunnel. */
const crossCheckMs = 100;

/** Same FiberAnchorContext value type, as a bridged-context skip. */
const anchorContext = FiberAnchorContext as Context<unknown>;

/** True when a Suspense boundary above already shows its fallback. */
function insideFallback(fiber: Fiber) {
  for (let node = fiber.return; node; node = node.return) {
    if (node.tag === SuspenseTag && node.alternate?.memoizedState != null) {
      return true;
    }
  }
  return false;
}

/** True when a hidden Offscreen above defers this fiber's commit. */
function insideHidden(fiber: Fiber) {
  for (let node = fiber.return; node; node = node.return) {
    if (node.tag === OffscreenTag && node.memoizedState != null) return true;
  }
  return false;
}

/** True when two nodes render alike: same element types, keys, and
 * shallow props, children compared recursively. */
function sameNode(a: ReactNode, b: ReactNode): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((child, i) => sameNode(child, b[i]))
    );
  }
  if (!isValidElement(a) || !isValidElement(b)) return false;
  if (a.type !== b.type || a.key !== b.key) return false;
  const pa = a.props as Record<string, unknown>;
  const pb = b.props as Record<string, unknown>;
  const keys = Object.keys(pa);
  if (keys.length !== Object.keys(pb).length) return false;
  return keys.every((key) =>
    key === "children"
      ? sameNode(pa.children as ReactNode, pb.children as ReactNode)
      : Object.is(pa[key], pb[key]),
  );
}

/** Work-in-progress ranks from `anchor`'s child down to `fiber`. */
function ranksBelow(fiber: Fiber, anchor: Fiber): number[] {
  const ranks: number[] = [];
  for (let n: Fiber | null = fiber; n && n !== anchor; n = n.return) {
    let rank = 0;
    for (
      let s: Fiber | null = n.return?.child ?? null;
      s && s !== n;
      s = s.sibling
    ) {
      rank++;
    }
    ranks.push(rank);
  }
  return ranks.reverse();
}

/** Creates a tunnel: content from many Ins renders at one Out, in tree order. */
export function fiberTunnel(options: FiberTunnelOptions = {}): FiberTunnel {
  const bridge = options.bridge ?? false;
  const forwardErrors = (options.errors ?? "in") === "in";
  /** By React key at the Out. */
  const items = new Map<string, Item>();
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = { generation: 0 };
  // useId is unique per root; Ins span roots.
  let nextId = 0;

  /** Bumped by changes that can reorder content. */
  let generation = 0;
  let sortCache: { generation: number; keys: string[] } | null = null;
  let emitQueued = false;

  // Commit hook: off sorts on every emit.
  let hookOn = true;
  const observedRoots = new Set<FiberRootLike>();
  const checkedRoots = new WeakSet<FiberRootLike>();
  let afterCommitQueued = false;
  let lastCrossCheck = -Infinity;

  // Transitions (bridged).
  let transitionFallback: string | null = null;
  let internalsChecked = false;
  let microtaskOk: boolean | null = null;
  let canaryOk: boolean | null = null;
  let visibleOuts = 0;
  /** Roots of visible Outs; a mount in one of them publishes after
   * commit. */
  const outRoots = new Map<FiberRootLike, number>();
  /** Probes by committed ancestor (both generations), by position. */
  const probesByAnchor = new WeakMap<Fiber, Map<string, Probe>>();
  const probes = new Set<Probe>();

  // Dev only.
  let mountedOuts = 0;
  let warnedRoots = false;

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  const getSnapshot = () => snapshot;

  function emit() {
    if (!hookOn) {
      generation++;
      afterCommit();
    }
    snapshot = { generation };
    for (const listener of listeners) listener();
  }

  /** Emits in a microtask: listeners never render mid-commit. */
  function queueEmit() {
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      emit();
    });
  }

  // Skip anchors in an already-listed root: the inner position is finer.
  function pathOf(fiber: Fiber, anchor: FiberAnchorValue | null) {
    const path: FiberStep[] = [];
    let root = getFiberRoot(fiber);
    if (root) path.push({ fiber, root });
    for (let a = anchor; a; a = a.parent) {
      const anchorRoot = getFiberRoot(a.fiber);
      if (!anchorRoot || anchorRoot === root) continue;
      path.unshift({ fiber: a.fiber, root: anchorRoot });
      root = anchorRoot;
    }
    return path;
  }

  /** Watches the path's roots and fibers for moves. */
  function trackPath(path: readonly FiberStep[]) {
    for (const step of path) {
      addPathFibers(step.fiber);
      if (!observedRoots.has(step.root) && hookOn) {
        observedRoots.add(step.root);
        observeRoot(step.root, observer);
      }
    }
  }

  // Paths that first differ in different roots have no defined order.
  function warnIfRootsMix(path: readonly FiberStep[]) {
    for (const item of items.values()) {
      for (let i = 0; i < path.length && i < item.path.length; i++) {
        if (sameFiber(path[i].fiber, item.path[i].fiber)) continue;
        if (path[i].root === item.path[i].root) break;
        warnedRoots = true;
        console.warn(
          multipleRootsWarning + (React.captureOwnerStack?.() ?? ""),
        );
        return;
      }
    }
  }

  function remove(item: Item) {
    if (items.get(item.key) === item) items.delete(item.key);
  }

  const observer: RootObserver = {
    onCommit(_root, moved) {
      if (!hookOn) return;
      if (moved) {
        generation++;
        queueEmit();
      }
      if (afterCommitQueued) return;
      afterCommitQueued = true;
      queueMicrotask(() => {
        afterCommitQueued = false;
        if (afterCommit()) queueEmit();
        if (isDevEnv) crossCheck();
      });
    },
  };

  /** Removes hidden items whose In left the tree and probes whose mount
   * pass will not commit. True when content changed. */
  function afterCommit() {
    let changed = false;
    for (const item of items.values()) {
      if (!item.hidden || item.probe) continue;
      const fiber = item.path[item.path.length - 1]?.fiber;
      if (fiber && isAttached(fiber)) continue;
      remove(item);
      changed = true;
    }
    for (const probe of probes) {
      const { anchor } = probe.position;
      if (!isAttached(anchor)) {
        dropProbe(probe, false);
        changed = true;
        continue;
      }
      // A commit replaced the position's occupant without the In.
      const committed = committedAt(probe.position);
      if (
        committed &&
        !(probe.occupant && sameFiber(committed, probe.occupant)) &&
        !(committed.stateNode instanceof In)
      ) {
        dropProbe(probe, false);
        changed = true;
      }
    }
    return changed;
  }

  /** Dev: a hooked commit that moved content without a re-sort. */
  function crossCheck() {
    if (!hookOn || !sortCache || sortCache.generation !== generation) return;
    const now = Date.now();
    if (now - lastCrossCheck < crossCheckMs) return;
    lastCrossCheck = now;
    const cached = sortCache.keys.filter((key) => items.has(key));
    const fresh = sortKeys();
    if (cached.some((key, i) => key !== fresh[i])) {
      hookFallback("the cross-check found a move the commit hook missed");
    }
  }

  /** Turns move detection off: sort on every emit. */
  function hookFallback(cause: string) {
    if (!hookOn) return;
    hookOn = false;
    for (const root of observedRoots) unobserveRoot(root, observer);
    observedRoots.clear();
    if (isDevEnv) console.warn(hookFallbackWarning + cause);
    queueEmit();
  }

  /** Checks the commit hook on each path root at an In mount. */
  function checkHooks(
    fiber: Fiber,
    path: readonly FiberStep[],
    placed: boolean,
  ) {
    if (!hookOn) return;
    for (const { root } of path) {
      const hook = commitHookOf(root);
      if (!hook) return hookFallback("the commit hook did not install");
      if (!hookIntact(root, hook)) {
        return hookFallback("another accessor replaced the commit hook");
      }
    }
    const top = topOf(fiber);
    const root = top.stateNode as FiberRootLike;
    if (checkedRoots.has(root) || !placed) return;
    checkedRoots.add(root);
    const hook = commitHookOf(root)!;
    if (hook.last !== top || !(top.subtreeFlags & Placement)) {
      hookFallback("the commit hook failed its sanity check");
    }
  }

  function sortKeys(): string[] {
    const cache: RankCache = new Map();
    return sortByKey(
      [...items.values()].map((item) => ({
        item: item.key,
        key: pathKey(item.path, cache, item.below ?? undefined),
        // A probe precedes a committed item with an equal key.
        order: item.probe ? -1 : item.id,
      })),
    );
  }

  /** Items in tree order, sorted once per generation. */
  function sortedItems(): Item[] {
    if (!hookOn || !sortCache || sortCache.generation !== generation) {
      sortCache = { generation, keys: sortKeys() };
    }
    const sorted: Item[] = [];
    for (const key of sortCache.keys) {
      const item = items.get(key);
      if (item) sorted.push(item);
    }
    return sorted;
  }

  function refresh() {
    generation++;
    if (hookOn) afterCommit();
    emit();
  }

  // Transitions.

  function transitionsOn() {
    return (
      bridge &&
      transitionFallback === null &&
      microtaskOk === true &&
      canaryOk === true &&
      visibleOuts > 0
    );
  }

  /** Switches the tunnel to publish-after-commit. */
  function fallBack(cause: string) {
    if (transitionFallback !== null) return;
    transitionFallback = cause;
    if (isDevEnv) console.warn(transitionFallbackWarning + cause);
    releaseProbes();
  }

  /** Structural release: nothing waits for an absent Out. */
  function releaseProbes() {
    for (const probe of probes) {
      if (probe.timer !== null) clearTimeout(probe.timer);
      probe.timer = null;
      probe.ready.resolve();
    }
  }

  function armAck(probe: Probe) {
    if (probe.timer !== null) clearTimeout(probe.timer);
    probe.acked = false;
    probe.timer = setTimeout(() => {
      if (probe.acked || probe.ready.done) return;
      if (isDevEnv) console.warn(missedProbeAckWarning + probe.stack);
      probe.ready.resolve();
    }, ackWindowMs);
  }

  function armExpiry(probe: Probe) {
    if (probe.expiry !== null) clearTimeout(probe.expiry);
    probe.expiry = setTimeout(() => {
      if (isDevEnv) console.warn(probeExpiryWarning + probe.stack);
      dropProbe(probe, true);
    }, expiryMs);
  }

  function clearProbeTimers(probe: Probe) {
    if (probe.timer !== null) clearTimeout(probe.timer);
    if (probe.expiry !== null) clearTimeout(probe.expiry);
    probe.timer = probe.expiry = null;
  }

  function forgetProbe(probe: Probe) {
    clearProbeTimers(probe);
    probes.delete(probe);
    const { anchor } = probe.position;
    const byPath =
      probesByAnchor.get(anchor) ??
      (anchor.alternate ? probesByAnchor.get(anchor.alternate) : undefined);
    if (byPath?.get(probe.positionKey) === probe) {
      byPath.delete(probe.positionKey);
    }
  }

  /** Removes a probe and resolves its signals. */
  function dropProbe(probe: Probe, notify: boolean) {
    if (probe.dropped) return;
    probe.dropped = true;
    forgetProbe(probe);
    const item = items.get(probe.itemKey);
    if (item?.probe === probe) remove(item);
    probe.ready.resolve();
    probe.release.resolve();
    if (notify) emit();
  }

  const core: TunnelCore = {
    transitionsOn,
    ackProbe(probe) {
      if (probe.acked || probe.ready.done) return;
      probe.acked = true;
      if (probe.timer !== null) clearTimeout(probe.timer);
      probe.timer = setTimeout(() => {
        if (probe.ready.done) return;
        if (isDevEnv) console.warn(probeWatchdogWarning + probe.stack);
        probe.ready.resolve();
      }, watchdogMs);
    },
    probeReady(probe) {
      if (probe.timer !== null) clearTimeout(probe.timer);
      probe.timer = null;
      probe.ready.resolve();
    },
  };

  /** Registers or updates the probe at `fiber`'s position. */
  function probeFor(owner: In, fiber: Fiber): Probe {
    const position = mountPositionOf(fiber);
    const positionKey = position.path.join("/");
    const { anchor } = position;
    let byPath =
      probesByAnchor.get(anchor) ??
      (anchor.alternate ? probesByAnchor.get(anchor.alternate) : undefined);
    if (!byPath) {
      byPath = new Map();
      probesByAnchor.set(anchor, byPath);
      if (anchor.alternate) probesByAnchor.set(anchor.alternate, byPath);
    }
    const path = pathOf(anchor, owner.context);
    const below = ranksBelow(fiber, anchor);
    const { children } = owner.props;
    const existing = byPath.get(positionKey);
    if (existing) {
      const item = items.get(existing.itemKey)!;
      item.path = path;
      item.below = below;
      item.capture = owner.capture;
      // Restarted passes re-create equal children.
      if (!sameNode(item.children, children)) {
        item.children = children;
        item.element = null;
        if (existing.ready.done && existing.rearms < maxRearms) {
          existing.rearms++;
          existing.ready = createSignal();
          armAck(existing);
        }
        queueEmit();
      }
      armExpiry(existing);
      return existing;
    }
    const id = nextId++;
    const probe: Probe = {
      ready: createSignal(),
      release: createSignal(),
      position,
      positionKey,
      itemKey: `p${id}`,
      occupant: committedAt(position),
      acked: false,
      timer: null,
      expiry: null,
      rearms: 0,
      dropped: false,
      stack: isDevEnv ? (React.captureOwnerStack?.() ?? "") : "",
    };
    byPath.set(positionKey, probe);
    probes.add(probe);
    items.set(probe.itemKey, {
      id,
      key: probe.itemKey,
      path,
      below,
      children,
      hidden: false,
      capture: owner.capture,
      probe,
      status: readyStatus,
      listeners: owner.statusListeners,
      element: null,
    });
    trackPath(path);
    generation++;
    armAck(probe);
    armExpiry(probe);
    queueEmit();
    return probe;
  }

  // Class: reads its own fiber. Lifecycles run at layout timing,
  // StrictMode replays and hides included.
  class In
    extends Component<FiberTunnelInProps>
    implements Member, StatusOwner
  {
    static contextType = FiberAnchorContext;
    declare context: FiberAnchorValue | null;
    item: Item | null = null;
    anchor: FiberAnchorValue | null = null;
    capture: Capture = emptyCapture;
    readable: ReadonlySet<Source> = emptyCapture.readable;
    root: FiberRootLike | null = null;
    /** Rendered outside a hidden Offscreen: mounts at its placement. */
    placed = true;
    committed = false;
    /** Between componentDidMount and componentWillUnmount. */
    mounted = false;
    /** Lanes of the mount pass. */
    lanes: number | null = null;
    probe: Probe | null = null;
    statusListeners = new Set<() => void>();

    rerender = () => this.forceUpdate();

    subscribeStatus = (listener: () => void) => {
      this.statusListeners.add(listener);
      return () => void this.statusListeners.delete(listener);
    };

    getStatus = (): ItemStatus => this.item?.status ?? readyStatus;

    /** First renders: install the commit hook, capture providers. */
    prepare() {
      const fiber = renderingFiberOf(this);
      if (!fiber) return;
      const top = topOf(fiber);
      if (top.tag !== HostRootTag) return;
      this.root = top.stateNode as FiberRootLike;
      installCommitHook(this.root);
      this.placed = !insideHidden(fiber);
      if (bridge && this.capture === emptyCapture) {
        this.capture = captureAbove(fiber, anchorContext);
        this.readable = this.capture.readable;
      }
    }

    readLanes = (reader: Component) => {
      const fiber = renderingFiberOf(reader);
      this.lanes = fiber ? renderLanesOf(fiber) : null;
      if (internalsChecked || !fiber) return;
      const check = internalsLookSane(reader);
      if (check === "failed") fallBack("the internals check failed");
      // Inconclusive: this pass takes the urgent path; the next mount
      // checks again.
      if (check === "inconclusive") this.lanes = null;
      else internalsChecked = true;
    };

    /** This mount pass's probe; null on the urgent path. */
    mountProbe = (): Probe | null => {
      if (this.committed || this.lanes === null) return null;
      if (classifyLanes(this.lanes) !== "transition") return null;
      if (!transitionsOn() || (this.root && outRoots.has(this.root))) {
        return null;
      }
      const fiber = renderingFiberOf(this);
      if (!fiber || insideFallback(fiber)) return null;
      this.probe = probeFor(this, fiber);
      return this.probe;
    };

    register() {
      this.anchor = this.context;
      const fiber = fiberOf(this);
      const path = pathOf(fiber, this.anchor);
      if (isDevEnv && !warnedRoots) warnIfRootsMix(path);
      const probe = this.probe;
      const claimed =
        probe && !probe.dropped ? items.get(probe.itemKey) : undefined;
      if (probe && claimed) {
        forgetProbe(probe);
        claimed.probe = null;
        claimed.path = path;
        claimed.below = null;
        claimed.children = this.props.children;
        claimed.capture = this.capture;
        claimed.listeners = this.statusListeners;
        claimed.element = null;
        this.item = claimed;
        probe.release.resolve();
      } else {
        const id = nextId++;
        this.item = {
          id,
          key: `i${id}`,
          path,
          below: null,
          children: this.props.children,
          hidden: false,
          capture: this.capture,
          probe: null,
          status: readyStatus,
          listeners: this.statusListeners,
          element: null,
        };
        items.set(this.item.key, this.item);
      }
      this.probe = null;
      trackPath(path);
      checkHooks(fiber, path, this.placed);
      generation++;
      emit();
    }

    /** Hides or removes the item once its forwarded status settles. */
    settleHidden = () => {
      const item = this.item;
      if (this.mounted || !item || item.status.kind !== "ready") return;
      this.statusListeners.delete(this.settleHidden);
      if (!items.has(item.key)) return;
      if (isAttached(fiberOf(this))) {
        item.hidden = true;
        item.element = null;
      } else {
        remove(item);
      }
      emit();
    };

    componentDidMount() {
      this.committed = true;
      this.mounted = true;
      this.statusListeners.delete(this.settleHidden);
      const item = this.item;
      if (item) {
        // Revealed: same instance, same item.
        if (!items.has(item.key)) items.set(item.key, item);
        item.hidden = false;
        item.element = null;
        emit();
      } else {
        this.register();
      }
      if (bridge) join(this, this.capture.path);
    }

    componentDidUpdate(prev: FiberTunnelInProps) {
      const item = this.item;
      if (!item) return;
      let changed = false;
      if (prev.children !== this.props.children) {
        item.children = this.props.children;
        item.element = null;
        changed = true;
      }
      if (this.anchor !== this.context) {
        this.anchor = this.context;
        item.path = pathOf(fiberOf(this), this.anchor);
        trackPath(item.path);
        generation++;
        changed = true;
      }
      if (changed) emit();
    }

    componentWillUnmount() {
      this.mounted = false;
      if (bridge) leave(this, this.capture.path);
      const item = this.item;
      if (!item) return;
      // A forwarded status keeps content visible while it loads or the
      // In's boundary replaces it; it hides once ready.
      if (item.status.kind === "ready") {
        item.hidden = true;
        item.element = null;
      } else {
        this.statusListeners.add(this.settleHidden);
      }
      // Deletion detaches the fiber later in this commit; hiding keeps it.
      queueMicrotask(() => {
        if (this.mounted || !items.has(item.key)) return;
        if (!isAttached(fiberOf(this))) remove(item);
        emit();
      });
    }

    render() {
      if (!this.committed) this.prepare();
      if (!bridge) return null;
      return (
        <>
          {!this.committed && (
            <LaneReader key="lanes" onRender={this.readLanes} />
          )}
          {!this.committed && <MountGate key="mount" probe={this.mountProbe} />}
          {this.capture.path.map(
            (source) =>
              source.owner === this && (
                <SourceReader
                  key={source.id}
                  source={source}
                  root={this.root}
                  transitions={transitionsOn}
                />
              ),
          )}
          <StatusView key="status" owner={this} />
        </>
      );
    }
  }

  /** Reconciler kind each cached element was built for. */
  const elementActivity = new WeakMap<ReactElement, boolean>();

  function elementOf(item: Item, activity: boolean): ReactElement {
    const cached = item.element;
    if (cached && elementActivity.get(cached) === activity) return cached;
    let element: ReactElement;
    if (!bridge) {
      element = (
        <Hideable key={item.key} hidden={item.hidden} activity={activity}>
          {item.children}
        </Hideable>
      );
    } else {
      const view = (
        <ItemView
          item={item}
          core={core}
          hidden={item.hidden}
          activity={activity}
          probe={item.probe}
          forwardErrors={forwardErrors}
        >
          {item.children}
        </ItemView>
      );
      // Strict at the placed fiber: React replays effects below it.
      element = item.capture.strict ? (
        <StrictMode key={item.key}>{view}</StrictMode>
      ) : (
        <Fragment key={item.key}>{view}</Fragment>
      );
    }
    elementActivity.set(element, activity);
    item.element = element;
    return element;
  }

  /** Group elements by key; reused while their child elements match. */
  let groupCache = new Map<
    string,
    { children: ReactElement[]; element: ReactElement }
  >();

  /** Nests items by provider path; siblings keep first-item order. */
  function groupedElements(
    sorted: readonly Item[],
    activity: boolean,
  ): ReactElement[] {
    interface Node {
      source: Source | null;
      children: (Node | Item)[];
      bySource: Map<Source, Node>;
    }
    const top: Node = { source: null, children: [], bySource: new Map() };
    for (const item of sorted) {
      let node = top;
      for (const source of item.capture.path) {
        let child = node.bySource.get(source);
        if (!child) {
          child = { source, children: [], bySource: new Map() };
          node.bySource.set(source, child);
          node.children.push(child);
        }
        node = child;
      }
      node.children.push(item);
    }
    const nextCache: typeof groupCache = new Map();
    const render = (node: Node): ReactElement[] =>
      node.children.map((child) => {
        if (!("bySource" in child)) return elementOf(child, activity);
        const source = child.source!;
        const key = `g${source.id}`;
        const elements = render(child);
        const cached = groupCache.get(key);
        const element =
          cached &&
          cached.children.length === elements.length &&
          cached.children.every((e, i) => e === elements[i]) ? (
            cached.element
          ) : (
            <Group key={key} source={source} core={core}>
              {elements}
            </Group>
          );
        nextCache.set(key, { children: elements, element });
        return element;
      });
    const elements = render(top);
    groupCache = nextCache;
    return elements;
  }

  /** Per-Out checks of the Out's reconciler. */
  interface OutChecks {
    microtask: MicrotaskCheck;
    canary: Canary;
  }

  function createOutChecks(onResult: () => void): OutChecks {
    return {
      microtask: createMicrotaskCheck((passed) => {
        microtaskOk = passed;
        if (!passed)
          fallBack("the Out's reconciler missed the microtask check");
        onResult();
      }),
      canary: createCanary((passed) => {
        canaryOk = passed;
        if (!passed) fallBack("the Out's canary failed");
        onResult();
      }),
    };
  }

  /** One Out's root and checks. */
  interface OutState {
    root: FiberRootLike | null;
    /** The root's reconciler renders Activity. */
    activity: boolean;
    checks: OutChecks | null;
  }

  /** Reads the Out's root, then renders its content for that
   * reconciler. */
  class OutBody extends Component<{
    out: OutState;
    render: (activity: boolean) => ReactNode;
  }> {
    render() {
      const { out } = this.props;
      if (!out.root) {
        const fiber = renderingFiberOf(this);
        const top = fiber && topOf(fiber);
        if (top?.tag === HostRootTag) {
          out.root = top.stateNode as FiberRootLike;
          out.activity = rendersActivity(out.root);
        }
      }
      return this.props.render(out.activity);
    }
  }

  function Out() {
    "use no memo";
    // Server HTML has no content; hydration must match.
    const current = useSyncExternalStore(
      subscribe,
      getSnapshot,
      getServerSnapshot,
    );
    // Survives effect replays, so each Out errors once.
    const reportedRef = useRef(false);
    const [, setChecked] = useState(0);
    const [out] = useState<OutState>(() => ({
      root: null,
      activity: true,
      checks: bridge ? createOutChecks(() => setChecked((n) => n + 1)) : null,
    }));

    useLayoutEffect(() => {
      if (!isDevEnv) return;
      mountedOuts++;
      if (mountedOuts > 1 && !reportedRef.current) {
        reportedRef.current = true;
        console.error(multipleOutsError + (React.captureOwnerStack?.() ?? ""));
      }
      return () => void mountedOuts--;
    }, []);

    // Hidden or unmounted Outs never hold a transition.
    useLayoutEffect(() => {
      visibleOuts++;
      const root = out.root;
      if (root) outRoots.set(root, (outRoots.get(root) ?? 0) + 1);
      return () => {
        visibleOuts--;
        if (root) {
          const count = outRoots.get(root)! - 1;
          if (count) outRoots.set(root, count);
          else outRoots.delete(root);
        }
        if (visibleOuts === 0) releaseProbes();
      };
    }, [out]);

    if (current === serverSnapshot) return null;
    const sorted = sortedItems();
    const checks = out.checks;
    return (
      <OutBody
        out={out}
        render={(activity) => (
          <>
            {bridge
              ? groupedElements(sorted, activity)
              : sorted.map((item) => elementOf(item, activity))}
            {checks && !checks.microtask.done && (
              <MicrotaskCheckView key="microtask" check={checks.microtask} />
            )}
            {checks && checks.canary.result === "pending" && (
              <CanaryView
                key="canary"
                canary={checks.canary}
                activity={activity}
              />
            )}
          </>
        )}
      />
    );
  }

  const tunnel = { In, Out, refresh };
  transitionsWaitByTunnel.set(tunnel, transitionsOn);
  return tunnel;
}

/** Each tunnel's transition state. */
const transitionsWaitByTunnel = new WeakMap<FiberTunnel, () => boolean>();

/** True once a tunnel's Out passed its checks: transitions wait for it.
 * Testing. */
export function transitionsWait(tunnel: FiberTunnel) {
  return transitionsWaitByTunnel.get(tunnel)?.() ?? false;
}
