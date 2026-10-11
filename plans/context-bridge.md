# Plan: context bridging

A bridged tunnel carries React context from each In to its content at the
Out. Content in another renderer reads providers above its In as if it
rendered there. One provider instance per source serves every In below it.
Content errors, suspensions, and transitions surface at the In, following
React's boundary patterns.

## Why

pixi-three bridges context into secondary renderers. At its HEAD, each In
wraps its content in a full provider chain. Any value change above a
texture re-renders every bridge: 383 ms per unread bump at 384 textures
(dev build; pixi commit 224 ms, r3f 38 ms, Out re-sort 25 ms).

pixi-three's working tree fixes this with its own source ownership and
`bridgeTunnel` (15 ms), at the cost of fiber order and 271 lines of
untested tunnel and ownership code. This plan moves that work into
fiber-tunnel.

Priorities: performance, then pixi-three's users, then pixi-three's
maintainers. Complexity lives in fiber-tunnel.

## API

```ts
/** Options of {@link fiberTunnel}. */
export interface FiberTunnelOptions {
  /** Ins carry their ancestor context and StrictMode to the Out;
   * content errors, suspensions, and transitions surface at the In. */
  bridge?: boolean;
}

export function fiberTunnel(options?: FiberTunnelOptions): FiberTunnel;

/** Ancestor providers and StrictMode, captured at mount. Identity fixed. */
export interface ContextBridgeValue {}

/** Captures the calling component's ancestor context for a nested root. */
export function useContextBridge(): ContextBridgeValue;

/** Renders children under a captured bridge, in another root. */
export function ContextBridge(props: {
  bridge: ContextBridgeValue;
  children: ReactNode;
}): ReactNode;
```

Additive, except hiding: every tunnel keeps a hidden In's content.

## Decisions

### Sources

- One source per provider fiber, in a module `WeakMap` keyed by fiber and
  alternate. Every tunnel shares it.
- An In captures its path at mount: every provider fiber above it in its
  own root, outermost first, shadowed providers included.
- Providers rendered by a bridge resolve to their upstream source. Nested
  roots share one source per original provider.
- A source starts with its provider fiber's value. Content's first render
  sees the real value.
