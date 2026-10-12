# FiberTunnel

React tunnel that renders content in fiber-tree order.

[Docs](https://astralarium.github.io/fiber-tunnel/)
| [Github](https://github.com/astralarium/fiber-tunnel)
| [NPM](https://www.npmjs.com/package/fiber-tunnel)

## Installation

```bash
npm i fiber-tunnel
```

Requires React 19.2 or later.
Supports Suspense and Activity.

## Usage

```tsx
import { Canvas } from "@react-three/fiber";
import { fiberTunnel } from "fiber-tunnel";

const overlay = fiberTunnel();

function Card({ name }: { name: string }) {
  return (
    <mesh>
      <overlay.In>
        <li>{name}</li>
      </overlay.In>
    </mesh>
  );
}

function App() {
  return (
    <>
      <ul>
        <overlay.Out />
      </ul>
      <Canvas>
        <Card name="Ace" />
        <Card name="King" />
      </Canvas>
    </>
  );
}
```

`fiberTunnel()` returns `{ In, Out }`.
Create tunnels at module scope or in a component with `useState`.

## Behavior

Content inside an `In` renders as if the `In` were a plain wrapper;
its host output renders at the `Out`. Differences:

- Content commits after its `In`, before paint.
- An urgent suspend commits the `In`'s siblings once before the
  fallback shows.
- React events bubble from the `Out`.
- Content also reads contexts above the `Out` that the `In` lacks.
- The `Out` suspends once on mount to check its renderer;
  await `act` in tests.
- SSR renders empty `Out`s until hydration.

## Setup

- Mount only one `Out` per tunnel.
- Wrap each nested React root's host in `<FiberAnchor>`.
  Unanchored roots have no defined order.
- Inside nested roots, wrap `In`s in `ContextBridge`:

```tsx
import { ContextBridge, FiberAnchor, useContextBridge } from "fiber-tunnel";

function Scene({ children }: { children: ReactNode }) {
  const bridge = useContextBridge();
  return (
    <FiberAnchor>
      <Canvas>
        <ContextBridge bridge={bridge}>{children}</ContextBridge>
      </Canvas>
    </FiberAnchor>
  );
}
```

## Options

- `fiberTunnel({ bridge: false })`: content renders as a child of the
  `Out`: its context, boundaries, and nested tunnel order.
- `fiberTunnel({ isolate: true })`: content errors and suspensions
  surface at the `Out`; transitions proceed while content loads.

## Acknowledgements

Inspired by [tunnel-rat](https://github.com/pmndrs/tunnel-rat).
