// Default import: production React lacks captureOwnerStack; webpack
// rejects the missing named export.
import React, {
  Component,
  type ComponentType,
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { isDevEnv } from "./env";
import {
  FiberAnchorContext,
  type FiberAnchorValue,
} from "./fiber-anchor-context";
import {
  type Fiber,
  fiberOf,
  type FiberStep,
  getFiberRoot,
  sameFiber,
  sortByFiberPath,
} from "./util";

/** One In's registered content. */
interface FiberTunnelItem {
  /** Mount order. */
  id: number;
  /** Enclosing anchors in other roots, outermost first, then the In. */
  path: readonly FiberStep[];
  /** Rendered at the Out. */
  children: ReactNode;
}

/** Props of {@link FiberTunnel.In}. */
export interface FiberTunnelInProps {
  /** Rendered at the Out. */
  children: ReactNode;
}

/** A tunnel created by {@link fiberTunnel}. */
export interface FiberTunnel {
  /** Sends its children to the Out, one commit after mounting. */
  In: ComponentType<FiberTunnelInProps>;
  /** Renders the content. Mount one per tunnel: each Out renders a copy. */
  Out: () => ReactNode;
  /** Re-reads order from the fiber tree. Call after reordering Ins or
   * FiberAnchors. */
  refresh: () => void;
}

// Stable server snapshot for useSyncExternalStore.
const noItems: readonly never[] = [];
const getNoItems = () => noItems;

/** Dev error: extra Out mounted. */
const multipleOutsError = "Multiple tunnel Outs mounted; each renders a copy.";

/** Dev warning: Ins' paths diverge across roots. */
const multipleRootsWarning =
  "Tunnel Ins span React roots in undefined order. Wrap nested React roots " +
  "in FiberAnchor; nested roots must bridge context.";

/** Creates a tunnel: content from many Ins renders at one Out, in tree order. */
export function fiberTunnel(): FiberTunnel {
  const itemsById = new Map<number, FiberTunnelItem>();
  // Stable between emits; rebuilt lazily.
  let snapshot: readonly FiberTunnelItem[] | null = null;
  const listeners = new Set<() => void>();
  // useId is unique per root; Ins span roots.
  let nextId = 0;

  // Dev only.
  let mountedOuts = 0;
  let warnedRoots = false;

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  function getItems() {
    return (snapshot ??= [...itemsById.values()]);
  }

  // Skip anchors in an already-listed root: the inner position is finer.
  function pathOf(fiber: Fiber, anchor: FiberAnchorValue | null) {
    const path: FiberStep[] = [];
    let root = getFiberRoot(fiber);
    if (root) path.push({ fiber, root });
    for (let a = anchor; a; a = a.parent) {
      const anchorRoot = getFiberRoot(a.fiber);
      if (!anchorRoot || anchorRoot === root) continue;
      path.unshift({ fiber: a.fiber, root: anchorRoot });
      root = anchorRoot;
    }
    return path;
  }

  function emit() {
    snapshot = null;
    for (const listener of listeners) listener();
  }

  function upsert(
    id: number,
    children: ReactNode,
    fiber: Fiber,
    anchor: FiberAnchorValue | null,
  ) {
    const path = pathOf(fiber, anchor);
    if (isDevEnv && !warnedRoots && !itemsById.has(id)) {
      warnIfRootsMix(path);
    }
    itemsById.set(id, { id, path, children });
    emit();
  }

  // Paths that first differ in different roots have no defined order.
  function warnIfRootsMix(path: readonly FiberStep[]) {
    for (const item of itemsById.values()) {
      for (let i = 0; i < path.length && i < item.path.length; i++) {
        if (sameFiber(path[i].fiber, item.path[i].fiber)) continue;
        if (path[i].root === item.path[i].root) break;
        warnedRoots = true;
        console.warn(
          multipleRootsWarning + (React.captureOwnerStack?.() ?? ""),
        );
        return;
      }
    }
  }

  function remove(id: number) {
    itemsById.delete(id);
    emit();
  }

  function refresh() {
    emit();
  }

  // Class: reads its own fiber. Lifecycles run at layout timing,
  // StrictMode replays and hides included.
  class In extends Component<FiberTunnelInProps> {
    static contextType = FiberAnchorContext;
    declare context: FiberAnchorValue | null;
    id = nextId++;
    anchor: FiberAnchorValue | null = null;

    register() {
      this.anchor = this.context;
      upsert(this.id, this.props.children, fiberOf(this), this.anchor);
    }

    componentDidMount() {
      this.register();
    }

    componentDidUpdate(prev: FiberTunnelInProps) {
      if (
        prev.children !== this.props.children ||
        this.anchor !== this.context
      ) {
        this.register();
      }
    }

    componentWillUnmount() {
      remove(this.id);
    }

    render() {
      return null;
    }
  }

  function Out() {
    // Server HTML has no content; hydration must match.
    const current = useSyncExternalStore(subscribe, getItems, getNoItems);
    // Survives effect replays, so each Out errors once.
    const reportedRef = useRef(false);

    useLayoutEffect(() => {
      if (!isDevEnv) return;
      mountedOuts++;
      if (mountedOuts > 1 && !reportedRef.current) {
        reportedRef.current = true;
        console.error(multipleOutsError + (React.captureOwnerStack?.() ?? ""));
      }
      return () => void mountedOuts--;
    }, []);

    // Every render re-reads live fiber positions.
    const sorted = sortByFiberPath(
      current.map((item) => ({ item, path: item.path, order: item.id })),
    );
    return (
      <>
        {sorted.map((item) => (
          <Fragment key={item.id}>{item.children}</Fragment>
        ))}
      </>
    );
  }

  return { In, Out, refresh };
}