- Every context is bridged. Providers inside content override bridged ones
  (pixi-three's leaf `FiberProvider`).

### Reading

- A source's owner is its first member that sees it as the nearest provider
  of its context. Shadowed-only sources have no owner; an inner group
  overrides them.
- A bridged In renders one null `SourceReader` per owned source. The reader
  calls `use(context)`. A value change re-renders one reader per provider.
- The reader classifies each change with `useDeferredValue(value)`: equal
  to `value` in a transition render, lagging in an urgent one.
- `useContextBridge` reads owned sources inline; its host re-renders.
- Join and leave run in class lifecycles. A hidden owner leaves; the next
  member re-renders and reads.
- The Out's provider holds two sequence-stamped values; the newer wins:
  - committed: a store read with `useSyncExternalStore`. A store emit
    renders at SyncLane in any reconciler and flushes in the microtask
    after the primary's commit, before paint.
  - candidate: state set inside `startTransition`.
- After every commit, the reader's layout effect publishes the committed
  value to the store.

### Transitions

- A reader in a transition render starts a candidate render at the Out,
  once per value, then calls `use(ready)`. The primary stays on its
  previous UI with `isPending` true.
- A gate class renders last under the Out's provider, inside its own
  committed `Suspense` (fallback null). It inspects the work-in-progress
  fibers rendered before it under the provider: an `Incomplete` flag or a
  Suspense fiber newly in fallback means not ready. React renders past
  suspensions in the same pass, so readiness comes from fibers, never from
  render order.
- The gate fails open: only positive evidence means not ready. Unknown
  tags, missing fields, or unexpected shapes count as ready, so drifted
  internals degrade to the urgent path.
- The Out's provider acknowledges each candidate it renders. An
  acknowledged wait is a real load and waits as React does.
- Ready: the gate resolves `ready`, then calls `use(release)`, holding the
  Out's commit.
- The primary retries and commits. The reader's layout effect resolves
  `release` and publishes the committed value; both roots show the new
  value before paint.
- An urgent change publishes after commit; suspending content forwards its
  status (Items).

### Mounts

- An In classifies its mount pass from a freshly created sibling fiber's
  `lanes`, which carry the pass's render lanes until that fiber begins.
- A transition mount registers a probe item at the Out during render, keyed
  by position: the index and key path from the In up to its nearest
  committed ancestor, stored under both of that ancestor's generations.
  Every restarted pass finds the same probe.
- Each pass updates the probe's children; changed children re-arm
  readiness.
- The Out renders a probe as `Suspense` (fallback null) › content › item
  gate. The Out acknowledges the probe when it renders it. The item gate
  fails open, resolves `ready`, and holds on `release`, as the provider
  gate does.
- `componentDidMount` turns the probe into the real item under the same
  key; its fibers and host instances stay.
- An urgent mount registers on commit, as today; suspending content
  forwards its status. A mount inside a boundary already showing its
  fallback classifies urgent.

### Expiry and watchdog

- Structural signals release first, immediately:
  - `ready`: no Out mounted, the Out unmounts, or the Out is hidden.
  - Probes: the anchor detaches, or the anchor commits without an In at
    the probe's position.
- Timers use `setTimeout`, outside both reconcilers, in every build. Their
  writes go through the store.
- Acknowledgement window, 1 s: armed when a reader or In first suspends on
  `ready`. A candidate or probe the Out has not acknowledged by then
  releases `ready` unverified.
- Readiness watchdog, 10 s: armed at acknowledgement. Timeout releases
  `ready` unverified.
- Unverified release: the update commits as an urgent one and forwards
  content status.
- Probe expiry, 60 s: armed at registration, re-armed by each restarted
  pass, cleared on commit. Expiry removes the probe and resolves its
  signals.
- Dev: a missed acknowledgement, a watchdog timeout, or an expiry warns
  with the In's owner stack.

### Internals

- Fiber fields: `return`, `child`, `sibling`, `alternate`, `stateNode`,
  `tag`, `index`, `key`, `flags`, `lanes`, `memoizedState`, `pendingProps`.
  Constants: `Incomplete` flag, Suspense/Offscreen/ContextProvider/HostRoot
  tags, lane masks. Identical in React 19.2 and 19.3.
- FiberRoot lane fields serve sanity checks only.
- Sanity check on first use: the rendering fiber resolves, root lane fields
  are numbers, the class tag matches, a fresh sibling's lanes are a nonzero
  subset of `root.pendingLanes`, and the sibling-lane classification agrees
  with the root's next lanes.
- Microtask check at Out mount: a store emit from a layout effect commits
  before a queued microtask.
- Canary at Out mount, in the Out's own reconciler: a hidden item suspends
  on a tunnel-owned promise. The gate must report it not ready, then ready
  once the promise resolves; a lane read in that pass must classify
  correctly.
- A failed check switches the tunnel to publish-after-commit: transitions
  and mounts follow the urgent path.
- Probe and gate components are classes; function components carry
  `"use no memo"`. Render-phase work is idempotent per value and position
  key, so StrictMode double renders reuse it.
- `use()` runs unconditionally on every path that suspended once: React
  replays a suspended component and requires the same call.

### Hiding (all tunnels)

- `componentWillUnmount` marks the item hidden and checks after commit: a
  detached fiber removes the item; an attached one keeps it. Attached:
  the `return` chain reaches a HostRoot. Deletion nulls the deleted
  subtree's top `return` in the mutation phase.
- The Out renders hidden items under `<Activity mode="hidden">`. Content
  keeps its state; its effects disconnect.
- `componentDidMount` on the same instance shows the item.

### Groups (internal)

- Each source owns one group: a wrapper rendering its provider and gate.
- The Out nests content by group prefix. Ins with equal leading sources
  share those provider instances.
- Group keys: one per-tunnel `WeakMap` of source ids, namespaced apart from
  item ids.
- Siblings at each level sort by their earliest item in fiber order: one
  pass over the flat sorted list. With shadowed providers as levels, this
  equals flat fiber order.
- Each item caches its element per `children` identity. A group reuses its
  element while its ordered child elements are identical.
- A group with no items unmounts.

### Items (bridged)

- Each item renders: error forwarder › `Suspense` (fallback `Pending`) ›
  StrictMode when its In had it › content.
- Each item has a status: ready, pending, or error. The In renders a
  `Status` child: error throws; pending calls `use(promise)`. The user's
  boundary above the In catches either.
- The forwarder catches a content error and sets the error status.
- `Pending`'s layout effect creates the promise and sets the pending
  status; its cleanup resolves the promise.
- While the In suspends on its own item, the item stays visible at the
  Out, so its content keeps loading.

### Sorting

- Sort key: per path level, each chain fiber's rank among its parent's
  current children, root down to the step's fiber. `index` misorders:
  Suspense's primary Offscreen and fallback Fragment both carry 0.
- A fiber's parent is fixed for its lifetime, so `return` from either
  generation yields the logical chain. Descent finds current
  generations: `root.current`, then each chain fiber's match (fiber or
  alternate) in its current parent's child list. The scan yields the
  rank.
