import { Component, type ReactNode } from "react";

import { installCommitHook } from "./commit-hook";
import { type ContextBridgeValue, ContextCapture } from "./context-bridge";
import {
  fiberOf,
  type FiberRootLike,
  HostRootTag,
  renderingFiberOf,
  topOf,
} from "./fiber";
import {
  FiberAnchorContext,
  type FiberAnchorValue,
} from "./fiber-anchor-context";

/** Props of {@link FiberAnchor}. */
export interface FiberAnchorProps {
  /** Host of a nested React root, e.g. an r3f `<Canvas>`. A function
   * receives a bridge for the root's children. */
  children: ReactNode | ((bridge: ContextBridgeValue) => ReactNode);
}

/** Class: reads its own fiber. */
class Anchor extends Component<FiberAnchorProps> {
  static contextType = FiberAnchorContext;
  declare context: FiberAnchorValue | null;
  value: FiberAnchorValue | null = null;

  hooked = false;

  render() {
    if (!this.hooked) {
      // Move detection in this root starts before the anchor commits.
      const fiber = renderingFiberOf(this);
      const top = fiber && topOf(fiber);
      if (top?.tag === HostRootTag) {
        installCommitHook(top.stateNode as FiberRootLike);
        this.hooked = true;
      }
    }
    if (!this.value || this.value.parent !== this.context) {
      this.value = { fiber: fiberOf(this), parent: this.context };
    }
    const { children } = this.props;
    return (
      <FiberAnchorContext value={this.value}>
        {typeof children === "function" ? (
          <ContextCapture>{children}</ContextCapture>
        ) : (
          children
        )}
      </FiberAnchorContext>
    );
  }
}

/**
 * Places a nested React root's tunnel content at this point in tree order.
 * Unanchored roots have no defined order.
 * One nested root per anchor; it must bridge context. Function children
 * receive a bridge: render the root's children in {@link ContextBridge} so
 * bridged Ins share the providers above the anchor. r3f's `<Canvas>`
 * copies context itself; bridge it as well when it holds Ins.
 *
 * A root whose Ins all sit inside bridged content needs no anchor: that
 * content orders at its In.
 *
 * Hiding it (Suspense, Activity) keeps the root's content in the Out.
 */
export function FiberAnchor(props: FiberAnchorProps) {
  return <Anchor {...props} />;
}
