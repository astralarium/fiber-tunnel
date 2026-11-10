"use no memo";
// Render-phase writes are deliberate: captures, native providers and
// slot counts are caches of a fixed position.
import {
  Component,
  type Context,
  type ReactNode,
  StrictMode,
  use,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  type ContextBridgeShape,
  extendShape,
  shapeContexts,
  shapeStrict,
  subscribeShape,
  unsubscribeShape,
} from "./bridge-shape";
import { isDevEnv } from "./env";
import {
  type Fiber,
  type FiberRootLike,
  HostRootTag,
  renderingFiberOf,
  topOf,
} from "./fiber";
import {
  addGroup,
  type Capture,
  captureAbove,
  createSource,
  emptyCapture,
  join,
  leave,
  type Member,
  nativeProvidersAbove,
  relayGroup,
  removeGroup,
  type Source,
  sourceAt,
  SourceReader,
  SourceValue,
} from "./sources";

declare const bridgeBrand: unique symbol;

/** Ancestor providers and StrictMode, captured at mount. Identity fixed. */
export interface ContextBridgeValue {
  readonly [bridgeBrand]: true;
}

/** Captures behind each bridge value. */
const captures = new WeakMap<ContextBridgeValue, Capture>();

/** Props of {@link ContextCapture}. */
export interface ContextCaptureProps {
  /** Receives the bridge; rendered in place. */
  children: (bridge: ContextBridgeValue) => ReactNode;
  /** Adds the captured contexts and StrictMode to this shape at mount. */
  shape?: ContextBridgeShape;
}

/** Captures always wait for Outs in transitions. */
const alwaysTransitions = () => true;

/** Class: captures the providers above it on first render, then reads
 * the sources it owns. */
class Capturer extends Component<ContextCaptureProps> implements Member {
  readonly bridge = {} as ContextBridgeValue;
  capture: Capture = emptyCapture;
  readable: ReadonlySet<Source> = emptyCapture.readable;
  root: FiberRootLike | null = null;
  /** The capture joined at mount stays fixed. */
  mounted = false;

  rerender = () => this.forceUpdate();

  prepare() {
    const fiber = renderingFiberOf(this);
    const top = fiber && topOf(fiber);
    if (!fiber || top?.tag !== HostRootTag) return;
    this.root = top.stateNode as FiberRootLike;
    this.capture = captureAbove(fiber);
    this.readable = this.capture.readable;
    captures.set(this.bridge, this.capture);
  }

  componentDidMount() {
    this.mounted = true;
    join(this, this.capture.path);
    if (this.props.shape) extendShape(this.props.shape, this.capture);
  }

  componentWillUnmount() {
    leave(this, this.capture.path);
  }

  render() {
    if (!this.mounted && this.capture === emptyCapture) this.prepare();
    return (
      <>
        {this.capture.path.map(
          (source) =>
            source.owner === this && (
              <SourceReader
                key={source.id}
                source={source}
                root={this.root}
                transitions={alwaysTransitions}
              />
            ),
        )}
        {this.props.children(this.bridge)}
      </>
    );
  }
}

/**
 * Captures the providers above it for {@link ContextBridge}; the bridge
 * carries their live values. The capture is fixed at mount.
 *
 * @example
 * <ContextCapture>
 *   {(bridge) => <Elsewhere bridge={bridge} />}
 * </ContextCapture>
 */
export function ContextCapture(props: ContextCaptureProps) {
  return <Capturer {...props} />;
}

/** Props of {@link ContextBridge}. */
export interface ContextBridgeProps {
  /** From {@link ContextCapture} or {@link FiberAnchor}'s function
   * children. */
  bridge: ContextBridgeValue;
  /** Provides every context of the shape, in one order: a new `bridge`
   * keeps the children mounted. A context the bridge lacks provides the
   * value at this position. Renders StrictMode once any of the shape's
   * captures did. Adds the bridge's contexts to the shape.
   * Captures and Ins below follow a new `bridge`; at an Out, their
   * content renders under providers of its own. Shaped captures mounting
   * after the bridge's mount commit remount its children once. */
  shape?: ContextBridgeShape;
  children: ReactNode;
}