- A parent whose scan passes 32 children gets a rank map for the rest of
  the pass. Cost follows items × depth; root size drops out. 384 Ins in
  6.5k fibers: 0.3 ms; the whole-root walk takes 0.5–1 ms, 2–6 ms with
  20k fibers before the last In.
- Keys replace the whole-root walk; `sortByFiberOrder` uses them too.
- Keys compute in the Out's render, once per render. The store snapshot
  stays the item list: `getSnapshot` runs on every emit, so a batch of
  384 mounts sorts once.
- Every Out render recomputes all keys and sorts. Any emit corrects any
  earlier move. Unresolvable keys sort last.
- Every In update checks its own position: `componentDidUpdate` computes
  its key and compares it with its neighbors in the last sorted list. Out
  of order emits; in order costs one path.
- A moved component re-renders when its list builds fresh elements; React
  Compiler skips `memo`. An In whose element its wrapper builds uncached
  (`"use no memo"`) re-renders with it, so the move reaches the check.
- A move that re-renders no In reorders its content at the next emit or
  `refresh()`: a moved ancestor that memoizes its children, or reordered
  element objects held in state. Lifecycles, refs, and flags stay silent
  there; the DevTools hook fires but must load before react-dom.
- A probe's key is its anchor's key, then its work-in-progress rank path
  below the anchor; it precedes a committed item with an equal key. A
  pass that also moves committed siblings orders the probe at commit,
  when it re-keys as a real item.
- Hidden items keep their keys: an `Activity`-hidden In holds its
  position; Suspense's hidden primary ranks before its fallback.
- Groups rebuild from the flat sorted list each render; element caching
  keeps unchanged groups.

### Unchanged

- Registration timing for urgent mounts, SSR, `FiberAnchor`, `refresh`,
  and dev warnings.

### Version

- 0.2.0. Peer range stays `^19.2.0`; the internals checks guard later
  versions.

## Behavior (README)

- Content reads providers above its In; updates re-render only consumers.
- Suspense and error boundaries above the In catch content.
- A transition waits for content in both roots: previous UI stays,
  `isPending` holds, and both commit before paint.
- A hidden In keeps its content's state.
- An urgent mount whose content suspends commits the In's siblings once
  before the fallback shows.
- Promises come from a cache outside the suspending component, as in React.
- Content follows a moved In when the In re-renders. Components that
  render an In build its element uncached (`"use no memo"`), so moving
  them re-renders it.
- Moves that re-render no In (a memoized ancestor, reordered element
  objects) reorder content at the next tunnel change or `refresh()`.
- Transition handling reads React internals, verified on 19.2 and 19.3.
  Elsewhere the tunnel publishes after commit: transitions show fallbacks.

## Tests

`src/fiber-tunnel.test.tsx`, new `describe("bridge")`:

- renders content with context provided above its In
- re-renders only consumers when a bridged value changes
- re-renders one reader per provider when a value changes
- renders content's first render with the provider's current value
- renders one provider instance for Ins under the same provider
- keeps content state and DOM when another In joins or leaves its provider
- keeps an unchanged provider from re-rendering when an unrelated In mounts
- unmounts a provider when its last In unmounts
- orders content in fiber order when an inner provider shadows an outer one
- hands reading to the next In when the owner unmounts
- hands reading to the next In when Activity hides the owner
- shares sources across nested roots through a bridge
- applies StrictMode to content whose In renders under StrictMode
- rethrows a content error at its In for the boundary above it
- shows the fallback above an In while its content loads
- shows content when its suspension resolves
- keeps content state when content suspends after showing
- shows the fallback when an urgent update suspends content
- keeps bridged content under StrictMode replays
- renders `ContextBridge` children with the captured context

