/* eslint-disable react-refresh/only-export-components */
import { type ReactNode, StrictMode } from "react";

import { type Capture, emptyCapture, SourceProvider } from "./sources";

declare const bridgeBrand: unique symbol;

/** Ancestor providers and StrictMode, captured at mount. Identity fixed. */
export interface ContextBridgeValue {
  readonly [bridgeBrand]: true;
}

/** Captures behind each bridge value. */
const captures = new WeakMap<ContextBridgeValue, Capture>();

/** A bridge value; {@link setBridgeCapture} attaches its capture. */
export function createBridge(): ContextBridgeValue {
  return {} as ContextBridgeValue;
}

/** Sets the providers and StrictMode a bridge carries. */
export function setBridgeCapture(bridge: ContextBridgeValue, capture: Capture) {
  captures.set(bridge, capture);
}

/** Props of {@link ContextBridge}. */
export interface ContextBridgeProps {
  /** From {@link FiberAnchor}'s function children. */
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
