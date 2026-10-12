"use no memo";
// Render-phase writes are deliberate: readiness and acknowledgement are
// idempotent per value and probe.
/* eslint-disable react-hooks/immutability, react-refresh/only-export-components */
import {
  Activity,
  Component,
  type ReactNode,
  Suspense,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  ancestorWithTag,
  ContextProviderTag,
  type Fiber,
  type FiberRootLike,
  internalsLookSane,
  OffscreenLane,
  priorWorkCompleted,
  renderingFiberOf,
  renderLanesOf,
  SuspenseTag,
  topOf,
} from "./fiber";
import { type Item, type ItemStatus, type Probe, setStatus } from "./item";
import { createSignal, type Signal } from "./signal";
import {
  acknowledge,
  addGroup,
  groupReady,
  isLive,
  markSourceProvider,
  removeGroup,
  type Source,
  type SourceGroup,
  type Stamped,
} from "./sources";

/** Tunnel state the bridged views report to. */
export interface TunnelCore {
  /** Transitions wait for the Out; false publishes after commit. */
  transitionsOn(): boolean;
  /** The Out rendered a probe. */
  ackProbe(probe: Probe): void;
  /** The Out rendered a probe's content without suspending. */
  probeReady(probe: Probe): void;
}

/** Suspends until `signal` resolves. */
export function Hold({ signal }: { signal: Signal }) {
  use(signal.thenable);
  return null;
}

/** FiberRoot of a rendering fiber. */
function rootOfFiber(fiber: Fiber | null): FiberRootLike | null {
  return fiber ? (topOf(fiber).stateNode as FiberRootLike | null) : null;
}

/** Props of {@link Group}. */
interface GroupProps {
  source: Source;
  core: TunnelCore;
  children: ReactNode;
}

/** One source's provider at the Out; a transition's value renders here
 * before the primary commits it. */
export function Group({ source, core, children }: GroupProps) {
  const committed = useSyncExternalStore(
    source.subscribe,
    source.getCommitted,
    source.getCommitted,
  );
  const [candidate, setCandidate] = useState<Stamped | null>(null);
  const [group] = useState<SourceGroup>(() => ({
    root: null,
    transitions: () => core.transitionsOn(),
    setCandidate,
  }));
  useLayoutEffect(() => {
    addGroup(source, group);
    return () => removeGroup(source, group);
  }, [source, group]);
  const stamp = candidate && isLive(source, candidate) ? candidate : committed;
  if (stamp === candidate) acknowledge(source, group, stamp);
  const Provider = source.context;
  return (
    <Provider value={stamp.value}>
      {children}
      <Suspense fallback={null}>
        <GroupGate source={source} group={group} stamp={stamp} />
      </Suspense>
    </Provider>
  );
}
markSourceProvider(Group);

/** Props of {@link GroupGate}. */
interface GroupGateProps {
  source: Source;
  group: SourceGroup;
  stamp: Stamped;
}

/** Renders last under a group's provider: reports the candidate ready
 * once everything before it completed, then holds the Out's commit until
 * the primary commits. */
class GroupGate extends Component<GroupGateProps> {
  render() {
    const { source, group, stamp } = this.props;
    const fiber = renderingFiberOf(this);
    group.root ??= rootOfFiber(fiber);
    const candidate = source.candidates.get(stamp.value);
    if (!candidate || candidate.stamp !== stamp) return null;
    if (!candidate.ready.done && candidate.waiting.has(group)) {
      const provider = fiber && ancestorWithTag(fiber, ContextProviderTag);
      if (!provider || priorWorkCompleted(fiber, provider)) {
        groupReady(source, group, stamp);
      }
    }
    return <Hold signal={candidate.release} />;
  }
}

/** Props of {@link ItemView}. */
export interface ItemViewProps {
  item: Item;
  core: TunnelCore;
  children: ReactNode;
  hidden: boolean;
  activity: boolean;
  probe: Probe | null;
  /** Content errors rethrow at the In; false lets them rise from the
   * Out. */
  forwardErrors: boolean;
}

