import { createContext } from "react";

import type { Fiber } from "./util";

/** A FiberAnchor's position, chained to the anchor above it. */
export interface FiberAnchorValue {
  /** Anchor fiber. */
  fiber: Fiber;
  /** Enclosing anchor. */
  parent: FiberAnchorValue | null;
}

/** Nearest FiberAnchor; crosses roots via context bridges. */
export const FiberAnchorContext = createContext<FiberAnchorValue | null>(null);
