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

- Wrap each nested React root's host in `<FiberAnchor>`,
  e.g. `<FiberAnchor><Canvas>…</Canvas></FiberAnchor>`.
  Unanchored roots have no defined order.
- Mount only one `Out` per tunnel.
- SSR renders empty `Out`s until hydration.

## Context bridging

Bridge React context:

```tsx
const overlay = fiberTunnel({ bridge: true });
```

Bridged content renders with the context above the `In`.

Content errors rethrow at the `In`.
Use `fiberTunnel({ bridge: true, errors: "out" })`
to keep errors at the `Out`'s error boundary.

Inside nested roots, wrap bridged `In`s in `ContextBridge`:

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

## Acknowledgements

Inspired by [tunnel-rat](https://github.com/pmndrs/tunnel-rat).
