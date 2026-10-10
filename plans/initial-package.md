# Plan: initial `@astralarium/fiber-tunnel` package

Extract `fiberTunnel` from `@astralarium/a11y-tree` into this package,
shared by a11y-tree and pixi-three and offered upstream to tunnel-rat.

## Why

tunnel-rat re-renders every `In` on each `In` mount. `fiberTunnel` keys
entries per `In`, updates them in place, and sorts by fiber position.
In eternal-engine (dev, before anchors): hover-preview mount 926 → 462
ms, StrictMode reorder 634 → 335 ms.

## Scope

- Scaffold like `../a11y-tree`: vite library build, `tsc -b`, eslint,
  vitest, typedoc, `pnpm pack` into `pack/`, MIT, `CLAUDE.md`.
- Moved from a11y-tree: `fiber-tunnel.tsx`, `sortByFiberOrder`,
  `isDevEnv`, and the `fiberTunnel`, tunnel-ordering and StrictMode
  tests. Deleted: `isFiberLive`, `isFiberHidden`,
  `useIsomorphicLayoutEffect`.
- Public API: `fiberTunnel() → { In, Out, refresh }` (no options),
  `FiberTunnel`, `FiberTunnelInProps`, `FiberAnchor`, `FiberAnchorProps`,
  `sortByFiberOrder`.
- `In` and `FiberAnchor` read their own fiber from a class instance's
  `_reactInternals`: no `FiberProvider`, no its-fine dependency.
- `FiberAnchor` places a nested root's content at its tree position,
  carried by the root's context bridge. Each `In`'s path is enclosing
  anchors in other roots, then the `In`; `Out` sorts paths level by
  level, skipping levels all paths share.
- Contracts; violations are undefined behavior with dev diagnostics:
  - one `Out` per tunnel (dev error)
  - one anchor per nested root (dev warning when paths diverge across
    roots)
  - `refresh()` after reordering `In`s or anchors
- Documented limits: hiding an anchor (Suspense, Activity) keeps its
  root's content; content tunneled within one root sorts where its `In`
  renders.
- `Out` renders existing content in its mount commit; an `In`'s content
  arrives one commit after it mounts. Empty server snapshot.
- Diagnostics append `React.captureOwnerStack?.()` via the default React
  import (webpack rejects the missing named export in production React).
  `isDevEnv` is unguarded so bundlers drop dev code.
- Packaging: peer `react` ^19.2; rolled-up `index.d.ts` with top-level
  `main`/`types`; `"use client"` banner; `publishConfig.access: public`;
  `prepublishOnly` builds.
- README: install, example, short Behavior list, credit to tunnel-rat.

## Sequencing

1. Scaffold, move the code and tests; build, lint and tests pass.
2. Publish 0.1.0.
3. Consumers: a11y-tree (`../a11y-tree/plans/fiber-tunnel-package.md`),
   then pixi-three (`../pixi-three/plans/fiber-tunnel.md`).