/** Ids of contexts, in first-bridged order. */
const contextIds = new WeakMap<object, number>();
let nextContextId = 0;

function contextId(context: object) {
  let id = contextIds.get(context);
  if (id === undefined) contextIds.set(context, (id = nextContextId++));
  return id;
}

/** One provider a bridge renders. */
interface Step {
  source: Source;
  /** Context id, then occurrence past the first. */
  key: string;
  id: number;
}

/** The capture's sources, less those `native` provides unshadowed, in
 * context order: nesting order of distinct contexts changes no reads. */
function stepsOf(
  capture: Capture,
  native: ReadonlyMap<unknown, Fiber>,
): Step[] {
  const provided = new Set<unknown>();
  const counts = new Map<unknown, number>();
  const steps: Step[] = [];
  for (const source of capture.path) {
    const provider = native.get(source.context);
    const isNative = provider !== undefined && sourceAt(provider) === source;
    if (isNative && !provided.has(source.context)) continue;
    provided.add(source.context);
    const id = contextId(source.context);
    const count = counts.get(source.context) ?? 0;
    counts.set(source.context, count + 1);
    steps.push({ source, key: count ? `${id}.${count}` : `${id}`, id });
  }
  // Stable: shadowing providers of one context keep their order.
  return steps.sort((a, b) => a.id - b.id);
}

/** Props of {@link BridgeSlot}. */
interface BridgeSlotProps {
  context: Context<unknown>;
  /** Captured source; null provides the value at the bridge's
   * position. */
  source: Source | null;
  /** Bridge's root. */
  root: FiberRootLike | null;
  children: ReactNode;
}

/** One context a bridge provides, through a relay fixed for the slot's
 * life: captures below resolve to the relay, so they follow a new
 * `source`, and their Outs render its transition values. */
function BridgeSlot({ context, source, root, children }: BridgeSlotProps) {
  const committed = useSyncExternalStore(
    source ? source.subscribe : noSubscribe,
    source ? source.getCommitted : noCommitted,
    source ? source.getCommitted : noCommitted,
  );
  const value = committed ? committed.value : use(context);
  const [relay] = useState(() => createSource(context, value));
  useLayoutEffect(() => {
    if (!source) return;
    const group = relayGroup(source, relay);
    addGroup(source, group);
    return () => removeGroup(source, group);
  }, [source, relay]);
  return (
    <SourceValue source={relay} value={value}>
      <SourceReader
        source={relay}
        root={root}
        transitions={alwaysTransitions}
      />
      {children}
    </SourceValue>
  );
}

/** One context a bridge provides as `source`'s committed value: captures
 * below share `source`. */
