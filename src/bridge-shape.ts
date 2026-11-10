import type { Context } from "react";

import { isDevEnv } from "./env";
import type { Capture } from "./sources";

declare const shapeBrand: unique symbol;

/** The contexts every bridge sharing it provides, and whether they
 * render in StrictMode, from {@link createContextBridgeShape}. Grows as
 * captures join. */
export interface ContextBridgeShape {
  readonly [shapeBrand]: true;
}

interface ShapeState {
  contexts: Set<Context<unknown>>;
  /** A strict capture joined. */
  strict: boolean;
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
    strict: false,
    listeners: new Set(),
    warned: false,
  });
  return shape;
}

/** The contexts `shape` holds. */
export function shapeContexts(shape: ContextBridgeShape) {
  return shapes.get(shape)!.contexts;
}

/** Whether `shape`'s bridges render StrictMode. */
export function shapeStrict(shape: ContextBridgeShape) {
  return shapes.get(shape)!.strict;
}

/** Adds `capture`'s contexts and StrictMode to `shape`; notifies its
 * bridges on growth. */
export function extendShape(shape: ContextBridgeShape, capture: Capture) {
  const state = shapes.get(shape)!;
  let grew = capture.strict && !state.strict;
  state.strict ||= capture.strict;
  for (const { context } of capture.path) {
    grew ||= !state.contexts.has(context);
    state.contexts.add(context);
  }
  if (!grew) return;
  if (isDevEnv && !state.warned && state.contexts.size > maxShapeContexts) {
    state.warned = true;
    console.warn(sizeWarning);
  }
  for (const listener of state.listeners) listener();
}

/** Calls `onGrow` when `shape` gains a context or StrictMode. */
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
