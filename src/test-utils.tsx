"use no memo";
// Test helpers shared by the suites.
import { act, screen } from "@testing-library/react";
import { type ReactNode, use } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect } from "vitest";

import { type FiberTunnel, transitionsWait } from "./fiber-tunnel";
import { createSignal, type Signal } from "./signal";
import { createHostRoot, type HostRoot } from "./test-host";

/** Visible button labels in the document, in DOM order. */
export function buttonLabels() {
  return screen.queryAllByRole("button").map((button) => button.textContent);
}

/** Keyed data that suspends until resolved; like a Suspense data cache. */
export function createResource<K>() {
  const signals = new Map<K, Signal>();
  const signalOf = (key: K) => {
    let signal = signals.get(key);
    if (!signal) signals.set(key, (signal = createSignal()));
    return signal;
  };
  return {
    /** Suspends until `key` resolves. */
    useData(key: K) {
      // Unconditional: a replay after resolution must call use() again.
      use(signalOf(key).thenable);
    },
    resolve(key: K) {
      signalOf(key).resolve();
    },
  };
}

const domRoots = new Set<{ root: Root; container: HTMLElement }>();
const hostRoots = new Set<HostRoot>();
afterEach(() => {
  act(() => {
    for (const { root } of domRoots) root.unmount();
    for (const root of hostRoots) root.unmount();
  });
  for (const { container } of domRoots) container.remove();
  domRoots.clear();
  hostRoots.clear();
});

/** A second react-dom root, like a pixi or r3f canvas; unmounted after
 * each test. */
export async function mountDomRoot(ui: ReactNode, className = "out") {
  const container = document.createElement("div");
  container.className = className;
  document.body.appendChild(container);
  const root = createRoot(container);
  domRoots.add({ root, container });
  await act(async () => root.render(ui));
  return { root, container };
}

/** A root in a second reconciler instance; unmounted after each test. */
export async function mountHostRoot(ui: ReactNode) {
  const root = createHostRoot();
  hostRoots.add(root);
  await act(async () => root.render(ui));
  return root;
}

/** Flushes React work until the tunnel's Out passes its checks and
 * transitions wait for it. */
export async function settleOut(tunnel: FiberTunnel) {
  const end = Date.now() + 10_000;
  while (!transitionsWait(tunnel) && Date.now() < end) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  expect(transitionsWait(tunnel)).toBe(true);
}
