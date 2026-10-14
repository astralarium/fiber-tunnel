import type { ReactElement, ReactNode } from "react";

import type { Fiber, MountPosition } from "./fiber";
import type { FiberAnchorValue } from "./fiber-anchor-context";
import type { Signal } from "./signal";
import type { Capture } from "./sources";
import type { FiberStep } from "./util";

/** Content status at the Out, forwarded to the In. */
export type ItemStatus =
  | { kind: "ready" }
  | { kind: "pending"; signal: Signal }
  | { kind: "error"; error: unknown };

export const readyStatus: ItemStatus = { kind: "ready" };

/** A transition mount's stand-in: the Out renders content before the In
 * commits. */
export interface Probe {
  /** The Out rendered the content without suspending. */
  ready: Signal;
  /** The In committed; the Out may commit. */
  release: Signal;
  position: MountPosition;
  /** `position.path` joined; key under the anchor. */
  positionKey: string;
  /** Key of the item standing in for the In. */
  itemKey: string;
  /** Committed fiber at the position when registered. */
  occupant: Fiber | undefined;
  /** The Out rendered the probe. */
  acked: boolean;
  /** Acknowledgement window, then readiness watchdog. */
  timer: ReturnType<typeof setTimeout> | null;
  expiry: ReturnType<typeof setTimeout> | null;
  /** Readiness re-arms by changed children. */
  rearms: number;
  /** Removed before its In committed. */
  dropped: boolean;
  /** Dev: the In's owner stack. */
  stack: string;
}

/** One In's content at the Out. */
export interface Item {
  /** Mount order. */
  id: number;
  /** React key at the Out; a probe's key carries over to its item. */
  key: string;
  /** Anchors above the In, outermost first, then the In (or a probe's
   * committed ancestor). */
  path: readonly FiberStep[];
  /** Probe: work-in-progress ranks below the last path level. */
  below: readonly number[] | null;
  children: ReactNode;
  /** Bridged content's anchor: the In (a probe's work-in-progress fiber)
   * under the In's anchor. */
  anchor: FiberAnchorValue;
  /** The In is hidden; content keeps its state. */
  hidden: boolean;
  /** The In unmounted; it hides, leaves, or remounts after the commit. */
  unmounted: boolean;
  /** Bridged: providers and StrictMode above the In. */
  capture: Capture;
  probe: Probe | null;
  status: ItemStatus;
  listeners: Set<() => void>;
  /** Cached Out element; null when stale. */
  element: ReactElement | null;
}

export function setStatus(item: Item, status: ItemStatus) {
  if (item.status === status) return;
  item.status = status;
  for (const listener of item.listeners) listener();
}
