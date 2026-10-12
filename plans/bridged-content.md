# Plan: bridged content across renderers

Priorities: performance, then correctness, then complexity kept inside
fiber-tunnel. The README lists only departures from a plain wrapper and
keeps one rule: anchor nested roots.

## 1. Release 0.4.0

Unreleased: `FiberAnchor` function children (`{(bridge) => …}`) capture
bridges; `useContextBridge` and its `bind` patch are removed (breaking).

Open: release order.

- A: hold 0.4.0; pixi-three migrates ThreeRoot and releases once,
  peering `^0.4.0`; a11y-tree peers `^0.3.0 || ^0.4.0`.
- B: pixi-three releases for `^0.3.0` now, again for `^0.4.0`.

## 2. Downstream adoption

1. pixi-three releases a version that pairs with a11y-tree 0.5.0
   (0.3.0-alpha.7 peers fiber-tunnel `^0.2.0`).
2. eternal-engine bumps fiber-tunnel, a11y-tree `^0.5.0`, and pixi-three
   together.
3. tableau-perf against published prod builds: `loafMax`, commits per
   renderer, CHECK `orderOk`.

## 3. "Multiple renderers" warning

pixi-three logs React's "Detected multiple renderers concurrently
rendering the same context provider" for @pixi/react's application
context, native in `<Application>` and bridged into the r3f root by
ThreeRoot. One root yielded mid-render (non-blocking lanes only) with
the provider pushed while the other renderer pushed it. fiber-tunnel
adds non-blocking renders: `useSourceReads`' deferred follow-up,
candidate transitions, the canary, retries. its-fine nulled the check
on main.

1. pixi-three: un-silence main; record the clashing roots, their lanes,
   and the yielded render's stack.
2. Reproduce in `fiber-tunnel.cross-reconciler.test.tsx`, including a
   wrong-value read.
3. Fix: for the deferred follow-up, detect transitions with
   `renderLanesOf` and drop `useDeferredValue`; otherwise dev-only
   sigil nulling.

Ships in its own release.
