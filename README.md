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
its host output renders at the `Out`.
React events bubble from the `Out`.
SSR renders empty `Out`s until hydration.
Await `act` in tests: the `Out` suspends once on mount.

Mount only one `Out` per tunnel.

## Nested roots

Wrap nested React roots in `FiberAnchor`.
Pass the anchor's bridge to `ContextBridge` to share the outer providers.

```tsx
import { ContextBridge, FiberAnchor } from "fiber-tunnel";

function Scene({ children }: { children: ReactNode }) {
  return (
    <FiberAnchor>
      {(bridge) => (
        <Canvas>
          <ContextBridge bridge={bridge}>{children}</ContextBridge>
        </Canvas>
      )}
    </FiberAnchor>
  );
}
```

## Options

- `fiberTunnel({ bridge: false })`: content renders as a child of the `Out`.
- `fiberTunnel({ isolate: true })`: content errors and suspensions
  surface at the `Out`.

## Acknowledgements

Inspired by [tunnel-rat](https://github.com/pmndrs/tunnel-rat).
