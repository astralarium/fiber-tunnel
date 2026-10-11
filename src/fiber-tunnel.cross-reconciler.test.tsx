"use no memo";
// Primary in react-dom; Out in a second reconciler instance sharing the
// `react` package, like @pixi/react or r3f.
import "@testing-library/jest-dom/vitest";

import { act, render, screen } from "@testing-library/react";
import {
  Component,
  createContext,
  Suspense,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useTransition,
} from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";

import { renderingFiberOf, renderLanesOf } from "./fiber";
import { fiberTunnel, transitionsWait } from "./fiber-tunnel";
import { createHostRoot, type HostRoot } from "./test-host";
import { createResource, mountHostRoot, settleOut } from "./test-utils";

const ValueContext = createContext(0);

/** Sync, hydration, input-continuous, and default lanes. */
const urgentLanes = 0b111111;

/** Lanes of each pass rendering `value`, read from a fresh sibling. */
interface Pass {
  value: number;
  lanes: number | null;
}

/** A primary app providing a value above a bridged In; content reads the
 * value at the Out and suspends until its data resolves. */
function setupValueApp() {
  const t = fiberTunnel({ bridge: true });
  const resource = createResource<number>();
  resource.resolve(1);
  const passes: Pass[] = [];
  const timeline: string[] = [];
  let out: HostRoot | null = null;

  class LaneRecorder extends Component<{ value: number }> {
    render() {
      const fiber = renderingFiberOf(this);
      passes.push({
        value: this.props.value,
        lanes: fiber ? renderLanesOf(fiber) : null,
      });
      return null;
    }
  }
  function Data({ value }: { value: number }) {
    resource.useData(value);
    useLayoutEffect(() => {
      timeline.push(`O:layout ${value}`);
    }, [value]);
    return <button>content {value}</button>;
  }
  function Content() {
    const value = use(ValueContext);
    // Keyed by value: a fresh sibling carries each pass's lanes.
    return (
      <>
        <LaneRecorder value={value} />
        <Data key={value} value={value} />
      </>
    );
  }
  // Stable element: the In's children never change.
  const content = <Content />;

  let setValue!: (value: number) => void;
  let start!: (fn: () => void) => void;
  function App() {
    const [value, set] = useState(1);
    const [pending, startT] = useTransition();
    setValue = set;
    start = startT;
    useLayoutEffect(() => {
      timeline.push(`P:layout ${value}`);
      queueMicrotask(() => timeline.push(`P:microtask ${value}`));
    }, [value]);
    useEffect(() => {
      timeline.push(`P:passive ${value}`);
    }, [value]);
    return (
      <ValueContext value={value}>
        <t.In>{content}</t.In>
        <output>
          {value}
          {pending ? " pending" : ""}
        </output>
      </ValueContext>
    );
  }
  return {
    t,
    resource,
    passes,
    timeline,
    App,
    attachOut(root: HostRoot) {
      out = root;
    },
    outText: () => out?.text() ?? "",
    setValue: (value: number) => setValue(value),
    start: (fn: () => void) => start(fn),
  };
}

/** A primary app whose page switch mounts a bridged In with loading
 * content. */
function setupPageApp() {
  const t = fiberTunnel({ bridge: true });
  const resource = createResource<string>();
  let fallbacks = 0;
  function Fallback() {
    useLayoutEffect(() => {
      fallbacks++;
    }, []);
    return <p>loading</p>;
  }
  function Content() {
    resource.useData("b");
    return <button>content b</button>;
  }
  let setPage!: (page: string) => void;
  let start!: (fn: () => void) => void;
  function App() {
    const [page, set] = useState("a");
    const [, startT] = useTransition();
    setPage = set;
    start = startT;
    return (
      <Suspense fallback={<Fallback />}>
        {page === "a" ? (
          <h1>A</h1>
        ) : (
          <>
            <t.In>
              <Content />
            </t.In>
            <h1>B</h1>
          </>
        )}
      </Suspense>
    );
  }
  return {
    t,
    resource,
    App,
    fallbacks: () => fallbacks,
    setPage: (page: string) => setPage(page),
    start: (fn: () => void) => start(fn),
  };
}

