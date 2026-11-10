import type { Context } from "react";

import { isDevEnv } from "./env";
import type { Capture } from "./sources";

declare const shapeBrand: unique symbol;

/** The contexts every bridge sharing it provides, from
 * {@link createContextBridgeShape}. Grows as captures join. */
export interface ContextBridgeShape {
  readonly [shapeBrand]: true;
}

interface ShapeState {
  contexts: Set<Context<unknown>>;
  /** Bridges re-rendering on growth. */
  listeners: Set<() => void>;
  /** Dev: the size warning fired. */
  warned: boolean;
}

const shapes = new WeakMap<ContextBridgeShape, ShapeState>();

/** Dev: contexts past which a shape warns. */
const maxShapeContexts = 64;

/** Dev warning: a shape holds more contexts than an app defines. */
const sizeWarning =
  `fiber-tunnel: a ContextBridgeShape holds over ${maxShapeContexts} ` +
  "contexts; each bridge provides them all. Create contexts once, outside " +
  "components.";

/** Creates a shape for bridges that swap between captures: a swap keeps
 * their children mounted. The shape holds its contexts while referenced;
 * scope it to the bridges' owner. */
export function createContextBridgeShape(): ContextBridgeShape {
  const shape = {} as ContextBridgeShape;
  shapes.set(shape, {
    contexts: new Set(),
    listeners: new Set(),
    warned: false,
  });
  return shape;
}

/** The contexts `shape` holds. */
export function shapeContexts(shape: ContextBridgeShape) {
  return shapes.get(shape)!.contexts;
}

/** Adds `capture`'s contexts to `shape`; notifies its bridges on
 * growth. */
export function extendShape(shape: ContextBridgeShape, capture: Capture) {
  const state = shapes.get(shape)!;
  const size = state.contexts.size;
  for (const source of capture.path) state.contexts.add(source.context);
  if (state.contexts.size === size) return;
  if (isDevEnv && !state.warned && state.contexts.size > maxShapeContexts) {
    state.warned = true;
    console.warn(sizeWarning);
  }
  for (const listener of state.listeners) listener();
}

/** Calls `onGrow` when `shape` gains a context. */
export function subscribeShape(shape: ContextBridgeShape, onGrow: () => void) {
  shapes.get(shape)!.listeners.add(onGrow);
}

/** Removes an `onGrow` from {@link subscribeShape}. */
export function unsubscribeShape(
  shape: ContextBridgeShape,
  onGrow: () => void,
) {
  shapes.get(shape)!.listeners.delete(onGrow);
}
