"use no memo";
/* eslint-disable react-hooks/immutability, react-refresh/only-export-components */
import {
  type ReactNode,
  StrictMode,
  useLayoutEffect,
  useReducer,
  useState,
} from "react";

import { isDevEnv } from "./env";
import {
  type Fiber,
  type FiberRootLike,
  HostRootTag,
  isFiber,
  topOf,
} from "./fiber";
import {
  type Capture,
  captureAbove,
  emptyCapture,
  join,
  leave,
  type Member,
  type Source,
  SourceProvider,
  useSourceReads,
} from "./sources";

declare const bridgeBrand: unique symbol;

/** Ancestor providers and StrictMode, captured at mount. Identity fixed. */
export interface ContextBridgeValue {
  readonly [bridgeBrand]: true;
}

/** Captures behind each bridge value. */
const captures = new WeakMap<ContextBridgeValue, Capture>();

const missingFiberWarning =
  "fiber-tunnel: useContextBridge could not find its component's fiber; " +
  "the bridge carries no context.";

/** The calling component's fiber, on mount: React binds each state
 * dispatcher to the rendering fiber. Null after mount or on the server. */
function useMountFiber(): Fiber | null {
  const proto = Function.prototype;
  const bind = proto.bind;
  let found: Fiber | null = null;
  proto.bind = function (this: never, thisArg: unknown, ...args: unknown[]) {
    if (found === null && isFiber(args[0])) found = args[0];
    return bind.call(this, thisArg, ...args);
  } as typeof bind;
  try {
    useReducer(increment, 0);
  } finally {
    proto.bind = bind;
  }
  return found;
}

const increment = (n: number) => n + 1;

/** Outs decide per group whether transitions wait. */
const alwaysTransitions = () => true;

/** A `useContextBridge` caller below its sources. */
class HostMember implements Member {
  readonly capture: Capture;
  readonly bridge: ContextBridgeValue;
  readonly readable: ReadonlySet<Source>;
  /** Caller's root: an Out there takes the urgent path. */
  readonly root: FiberRootLike | null;
  rerender = () => {};

  constructor(capture: Capture, root: FiberRootLike | null) {
    this.capture = capture;
    this.root = root;
    this.bridge = {} as ContextBridgeValue;
    captures.set(this.bridge, capture);
    this.readable = capture.readable;
  }
}

function createMember(fiber: Fiber | null) {
  if (fiber) {
    const top = topOf(fiber);
    const root =
      top.tag === HostRootTag ? (top.stateNode as FiberRootLike) : null;
    return new HostMember(captureAbove(fiber), root);
  }
  if (isDevEnv && typeof window !== "undefined") {
    console.warn(missingFiberWarning);
  }
  return new HostMember(emptyCapture, null);
}

/** Captures the calling component's ancestor context for a nested root. */
export function useContextBridge(): ContextBridgeValue {
  const fiber = useMountFiber();
  const [member] = useState(() => createMember(fiber));
  const [, rerender] = useReducer(increment, 0);
  member.rerender = rerender;

  useSourceReads(
    member.capture.path.filter((source) => source.owner === member),
    member.root,
    alwaysTransitions,
  );
  useLayoutEffect(() => {
    join(member, member.capture.path);
    return () => leave(member, member.capture.path);
  }, [member]);

  return member.bridge;
}

/** Props of {@link ContextBridge}. */
export interface ContextBridgeProps {
  /** From {@link useContextBridge}. */
  bridge: ContextBridgeValue;
  children: ReactNode;
}

/** Renders children under a captured bridge, in another root. */
export function ContextBridge({ bridge, children }: ContextBridgeProps) {
  const { path, strict } = captures.get(bridge) ?? emptyCapture;
  let node = strict ? <StrictMode>{children}</StrictMode> : children;
  for (let i = path.length - 1; i >= 0; i--) {
    node = (
      <SourceProvider key={path[i].id} source={path[i]}>
        {node}
      </SourceProvider>
    );
  }
  return <>{node}</>;
}
