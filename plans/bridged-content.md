# Plan: bridged content across renderers

pixi-three bridges every tunnel between react-dom, @pixi/react and r3f;
a11y-tree tunnels from inside that content. These sections close the
gaps that surface.

## 1. Bridged content sits at its In (done)

A bridged In captures with `captureAbove(fiber, anchorContext)`, so
content at the Out sees the Out root's anchor. pixi-three's Out roots
(the pixi `Application`, r3f's root) are unanchored. A nested tunnel's In
inside bridged content (a11y-tree inside `CanvasView` content) resolves
to a path in the Out's root alone and has no order against Ins elsewhere;
dev warns "Tunnel Ins span React roots in undefined order".

### Decisions

- `ItemView` renders a bridged item's content under `FiberAnchorContext`
  with `{ fiber: In fiber, parent: In's anchor }`.
- `pathOf` treats that value like any anchor: the In fiber's root joins
  the path. A nested In inside content resolves through the In, then the
  In's anchors.
- `pathOf` skips an anchor above the listed position, replacing the
  same-root skip: an In in the Out's root joins the path.
- One value per In; it refreshes when the In's anchor context changes, as
  in `Anchor`. A refresh clears the item's cached element.
- A probe's content anchors at the probe's work-in-progress In fiber.
  Registration swaps in the committed fiber; nested Ins re-resolve on the
  context change.
- The In fiber is a path fiber: commit-hook move detection covers In
  moves for nested tunnels.
- Unbridged content sits at the Out, as before. `useContextBridge`
  carries anchors, as before.
- README: bridged content acts as a child of its In: context,
  StrictMode, suspensions, errors, and nested tunnel order.
- `FiberAnchor` docs: a root whose Ins all sit inside bridged content
  needs no anchor. The README keeps one rule: anchor nested roots.

### Tests

- orders a nested tunnel's In inside bridged content at the bridged In
- reorders nested content when its bridged In moves
- orders nested content through bridged Ins in three roots
- keeps unbridged content's nested Ins at the Out

## 2. Two secondary renderers share bridged providers

pixi-three's dev console logs React's "Detected multiple renderers
concurrently rendering the same context provider" on load and per bump.
The context is @pixi/react's application context. Bridged items also
push `FiberAnchorContext` in each Out's renderer; the repro covers it.

Both secondary renderers write `_currentValue2`. React warns when one
pushes a provider while the other holds it pushed. A root waiting on a
candidate unwinds (`use` → `SuspendedOnImmediate`) and holds nothing, so
waiting is ruled out. A two-reconciler repro of transitions and urgent
bumps logs no warning.

Hypothesis: a non-blocking render (the `useDeferredValue` follow-up, a
transition, a Suspense retry, the hidden-Activity canary) yields with
providers pushed; the other renderer renders the same context in the gap.
A yielded root then reads the other renderer's value.

### Sequencing

1. Instrument pixi-three's `/example/context-bridge`: at the warning,
   record which root is mid-render and its lanes.
2. Reproduce that interleaving in
   `fiber-tunnel.cross-reconciler.test.tsx` with two secondary
   reconciler instances.
3. Fix per the cause. Dev-only fallback: clear the renderer sigil on
   bridged contexts (its-fine's approach); it silences the warning and
   leaves wrong reads possible.

## 3. Content errors at the Out (done)

a11y-tree swaps its whole tree for a fallback when an item errors. A
bridged tunnel rethrows content errors at the In, inside the scene; the
renderer's boundary above the Out never fires.

### Decisions

- `FiberTunnelOptions.errors: "in" | "out"`, default `"in"`. `"out"`
  leaves out `ErrorForwarder`: errors rise from the Out, as in an
  unbridged tunnel. §6's `isolate` replaces it.
- Suspense, transitions, and StrictMode keep their In-side behavior.
- An error at the Out replaces every item under the Out's boundary.
- README: one line under context bridging.

### Tests

- rethrows an isolated content error at the boundary above the Out
- keeps the In's siblings mounted when content errors at the Out
- recovers content when the boundary above the Out resets
- surfaces a nested bridged tunnel's error at the outer Out's boundary

## 4. Bridged by default (done)

Bridged content acts as a child of its In, as users expect of a plain
wrapper.

### Decisions

- `bridge` defaults to `true`; `bridge: false` makes content a child of
  the Out.
- README lists only departures from a plain wrapper.
- Tests use the default; `bridge: false` only where they test unbridged
  behavior.

## 5. Provider groups at the Out

A bridged Out nests items under one `Group` per source. Two gaps:

- A provider above both the In and the Out renders consumers twice per
  change: React propagates the outer change through the `Group`, which
  still holds the old value.
- Items whose sources are distinct copies of one context (its-fine's
  bridge in @pixi/react and r3f roots) cannot interleave: each source's
  items render contiguously, out of tree order.

### Decisions

- The Out skips the `Group` of a source whose provider fiber is the
  Out's nearest native provider of that context, unless a rendered
  `Group` above already provides the context. `ContextBridge` sources
  keep their `Group`: `SourceProvider` renders committed values only.
- A native source a `Group` above shadows renders a `NativeGroup`:
  `OutGroups` reads the value with `use(context)` and passes it down, so
  the provider and its `Group` update in one render.
- An In inside bridged content captures its item's sources, then the
  providers between the item and the In. Providers above the Out stay
  out of nested tunnels. `useContextBridge` keeps the full capture:
  nested roots inside content read what the content reads.
- The Out leaves out detached items: an In unmounting as another mounts
  keeps its run.
- `groupedElements` groups contiguous runs: a source whose items
  interleave with others renders one `Group` per run. The first run
  keeps the key `g{id}`; later runs key by their first item. Dev warns
  once per tunnel that split content remounts when runs change and
  points to `ContextBridge`.

### Tests

- renders a consumer once when a provider above both the In and the Out
  changes
- renders the In's nearer provider over a provider the Out shares
- orders nested content with Ins outside it when the Out's root
  re-provides context
- keeps tree order when Ins under re-provided contexts interleave
- warns once when Ins under re-provided contexts interleave
- renders the nearest provider when nested providers of one context sit
  above both the In and the Out
- renders a consumer once when nested providers of one context above
  both the In and the Out change
- carries contexts above the Out into a nested root inside content
- keeps one provider group when an In unmounts as another mounts
- keeps a later run's content state when an earlier run splits

## 6. Isolated content (done)

a11y-tree renders a side output from inside the scene. Its content's
suspensions blank the scene's boundary above the In and hold scene
transitions.

### Decisions

- `FiberTunnelOptions.isolate: boolean`, default `false`, replaces
  `errors`.
- Isolated: content errors and suspensions resolve at the boundaries above
  the Out. `ItemView` leaves out `ErrorForwarder` and `Pending`; content
  renders in an `OutBoundary` (`<Suspense fallback={null}>`) that
  readiness gates count as completed. Transitions never wait for content.
- Context, StrictMode, nested order, and hiding follow the In.
- README: one Options line.

### Tests

- keeps the In's siblings visible while isolated content loads
- hides isolated content while its In's boundary shows a fallback
- commits a transition while isolated content loads
- commits a transition mount while isolated content loads

## Open

- `useContextBridge` needs a writable `Function.prototype.bind`; with
  frozen intrinsics it warns and bridges no context. A class capture in
  `FiberAnchor` (`{(bridge) => …}`) would work there.
- React events in bridged content bubble from the Out; `createPortal`
  bubbles them from the portal. Re-dispatching through the In would
  match.

## Version

- 0.3.0: sections 1, 3, 4, 5, and 6. Section 1 moves nested Ins inside
  bridged content from the Out's order to the In's. Section 4 changes
  the `bridge` default.
- Section 2 ships when its fix lands.