/** A bridged item at the Out: error forwarder › Suspense › content,
 * hidden with its In. */
export class ItemView extends Component<ItemViewProps> {
  render() {
    const { item, core, children, hidden, activity, probe, forwardErrors } =
      this.props;
    if (probe) core.ackProbe(probe);
    const content = (
      <Suspense fallback={probe ? null : <Pending item={item} />}>
        {children}
        <ItemGate item={item} core={core} />
      </Suspense>
    );
    return (
      <Hideable hidden={hidden} activity={activity}>
        {forwardErrors ? (
          <ErrorForwarder item={item}>{content}</ErrorForwarder>
        ) : (
          content
        )}
      </Hideable>
    );
  }
}

/** Never resolves. */
const forever = createSignal();

function Hide(): null {
  use(forever.thenable);
  return null;
}

/** Props of {@link Hideable}. */
interface HideableProps {
  hidden: boolean;
  /** The Out's reconciler renders Activity; otherwise a suspended
   * boundary hides. */
  activity: boolean;
  children: ReactNode;
}

/** Hides children, keeping their state. */
export function Hideable({ hidden, activity, children }: HideableProps) {
  if (activity) {
    return <Activity mode={hidden ? "hidden" : "visible"}>{children}</Activity>;
  }
  return (
    <Suspense fallback={null}>
      {children}
      {hidden && <Hide />}
    </Suspense>
  );
}

