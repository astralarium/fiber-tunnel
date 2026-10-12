# Plan: bridged content across renderers

pixi-three bridges every tunnel between react-dom, @pixi/react and r3f.
Three gaps surface.

## 1. Bridged content sits at its In

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
- One value per In; it refreshes when the In's anchor context changes, as
  in `Anchor`. A refresh clears the item's cached element.
- A probe's content anchors at the probe's work-in-progress In fiber.
  Registration swaps in the committed fiber; nested Ins re-resolve on the
  context change.
- The In fiber is a path fiber: commit-hook move detection covers In
  moves for nested tunnels.
- Unbridged content sits at the Out, as before. `useContextBridge`
  carries anchors, as before.
- README: nested tunnels inside bridged content order at the In. A
  nested root that receives content only through bridged tunnels needs
  no `FiberAnchor`.

### Tests

- orders a nested tunnel's In inside bridged content at the bridged In
- reorders nested content when its bridged In moves
- orders nested content through bridged Ins in three roots
- keeps unbridged content's nested Ins at the Out

## 2. Two secondary renderers share bridged providers

pixi-three's dev console logs React's "Detected multiple renderers
concurrently rendering the same context provider" on load and per bump.
The context is @pixi/react's application context.

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
  unbridged tunnel.
- Suspense, transitions, and StrictMode keep their In-side behavior.
- An error at the Out replaces every item under the Out's boundary.
- README: one line under context bridging.

### Tests

- rethrows a content error at the boundary above the Out when errors
  stay at the Out
- keeps the In's siblings mounted when content errors at the Out
- recovers content when the boundary above the Out resets
- surfaces a nested bridged tunnel's error at the outer Out's boundary

## Version

- 0.3.0: sections 1 and 3. Section 1 moves nested Ins inside bridged
  content from the Out's order to the In's.
- Section 2 ships when its fix lands.
