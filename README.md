# FiberTunnel

React tunnel that renders content in fiber-tree order.

[Docs](https://astralarium.github.io/fiber-tunnel/)
| [Github](https://github.com/astralarium/fiber-tunnel)
| [NPM](https://www.npmjs.com/package/@astralarium/fiber-tunnel)

## Installation

```bash
npm i @astralarium/fiber-tunnel
```

Requires React 19.2 or later.

## Usage

```tsx
import { fiberTunnel } from "@astralarium/fiber-tunnel";
import { Canvas } from "@react-three/fiber";

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

`fiberTunnel()` returns `{ In, Out, refresh }`.
Create tunnels at module scope or in a component with `useState`.

## Behavior

- `Out` renders content in React tree order.
- Wrap each nested React root's host in `<FiberAnchor>`,
  e.g. `<FiberAnchor><Canvas>…</Canvas></FiberAnchor>`.
  Unanchored roots have no defined order.
- Updating an `In` updates content in place, preserving state and DOM.
- Mount only one `Out` per tunnel.
- Call `refresh()` after reordering `In`s or anchors.
- Content appears one commit after `In` mounts.
  `Out` mounted together with `In`s paints empty once.
  SSR renders empty `Out`s until hydration.

Inspired by [tunnel-rat](https://github.com/pmndrs/tunnel-rat).
