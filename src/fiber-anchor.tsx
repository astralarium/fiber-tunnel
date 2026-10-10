import { Component, type ReactNode } from "react";

import {
  FiberAnchorContext,
  type FiberAnchorValue,
} from "./fiber-anchor-context";
import { fiberOf } from "./util";

/** Props of {@link FiberAnchor}. */
export interface FiberAnchorProps {
  /** Host of a nested React root, e.g. an r3f `<Canvas>`. */
  children: ReactNode;
}

/** Class: reads its own fiber. */
class Anchor extends Component<FiberAnchorProps> {
  static contextType = FiberAnchorContext;
  declare context: FiberAnchorValue | null;
  value: FiberAnchorValue | null = null;

  render() {
    if (!this.value || this.value.parent !== this.context) {
      this.value = { fiber: fiberOf(this), parent: this.context };
    }
    return (
      <FiberAnchorContext value={this.value}>
        {this.props.children}
      </FiberAnchorContext>
    );
  }
}

/**
 * Places a nested React root's tunnel content at this point in tree order.
 * One nested root per anchor; it must bridge context (r3f's `<Canvas>`
 * does; otherwise use its-fine's `useContextBridge`).
 *
 * Moving the anchor needs the tunnel's `refresh()`. Hiding it (Suspense,
 * Activity) keeps the root's content in the Out.
 */
export function FiberAnchor(props: FiberAnchorProps) {
  return <Anchor {...props} />;
}
