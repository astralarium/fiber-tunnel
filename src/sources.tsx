"use no memo";
// Render-phase writes are deliberate: sources and candidates are caches,
// idempotent per provider fiber and value.
/* eslint-disable react-hooks/refs, react-refresh/only-export-components */
import React, {
  type Context,
  type ReactNode,
  startTransition,
  use,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { isDevEnv } from "./env";
import {
  ContextProviderTag,
  type Fiber,
  type FiberRootLike,
  StrictLegacyMode,
} from "./fiber";
import { createSignal, type Signal } from "./signal";

/** A value stamped in publish order; the newer stamp wins. */
export interface Stamped {
  value: unknown;
  seq: number;
}

let nextSeq = 1;
let nextSourceId = 0;

/** Acknowledgement window: the Out renders a candidate within it. */
export const ackWindowMs = 1_000;
/** Readiness watchdog, armed at acknowledgement. */
export const watchdogMs = 10_000;
/** Probe and candidate expiry. */
export const expiryMs = 60_000;

/** One provider fiber's value, shared by every tunnel and bridge below. */
export interface Source {
  id: number;
  context: Context<unknown>;
  /** Value the owner last published after a commit. */
  committed: Stamped;
  /** Below the provider, in join order. */
  members: Member[];
  /** Reads and publishes the value. */
  owner: Member | null;
  /** Transition values awaiting the Outs, by value. */
  candidates: Map<unknown, Candidate>;
  /** Out providers rendering this source. */
  groups: Set<SourceGroup>;
  listeners: Set<() => void>;
  subscribe(listener: () => void): () => void;
  getCommitted(): Stamped;
}

/** A component below a source's provider, in the source's own tree. */
export interface Member {
  /** Sources this member sees as the nearest provider of their context. */
  readable: ReadonlySet<Source>;
  /** Re-renders to read newly owned sources. */
  rerender(): void;
}

/** A tunnel Out's provider for one source. */
export interface SourceGroup {
  /** Out's root: a reader in the same root skips the candidate render. */
  root: FiberRootLike | null;
  /** False while the Out falls back to publish-after-commit. */
  transitions(): boolean;
  setCandidate(stamped: Stamped): void;
}

/** A transition value the primary commits once every Out renders it. */
export interface Candidate {
  stamp: Stamped;
  /** Every waiting Out rendered the value without suspending. */
  ready: Signal;
  /** The primary committed; the Outs may commit. */
  release: Signal;
  /** Outs yet to report ready. */
  waiting: Set<SourceGroup>;
  /** Outs that rendered the value. */
  acked: Set<SourceGroup>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Dev: the reader's owner stack. */
  stack: string;
}

/** Sources by provider fiber, both generations. */
const sourcesByFiber = new WeakMap<Fiber, Source>();

/** Components rendering a source's provider with a `source` prop. */
const sourceProviderTypes = new WeakSet<object>();

/** Marks a component that renders `source.context` as its child. */
export function markSourceProvider(type: object) {
  sourceProviderTypes.add(type);
}

function createSource(context: Context<unknown>, value: unknown): Source {
  const listeners = new Set<() => void>();
  const source: Source = {
    id: nextSourceId++,
    context,
    committed: { value, seq: 0 },
    members: [],
    owner: null,
    candidates: new Map(),
    groups: new Set(),
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getCommitted: () => source.committed,
  };
  return source;
}

/** The source of a provider fiber; a source provider's child resolves
 * upstream. `bridged` marks the upstream case. */
function sourceOf(fiber: Fiber): { source: Source; bridged: boolean } {
  const parent = fiber.return;
  if (parent && sourceProviderTypes.has(parent.type as object)) {
    const props = parent.pendingProps as { source: Source };
    return { source: props.source, bridged: true };
  }
  let source =
    sourcesByFiber.get(fiber) ??
    (fiber.alternate ? sourcesByFiber.get(fiber.alternate) : undefined);
  if (!source) {
    const props = fiber.pendingProps as { value?: unknown } | null;
    source = createSource(fiber.type as Context<unknown>, props?.value);
  }
  sourcesByFiber.set(fiber, source);
  if (fiber.alternate) sourcesByFiber.set(fiber.alternate, source);
  return { source, bridged: false };
}

/** Providers and StrictMode above a fiber. */
export interface Capture {
  /** Every provider above, outermost first, shadowed included. */
  path: readonly Source[];
  /** Nearest provider of each context, excluding upstream sources. */
  readable: ReadonlySet<Source>;
  strict: boolean;
}

export const emptyCapture: Capture = {
  path: [],
  readable: new Set(),
  strict: false,
};

/** Captures every provider above `fiber` in its own root. */
export function captureAbove(fiber: Fiber, skip?: Context<unknown>): Capture {
  const path: Source[] = [];
  const readable = new Set<Source>();
  const seen = new Set<unknown>();
  for (let node = fiber.return; node; node = node.return) {
    if (node.tag !== ContextProviderTag || node.type === skip) continue;
    const { source, bridged } = sourceOf(node);
    path.push(source);
    if (!seen.has(node.type)) {
      seen.add(node.type);
      if (!bridged) readable.add(source);
    }
  }
  return {
    path: path.reverse(),
    readable,
    strict: (fiber.mode & StrictLegacyMode) !== 0,
  };
}

/** Adds `member` below its sources; takes ownership where none exists. */
export function join(member: Member, path: readonly Source[]) {
  let owns = false;
  for (const source of path) {
    if (source.members.includes(member)) continue;
    source.members.push(member);
    if (!source.owner && member.readable.has(source)) {
      source.owner = member;
      owns = true;
    }
  }
  if (owns) member.rerender();
}

/** Removes `member`; the next readable member takes over and re-renders. */
export function leave(member: Member, path: readonly Source[]) {
  const heirs = new Set<Member>();
  for (const source of path) {
    const index = source.members.indexOf(member);
    if (index === -1) continue;
    source.members.splice(index, 1);
    if (source.owner !== member) continue;
    source.owner =
      source.members.find((other) => other.readable.has(source)) ?? null;
    if (source.owner) heirs.add(source.owner);
  }
  for (const heir of heirs) heir.rerender();
}

/** Publishes a changed committed value. Releases every candidate; a
 * candidate absent from its source renders as lost. */
export function publish(source: Source, value: unknown) {
  if (Object.is(value, source.committed.value)) return;
  for (const candidate of source.candidates.values()) {
    clearTimer(candidate);
    candidate.ready.resolve();
    candidate.release.resolve();
  }
  source.candidates.clear();
  restamp(source, value);
}

/** Stamps the committed value; Outs re-render with it. */
function restamp(source: Source, value: unknown) {
  source.committed = { value, seq: nextSeq++ };
  for (const listener of source.listeners) listener();
}

/** True while `stamp` is its source's live candidate. */
export function isLive(source: Source, stamp: Stamped) {
  return source.candidates.get(stamp.value)?.stamp === stamp;
}

function clearTimer(candidate: Candidate) {
  if (candidate.timer !== null) clearTimeout(candidate.timer);
  candidate.timer = null;
}

/** Releases `ready` without the Outs' verification. */
function releaseUnverified(source: Source, candidate: Candidate, why: string) {
  if (candidate.ready.done) return;
  if (isDevEnv) console.warn(why + candidate.stack);
  candidate.waiting.clear();
  resolveReady(source, candidate);
}

function resolveReady(source: Source, candidate: Candidate) {
  clearTimer(candidate);
  candidate.ready.resolve();
  // An abandoned transition never publishes; its Outs fall back to the
  // committed value.
  candidate.timer = setTimeout(() => {
    if (!isLive(source, candidate.stamp)) return;
    source.candidates.delete(candidate.stamp.value);
    candidate.release.resolve();
    restamp(source, source.committed.value);
  }, expiryMs);
}

const missedAckWarning =
  "fiber-tunnel: the Out did not render a transition's value within " +
  `${ackWindowMs} ms; the transition commits unverified.`;

const watchdogWarning =
  "fiber-tunnel: content at the Out did not finish a transition's value " +
  `within ${watchdogMs} ms; the transition commits unverified.`;

/** The candidate for `value`, started once: the Outs render it in a
 * transition. Ready at once without an Out in another root. */
export function startCandidate(
  source: Source,
  value: unknown,
  root: FiberRootLike | null,
): Candidate {
  let candidate = source.candidates.get(value);
  if (candidate) return candidate;
  candidate = {
    stamp: { value, seq: nextSeq++ },
    ready: createSignal(),
    release: createSignal(),
    waiting: new Set(),
    acked: new Set(),
    timer: null,
    stack: isDevEnv ? (React.captureOwnerStack?.() ?? "") : "",
  };
  source.candidates.set(value, candidate);
  for (const group of source.groups) {
    if (group.root !== root && group.transitions()) {
      candidate.waiting.add(group);
    }
  }
  if (candidate.waiting.size === 0) {
    resolveReady(source, candidate);
    return candidate;
  }
  const stamp = candidate.stamp;
  const waiting = [...candidate.waiting];
  startTransition(() => {
    for (const group of waiting) group.setCandidate(stamp);
  });
  const armed = candidate;
  armed.timer = setTimeout(
    () => releaseUnverified(source, armed, missedAckWarning),
    ackWindowMs,
  );
  return candidate;
}

/** An Out rendered `stamp`: an acknowledged wait is a real load. */
export function acknowledge(
  source: Source,
  group: SourceGroup,
  stamp: Stamped,
) {
  const candidate = source.candidates.get(stamp.value);
  if (!candidate || candidate.stamp !== stamp || candidate.ready.done) return;
  if (!candidate.waiting.has(group) || candidate.acked.has(group)) return;
  candidate.acked.add(group);
  if (candidate.acked.size < candidate.waiting.size) return;
  clearTimer(candidate);
  candidate.timer = setTimeout(
    () => releaseUnverified(source, candidate, watchdogWarning),
    watchdogMs,
  );
}

/** An Out rendered `stamp`'s value without suspending. */
export function groupReady(source: Source, group: SourceGroup, stamp: Stamped) {
  const candidate = source.candidates.get(stamp.value);
  if (!candidate || candidate.stamp !== stamp) return;
  settle(source, candidate, group);
}

function settle(source: Source, candidate: Candidate, group: SourceGroup) {
  if (!candidate.waiting.delete(group)) return;
  candidate.acked.delete(group);
  if (candidate.waiting.size === 0) resolveReady(source, candidate);
}

/** Adds an Out provider for `source`. */
export function addGroup(source: Source, group: SourceGroup) {
  source.groups.add(group);
}

/** Removes an Out provider: hidden or unmounted Outs never block. */
export function removeGroup(source: Source, group: SourceGroup) {
  source.groups.delete(group);
  for (const candidate of source.candidates.values()) {
    if (!candidate.ready.done) settle(source, candidate, group);
  }
}

/** Reads sources in their own tree and publishes each committed value.
 * In a transition render, waits until every Out renders the changed
 * values. */
export function useSourceReads(
  sources: readonly Source[],
  root: FiberRootLike | null,
  transitions: () => boolean,
) {
  const values = sources.map((source) => use(source.context));
  // One identity per distinct value list: `useDeferredValue` lags it in
  // urgent renders and returns it in transition renders.
  const last = useRef<unknown[]>(values);
  const tuple =
    last.current.length === values.length &&
    last.current.every((value, i) => Object.is(value, values[i]))
      ? last.current
      : values;
  const deferred = useDeferredValue(tuple);
  const mounted = useRef(false);
  if (mounted.current && deferred === tuple && transitions()) {
    sources.forEach((source, i) => {
      if (Object.is(values[i], source.committed.value)) return;
      // Unconditional on this path: a replay calls use() again.
      use(startCandidate(source, values[i], root).ready.thenable);
    });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    last.current = tuple;
    sources.forEach((source, i) => publish(source, values[i]));
  });
}

/** Props of {@link SourceReader}. */
interface SourceReaderProps {
  source: Source;
  /** Reader's root. */
  root: FiberRootLike | null;
  /** False while the tunnel publishes after commit. */
  transitions: () => boolean;
}

/** Reads one owned source for a bridged In. */
export function SourceReader({ source, root, transitions }: SourceReaderProps) {
  useSourceReads([source], root, transitions);
  return null;
}

/** Renders a source's committed value as its context. */
export function SourceProvider({
  source,
  children,
}: {
  source: Source;
  children: ReactNode;
}) {
  const { value } = useSyncExternalStore(
    source.subscribe,
    source.getCommitted,
    source.getCommitted,
  );
  const Provider = source.context;
  return <Provider value={value}>{children}</Provider>;
}
markSourceProvider(SourceProvider);
