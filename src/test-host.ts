// Test host: a second reconciler instance with an in-memory host, like
// @pixi/react's bundled react-reconciler. Mutation mode; priority
// resolution mirrors r3f/@pixi/react (current priority, else window.event).

import type { ReactNode } from "react";
import Reconciler from "react-reconciler";
import {
  ConcurrentRoot,
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from "react-reconciler/constants";

export interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostChild[];
  hidden: boolean;
}
export interface HostText {
  text: string;
  hidden: boolean;
}
export type HostChild = HostNode | HostText;
export interface HostContainer {
  children: HostChild[];
}

function isText(node: HostContainer | HostChild): node is HostText {
  return "text" in node;
}

function append(parent: HostContainer | HostNode, child: HostChild) {
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
  parent.children.push(child);
}
function insertBefore(
  parent: HostContainer | HostNode,
  child: HostChild,
  before: HostChild,
) {
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
  const j = parent.children.indexOf(before);
  parent.children.splice(j, 0, child);
}
function removeChild(parent: HostContainer | HostNode, child: HostChild) {
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
}

const discreteEvents = new Set(["click", "keydown", "keyup", "pointerdown"]);
function eventPriority(event: Event | undefined) {
  if (!event) return DefaultEventPriority;
  if (discreteEvents.has(event.type)) return DiscreteEventPriority;
  if (event.type === "pointermove" || event.type === "scroll")
    return ContinuousEventPriority;
  return DefaultEventPriority;
}

let currentUpdatePriority = NoEventPriority;

/** Host commits, in order. */
export const hostLog: string[] = [];

const noop = () => {};
const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  supportsTestSelectors: false,
  isPrimaryRenderer: false,
  warnsIfNotActing: true,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getRootHostContext: () => ({}),
  getChildHostContext: (parent: unknown) => parent,
  getPublicInstance: (instance: HostChild) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container: HostContainer) => {
    hostLog.push(`host:commit ${textOf(container)}`);
  },
  clearContainer: (container: HostContainer) => {
    container.children.length = 0;
  },
  createInstance: (type: string, props: Record<string, unknown>): HostNode => ({
    type,
    props,
    children: [],
    hidden: false,
  }),
  createTextInstance: (text: string): HostText => ({ text, hidden: false }),
  appendInitialChild: append,
  appendChild: append,
  appendChildToContainer: append,
  insertBefore,
  insertInContainerBefore: insertBefore,
  removeChild,
  removeChildFromContainer: removeChild,
  finalizeInitialChildren: () => false,
  commitMount: noop,
  commitUpdate: (
    instance: HostNode,
    _type: string,
    _oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) => {
    instance.props = newProps;
  },
  commitTextUpdate: (instance: HostText, _old: string, next: string) => {
    instance.text = next;
  },
  shouldSetTextContent: () => false,
  resetTextContent: noop,
  hideInstance: (i: HostNode) => void (i.hidden = true),
  unhideInstance: (i: HostNode) => void (i.hidden = false),
  hideTextInstance: (i: HostText) => void (i.hidden = true),
  unhideTextInstance: (i: HostText) => void (i.hidden = false),
  detachDeletedInstance: noop,
  preparePortalMount: noop,
  prepareScopeUpdate: noop,
  getInstanceFromScope: () => null,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: noop,
  afterActiveInstanceBlur: noop,
  setCurrentUpdatePriority: (p: number) => void (currentUpdatePriority = p),
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () =>
    currentUpdatePriority !== NoEventPriority
      ? currentUpdatePriority
      : eventPriority(typeof window === "undefined" ? undefined : window.event),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback: noop,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for("react.context"),
    Provider: null,
    Consumer: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0,
  },
  resetFormInstance: noop,
  bindToConsole: (method: keyof Console, args: unknown[]) =>
    Function.prototype.bind.apply(
      console[method] as (...a: unknown[]) => void,
      [console, ...args] as [unknown, ...unknown[]],
    ),
  rendererVersion: "0.34.0",
  rendererPackageName: "fiber-tunnel-test-host",
  extraDevToolsConfig: null,
  isHiddenSubtree: () => false,
  hasInstanceChanged: () => false,
  hasInstanceAffectedParent: () => false,
  measureInstance: () => null,
  measureClonedInstance: () => null,
  wasInstanceInViewport: () => false,
  applyViewTransitionName: noop,
  restoreViewTransitionName: noop,
  cancelViewTransitionName: noop,
  cancelRootViewTransitionName: noop,
  restoreRootViewTransitionName: noop,
  cloneRootViewTransitionContainer: () => null,
  removeRootViewTransitionClone: noop,
  startViewTransition: () => false,
  startGestureTransition: () => null,
  stopViewTransition: noop,
  createViewTransitionInstance: () => null,
  suspendOnActiveViewTransition: noop,
  getCurrentGestureOffset: () => 0,
  createFragmentInstance: () => null,
  updateFragmentInstanceFiber: noop,
  commitNewChildToFragmentInstance: noop,
  deleteChildFromFragmentInstance: noop,
  setFocusIfFocusable: () => false,
  matchAccessibilityRole: () => false,
  getBoundingRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  getTextContent: () => "",
  setupIntersectionObserver: () => ({
    disconnect: noop,
    observe: noop,
    unobserve: noop,
  }),
  findFiberRoot: () => null,
};

/** One reconciler instance shared by every host root (like a renderer). */
export const hostReconciler = Reconciler(hostConfig);

/** Visible text of a host subtree. */
export function textOf(node: HostContainer | HostChild): string {
  if (isText(node)) return node.hidden ? "" : node.text;
  if ("hidden" in node && node.hidden) return "";
  return node.children.map(textOf).join("");
}

/** Visible nodes of a type, depth first. */
export function nodesOf(
  node: HostContainer | HostChild,
  type: string,
  out: HostNode[] = [],
): HostNode[] {
  if (isText(node)) return out;
  if ("type" in node && node.hidden) return out;
  if ("type" in node && node.type === type) out.push(node);
  for (const c of node.children) nodesOf(c, type, out);
  return out;
}

export interface HostRoot {
  container: HostContainer;
  fiberRoot: ReturnType<typeof hostReconciler.createContainer>;
  render(element: ReactNode): void;
  unmount(): void;
  text(): string;
  buttons(): string[];
}

export function createHostRoot(): HostRoot {
  const container: HostContainer = { children: [] };
  const fiberRoot = hostReconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    (error) => {
      throw error;
    },
    (error) => console.error(error),
    noop,
    null,
  );
  return {
    container,
    fiberRoot,
    render(element) {
      hostReconciler.updateContainer(element, fiberRoot, null, null);
    },
    unmount() {
      hostReconciler.updateContainer(null, fiberRoot, null, null);
    },
    text: () => textOf(container),
    buttons: () => nodesOf(container, "button").map(textOf),
  };
}