/** Catches a content error and forwards it to the In. */
class ErrorForwarder extends Component<
  { item: Item; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    setStatus(this.props.item, { kind: "error", error });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Fallback: content suspended; the In suspends until it shows. */
function Pending({ item }: { item: Item }) {
  useLayoutEffect(() => {
    const signal = createSignal();
    const status: ItemStatus = { kind: "pending", signal };
    setStatus(item, status);
    return () => {
      signal.resolve();
      if (item.status === status) setStatus(item, { kind: "ready" });
    };
  }, [item]);
  return null;
}

/** Renders after a probe's content: reports it ready, then holds until
 * the In commits. */
class ItemGate extends Component<{ item: Item; core: TunnelCore }> {
  render() {
    const { item, core } = this.props;
    const probe = item.probe;
    if (!probe) return null;
    if (!probe.ready.done) {
      const fiber = renderingFiberOf(this);
      const boundary = fiber && ancestorWithTag(fiber, SuspenseTag);
      if (!boundary || priorWorkCompleted(fiber, boundary)) {
        core.probeReady(probe);
      }
    }
    return <Hold signal={probe.release} />;
  }
}

/** The In side of an item's status. */
export interface StatusOwner {
  subscribeStatus(listener: () => void): () => void;
  getStatus(): ItemStatus;
}

/** Rethrows a content error at the In; suspends while content loads. */
export function StatusView({ owner }: { owner: StatusOwner }) {
  const status = useSyncExternalStore(
    owner.subscribeStatus,
    owner.getStatus,
    owner.getStatus,
  );
  if (status.kind === "error") throw status.error;
  if (status.kind === "pending") use(status.signal.thenable);
  return null;
}

/** Reads the mount pass's lanes from its fresh sibling. */
export class LaneReader extends Component<{
  onRender: (reader: Component) => void;
}> {
  render() {
    this.props.onRender(this);
    return null;
  }
}

/** Suspends a transition mount until the Out renders its probe. */
export function MountGate({ probe }: { probe: () => Probe | null }) {
  const current = probe();
  if (current) use(current.ready.thenable);
  return null;
}

/** Probe of the gate and lane reads in the Out's own reconciler. */
export interface Canary {
  signal: Signal;
  /** Internals check of the suspended pass. */
  sane: boolean | null;
  sawNotReady: boolean;
  result: "pending" | "passed" | "failed";
  /** Reports a result once. */
  finish(passed: boolean): void;
}

export function createCanary(onResult: (passed: boolean) => void): Canary {
  const canary: Canary = {
    signal: createSignal(),
    sane: null,
    sawNotReady: false,
    result: "pending",
    finish(passed) {
      if (canary.result !== "pending") return;
      canary.result = passed ? "passed" : "failed";
      canary.signal.resolve();
      // Reported outside render.
      queueMicrotask(() => onResult(passed));
    },
  };
  return canary;
}

/** Resolves the canary when no gate render observed its suspension. */
const canaryWaitMs = 50;

/** A hidden item suspended on a tunnel-owned promise. */
export function CanaryView({
  canary,
  activity,
}: {
  canary: Canary;
  activity: boolean;
}) {
  const view = (
    <Suspense fallback={null}>
      <CanaryLanes canary={canary} activity={activity} />
      <CanarySuspend canary={canary} />
      <CanaryGate canary={canary} />
    </Suspense>
  );
  // Hidden: renders after the Out commits. Invisible either way.
  return activity ? <Activity mode="hidden">{view}</Activity> : view;
}

/** Checks the lanes of the canary's first pass, read from its fresh
 * sibling. A hidden pass entangles its base lanes with OffscreenLane. */
class CanaryLanes extends Component<{ canary: Canary; activity: boolean }> {
  render() {
    const { canary, activity } = this.props;
    if (canary.sane !== null) return null;
    if (activity) {
      const fiber = renderingFiberOf(this);
      const lanes = fiber && renderLanesOf(fiber);
      canary.sane = lanes != null && (lanes & OffscreenLane) !== 0;
    } else {
      canary.sane = internalsLookSane(this) !== "failed";
    }
    return null;
  }
}

function CanarySuspend({ canary }: { canary: Canary }) {
  useEffect(() => {
    // A gate that never renders past the suspension never misreports it.
    const timer = setTimeout(() => canary.signal.resolve(), canaryWaitMs);
    return () => clearTimeout(timer);
  }, [canary]);
  use(canary.signal.thenable);
  return null;
}

class CanaryGate extends Component<{ canary: Canary }> {
  render() {
    const { canary } = this.props;
    if (canary.result !== "pending") return null;
    const fiber = renderingFiberOf(this);
    const boundary = fiber && ancestorWithTag(fiber, SuspenseTag);
    if (!fiber || !boundary) {
      canary.finish(false);
      return null;
    }
    const complete = priorWorkCompleted(fiber, boundary);
    if (!canary.signal.done) {
      // Ready while suspended: the gate misreads fibers.
      if (complete) canary.finish(false);
      else if (!canary.sawNotReady) {
        canary.sawNotReady = true;
        // Resolve outside render; React retries the boundary.
        queueMicrotask(() => canary.signal.resolve());
      }
    } else if (complete) {
      canary.finish(canary.sane === true);
    }
    return null;
  }
}

/** Checks that a store emit commits at the Out before a queued
 * microtask. */
export interface MicrotaskCheck {
  version: number;
  committed: number;
  listeners: Set<() => void>;
  done: boolean;
  onResult: (passed: boolean) => void;
}

export function createMicrotaskCheck(
  onResult: (passed: boolean) => void,
): MicrotaskCheck {
  return {
    version: 0,
    committed: 0,
    listeners: new Set(),
    done: false,
    onResult,
  };
}

export function MicrotaskCheckView({ check }: { check: MicrotaskCheck }) {
  const version = useSyncExternalStore(
    (listener) => {
      check.listeners.add(listener);
      return () => void check.listeners.delete(listener);
    },
    () => check.version,
    () => check.version,
  );
  useLayoutEffect(() => {
    check.committed = version;
  });
  useEffect(() => {
    if (check.done) return;
    check.version++;
    for (const listener of check.listeners) listener();
    queueMicrotask(() => {
      if (check.done) return;
      check.done = true;
      check.onResult(check.committed === check.version);
    });
  }, [check]);
  return null;
}
