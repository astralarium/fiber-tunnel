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

@pixi/react bundles its own Scheduler, so its renders interleave with
r3f's mid-render, and both secondary renderers share one context slot.
React's warning stays: fiber-tunnel cannot prevent the interleaving.

Open: @pixi/react imports `scheduler` instead of bundling it (upstream).