function SharedSlot({
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
  return (
    <SourceValue source={source} value={value}>
      {children}
    </SourceValue>
  );
}

const noSubscribe = () => () => {};
const noCommitted = () => null;

/** Each context of `shape` and `capture`, in context order, with the
 * capture's nearest source; null where `native` provides it. */
function slotsOf(
  shape: ContextBridgeShape,
  capture: Capture,
  native: ReadonlyMap<unknown, Fiber>,
) {
  const nearest = new Map<Context<unknown>, Source>();
  for (const source of capture.path) nearest.set(source.context, source);
  const contexts = new Set([...shapeContexts(shape), ...nearest.keys()]);
  return [...contexts]
    .map((context) => {
      const source = nearest.get(context);
      const provider = native.get(context);
      const isNative = provider !== undefined && sourceAt(provider) === source;
      return {
        context,
        source: source && !isNative ? source : null,
        id: contextId(context),
      };
    })
    .sort((a, b) => a.id - b.id);
}

/** Dev warning: a swapped bridge changed the providers. */
const reshapeWarning =
  "fiber-tunnel: a ContextBridge's new bridge provides other contexts; " +
  "its children remount.";

/** Dev warning: a shaped bridge changed the providers. */
const growWarning =
  "fiber-tunnel: a shaped ContextBridge's providers changed; its children " +
  "remount.";

/** What a Bridge render provided. */
interface Rendered {
  /** Shaped slots; 0 when unshaped. */
  slots: number;
  /** Wrapped in StrictMode. */
  strict: boolean;
}

/** Class: reads the native providers above its own fiber. */
class Bridge extends Component<ContextBridgeProps> {
  /** Read on first render; empty where the fiber is unreadable. */
  native: ReadonlyMap<unknown, Fiber> | null = null;
  root: FiberRootLike | null = null;
  /** Dev: keys and StrictMode of the last render. */
  keys: string | null = null;
  warned = false;
  /** The last committed render. */
  rendered: Rendered = { slots: 0, strict: false };
  /** The last render; becomes `rendered` at commit. */
  pending: Rendered = { slots: 0, strict: false };
  /** Mount commit in progress: growth remounts the children silently. */
  settling = false;

  /** Re-renders when the shape holds contexts or StrictMode the last
   * committed render lacks. The shape holds the rendered slots once the
   * bridge extends it. */
  sync = () => {
    const { shape } = this.props;
    const { slots, strict } = this.rendered;
    if (
      !shape ||
      (shapeContexts(shape).size === slots && shapeStrict(shape) === strict)
    ) {
      return;
    }
    if (this.settling) this.keys = null;
    this.forceUpdate();
  };

  componentDidMount() {
    const { shape, bridge } = this.props;
    this.rendered = this.pending;
    this.settling = true;
    queueMicrotask(() => (this.settling = false));
    if (!shape) return;
    extendShape(shape, captures.get(bridge) ?? emptyCapture);
    subscribeShape(shape, this.sync);
    this.sync();
  }

  componentDidUpdate(prev: ContextBridgeProps) {
    const { shape, bridge } = this.props;
    this.rendered = this.pending;
    if (prev.shape !== shape) {
      if (prev.shape) unsubscribeShape(prev.shape, this.sync);
      if (shape) subscribeShape(shape, this.sync);
    }
    if (!shape) return;
    extendShape(shape, captures.get(bridge) ?? emptyCapture);
    this.sync();
  }

  componentWillUnmount() {
    const { shape } = this.props;
    if (shape) unsubscribeShape(shape, this.sync);
  }

  /** Dev: warns once when the providers change. */
  check(keys: string, warning: string) {
    if (this.keys !== null && this.keys !== keys && !this.warned) {
      this.warned = true;
      console.warn(warning);
    }
    this.keys = keys;
  }

  render() {
    const { shape, children } = this.props;
    const capture = captures.get(this.props.bridge) ?? emptyCapture;
    const strict = capture.strict || (!!shape && shapeStrict(shape));
    this.pending = { slots: 0, strict };
    let node = strict ? <StrictMode>{children}</StrictMode> : children;
    if (!this.native) {
      const fiber = renderingFiberOf(this);
      const top = fiber && topOf(fiber);
      const readable = fiber && top?.tag === HostRootTag;
      this.root = readable ? (top.stateNode as FiberRootLike) : null;
      this.native = readable ? nativeProvidersAbove(fiber) : new Map();
    }
    if (shape) {
      const slots = slotsOf(shape, capture, this.native);
      this.pending.slots = slots.length;
      if (isDevEnv) {
        const ids = slots.map((slot) => slot.id).join(",");
        this.check(`shaped|${strict}|${ids}`, growWarning);
      }
      for (let i = slots.length - 1; i >= 0; i--) {
        const { context, source, id } = slots[i];
        node = (
          <BridgeSlot
            key={id}
            context={context}
            source={source}
            root={this.root}
          >
            {node}
          </BridgeSlot>
        );
      }
      return <>{node}</>;
    }
    const steps = stepsOf(capture, this.native);
    if (isDevEnv) {
      this.check(
        `${strict}|${steps.map((step) => step.key).join(",")}`,
        reshapeWarning,
      );
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      const { key, source } = steps[i];
      node = (
        <SharedSlot key={key} source={source}>
          {node}
        </SharedSlot>
      );
    }
    return <>{node}</>;
  }
}

/**
 * Renders children under a captured bridge, in any root. Providers the
 * bridge's position already reads come from that position. A new
 * `bridge` with the same contexts updates their values in place; other
 * contexts remount the children, unless the bridges share a `shape`.
 */
export function ContextBridge(props: ContextBridgeProps) {
  return <Bridge {...props} />;
}