/** Waits on real timers: microtasks and Scheduler tasks run as in a
 * browser. */
async function waitUntil(condition: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("cross-reconciler", () => {
  test("carries a transition from the primary's render into the Out's reconciler", async () => {
    const app = setupValueApp();
    const primary = render(<app.App />);
    const out = await mountHostRoot(<app.t.Out />);
    await settleOut(app.t);
    expect(out.buttons()).toEqual(["content 1"]);

    await act(async () => app.start(() => app.setValue(2)));
    expect(primary.container.textContent).toBe("1 pending");
    expect(out.buttons()).toEqual(["content 1"]);
    const first = app.passes.find((pass) => pass.value === 2);
    expect(first?.lanes).toBeTypeOf("number");
    // Sync through default lanes: bits 0-5 in every React 19 reconciler.
    // Transition lanes start above them; 19.2 shifted them by one bit.
    expect(first!.lanes! & urgentLanes).toBe(0);
    expect(first!.lanes).toBeGreaterThan(urgentLanes);

    await act(async () => app.resource.resolve(2));
    expect(primary.container.textContent).toBe("2");
    expect(out.buttons()).toEqual(["content 2"]);
  });

  test("commits the store publish at the Out before the primary's passive effects", async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const primary = createRoot(container);
    const out = createHostRoot();
    const app = setupValueApp();
    app.attachOut(out);
    /** Index of the first entry starting with `prefix`. */
    const at = (prefix: string) =>
      app.timeline.findIndex((entry) => entry.startsWith(prefix));
    try {
      primary.render(<app.App />);
      out.render(<app.t.Out />);
      await waitUntil(() => out.buttons().join() === "content 1");
      await waitUntil(() => transitionsWait(app.t));

      // Urgent: publishes after the primary's commit.
      app.resource.resolve(2);
      app.setValue(2);
      await waitUntil(() => at("P:passive 2") >= 0);
      expect(out.buttons()).toEqual(["content 2"]);
      expect(at("O:layout 2")).toBeGreaterThan(at("P:layout 2"));
      expect(at("O:layout 2")).toBeLessThan(at("P:microtask 2"));
      expect(at("O:layout 2")).toBeLessThan(at("P:passive 2"));

      // Transition: the Out holds its render until the primary commits.
      app.resource.resolve(3);
      app.start(() => app.setValue(3));
      await waitUntil(() => at("P:passive 3") >= 0);
      await waitUntil(() => at("O:layout 3") >= 0);
      expect(out.buttons()).toEqual(["content 3"]);
      expect(at("O:layout 3")).toBeGreaterThan(at("P:layout 3"));
      expect(at("O:layout 3")).toBeLessThan(at("P:microtask 3"));
      expect(at("O:layout 3")).toBeLessThan(at("P:passive 3"));
    } finally {
      primary.unmount();
      out.unmount();
      await waitUntil(() => out.text() === "");
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  test("keeps the previous page during a transition mount", async () => {
    const app = setupPageApp();
    const primary = render(<app.App />);
    const out = await mountHostRoot(<app.t.Out />);
    await settleOut(app.t);

    await act(async () => app.start(() => app.setPage("b")));
    expect(primary.container.textContent).toBe("A");
    expect(out.text()).toBe("");

    await act(async () => app.resource.resolve("b"));
    expect(primary.container.textContent).toBe("B");
    expect(out.buttons()).toEqual(["content b"]);
    expect(app.fallbacks()).toBe(0);
  });

  test("shows fallbacks on an urgent mount", async () => {
    const app = setupPageApp();
    const primary = render(<app.App />);
    const out = await mountHostRoot(<app.t.Out />);
    await settleOut(app.t);

    await act(async () => app.setPage("b"));
    expect(screen.getByText("loading")).toBeVisible();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(app.fallbacks()).toBe(1);
    expect(out.text()).toBe("");

    await act(async () => app.resource.resolve("b"));
    expect(primary.container.textContent).toBe("B");
    expect(out.buttons()).toEqual(["content b"]);
  });
});