`describe("transitions")`:

- keeps the primary pending until the Out can render the new value
- commits the primary, then the Out, before paint
- starts one candidate render per value
- keeps the previous page during a transition mount until content is ready
- registers one probe across restarted mount passes
- keeps the probe's fibers when it becomes the real item
- re-arms readiness when a restarted pass changes the probe's children
- expires a probe whose mount pass never commits
- drops a probe whose anchor commits without its In
- commits unverified when readiness times out
- commits unverified when the Out never acknowledges a candidate
- commits unverified while the Out is hidden
- waits past the acknowledgement window while acknowledged content loads
- reports ready when the gate meets an unrecognized fiber shape
- publishes after commit when the internals check fails
- publishes after commit when the canary fails
- warns in dev when the readiness watchdog fires
- warns in dev when a probe expires
- classifies a mount inside a retrying boundary as urgent

`src/fiber-tunnel.cross-reconciler.test.tsx`: react-dom primary, Out in a
second `react-reconciler` instance with an in-memory host:

- carries a transition from the primary's render into the Out's reconciler
- commits the store publish at the Out before the primary's passive effects
- keeps the previous page during a transition mount
- shows fallbacks on an urgent mount

`describe("hiding")`:

- keeps content state while Activity hides its In
- keeps content state while Suspense hides its In
- removes content when its In unmounts

`describe("sort")`:

- orders content by current positions after a parent bails out
- reorders content when a re-sorted list re-renders its In without
  changing its children
- reorders content moved under a memoized ancestor at the next emit
- skips the Out's render when an In re-renders unmoved with the same children
- reorders content when an In's children change after a reorder
- places a probe by its anchor's position before it commits
- orders a probe at commit when its pass also moves committed siblings
- keeps an `Activity`-hidden In's content in position
- orders a hidden primary before its Suspense fallback
- drops an item whose subtree was deleted while hidden
- orders a nested root's content by its anchor, then its own position
- sorts once per Out render when many Ins mount in one commit

## Sequencing

1. fiber-tunnel:
   - Dev dependency `react-reconciler` (0.34 for React 19.3, 0.33 for 19.2).
   - Hiding, bridge, groups, status forwarding, transitions, mounts,
     expiry and watchdog, internals checks, sort keys, tests, README.
   - CI matrix: React 19.2 and 19.3, and the `react-reconciler` versions
     bundled by @pixi/react and r3f. Scheduled run against React canary
     releases.
   - Release 0.2.0.
2. pixi-three (`plans/bridge-sources.md`):
   - Peer and dev dependency `fiber-tunnel` → `^0.2.0`.
   - Tunnels: `fiberTunnel({ bridge: true })`. Content wraps in
     `FiberProvider` inside the In.
   - Components that render an In (`ThreeScene`, textures) build its
     element uncached (`"use no memo"` helper).
   - `ThreeRoot`: `useContextBridge` + `ContextBridge`.
   - Delete `bridge-source.ts`, `bridge-tunnel.tsx`, `use-bridge.ts`, and
     `Bridge`/`BridgeProvider`/`BridgeLeaf`. Types stay `FiberTunnel`.
   - Check the unbridged In in `pixi-texture.tsx` (parent scene tunnel)
     under a bridged tunnel.
   - Measure `/example/context-bridge?tiles=384`: unread bump ≈ 2 ms React
     work; split the Out's re-sort from its reconciliation. Also a
     texture mount, a texture props update, a transition bump, and a
     re-sort of the tiles.
3. a11y-tree:
   - Peer and dev dependency `fiber-tunnel` → `^0.2.0`.
   - Replace its-fine's `useContextBridge` in `A11yTreeSlotGroup`,
     `A11yTreeSlot`, and `A11yTreeElement` with bridged tunnels.
   - Those components build their In elements uncached (`"use no memo"`
     helper).
4. eternal-engine: bump fiber-tunnel, pixi-three, and a11y-tree; run
   `docs/skills/tableau-perf`.
