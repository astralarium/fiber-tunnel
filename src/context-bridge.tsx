"use no memo";
// Render-phase writes are deliberate: captures, native providers and
// shapes are caches of a fixed position.
import { Component, type ReactNode, StrictMode } from "react";

import { isDevEnv } from "./env";
import {
  type Fiber,
  type FiberRootLike,
  HostRootTag,
  renderingFiberOf,
  topOf,
} from "./fiber";
import {
  type Capture,
  captureAbove,
  emptyCapture,
  join,
  leave,
  type Member,
  nativeProvidersAbove,
  type Source,
  sourceAt,
  SourceProvider,
  SourceReader,
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
  /** Captures only providers this tree renders; the ContextBridge site
   * supplies contexts a tunnel bridges in. Read at mount. */
  local?: boolean;
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
    const capture = captureAbove(fiber);
    this.capture = this.props.local
      ? {
          ...capture,
          path: capture.path.filter((source) => capture.readable.has(source)),
        }
      : capture;
    this.readable = capture.readable;
    captures.set(this.bridge, this.capture);
  }

  componentDidMount() {
    this.mounted = true;
    join(this, this.capture.path);
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

/** Dev warning: a swapped bridge changed the providers. */
const reshapeWarning =
  "fiber-tunnel: a ContextBridge's new bridge provides other contexts; " +
  "its children remount.";

/** Class: reads the native providers above its own fiber. */
class Bridge extends Component<ContextBridgeProps> {
  /** Read on first render; empty where the fiber is unreadable. */
  native: ReadonlyMap<unknown, Fiber> | null = null;
  /** Dev: keys and StrictMode of the last render. */
  shape: string | null = null;
  warned = false;

  render() {
    if (!this.native) {
      const fiber = renderingFiberOf(this);
      this.native =
        fiber && topOf(fiber).tag === HostRootTag
          ? nativeProvidersAbove(fiber)
          : new Map();
    }
    const capture = captures.get(this.props.bridge) ?? emptyCapture;
    const steps = stepsOf(capture, this.native);
    const { strict } = capture;
    if (isDevEnv) {
      const shape = `${strict}|${steps.map((step) => step.key).join(",")}`;
      if (this.shape !== null && this.shape !== shape && !this.warned) {
        this.warned = true;
        console.warn(reshapeWarning);
      }
      this.shape = shape;
    }
    const { children } = this.props;
    let node = strict ? <StrictMode>{children}</StrictMode> : children;
    for (let i = steps.length - 1; i >= 0; i--) {
      node = (
        <SourceProvider key={steps[i].key} source={steps[i].source}>
          {node}
        </SourceProvider>
      );
    }
    return <>{node}</>;
  }
}

/**
 * Renders children under a captured bridge, in any root. Providers the
 * bridge's position already reads come from that position. A new
 * `bridge` with the same contexts updates their values in place; other
 * contexts remount the children.
 */
export function ContextBridge(props: ContextBridgeProps) {
  return <Bridge {...props} />;
}
