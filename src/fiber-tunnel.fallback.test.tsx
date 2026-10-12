"use no memo";

import "@testing-library/jest-dom/vitest";

import { act, render, within } from "@testing-library/react";
import {
  createContext,
  Suspense,
  use,
  useContext,
  useState,
  useTransition,
} from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { fiberTunnel } from "./fiber-tunnel";
import { createSignal, type Signal } from "./signal";
import { mountDomRoot } from "./test-utils";

/** Switches for the module doubles below; every switch off is real. */
const doubles = vi.hoisted(() => ({
  /** `startTransition` drops its callback: the Out never renders it. */
  dropTransitions: false,
  /** The internals check reports drifted internals. */
  insaneInternals: false,
  /** Gates report every pass complete. */
  gatesAlwaysComplete: false,
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    startTransition: (scope: () => void) =>
      doubles.dropTransitions ? undefined : react.startTransition(scope),
  };
});

vi.mock("./fiber", async (importOriginal) => {
  const fiber = await importOriginal<typeof import("./fiber")>();
  return {
    ...fiber,
    internalsLookSane: (...args: Parameters<typeof fiber.internalsLookSane>) =>
      doubles.insaneInternals ? "failed" : fiber.internalsLookSane(...args),
    priorWorkCompleted: (
      ...args: Parameters<typeof fiber.priorWorkCompleted>
    ) => doubles.gatesAlwaysComplete || fiber.priorWorkCompleted(...args),
  };
});

afterEach(() => {
  doubles.dropTransitions = false;
  doubles.insaneInternals = false;
  doubles.gatesAlwaysComplete = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Collects `console.warn` messages. */
function spyWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mock.calls.map((args) => String(args[0]));
}

/** Keyed data that suspends until resolved; replays call `use()` too. */
function createResource<K>() {
  const signals = new Map<K, Signal>();
  const signalOf = (key: K) => {
    let signal = signals.get(key);
    if (!signal) signals.set(key, (signal = createSignal()));
    return signal;
  };
  return {
    useData: (key: K) => use(signalOf(key).thenable),
    resolve: (key: K) => signalOf(key).resolve(),
  };
}

/** A value provided above one In under a Suspense boundary; content loads
 * per value. The Out renders in its own root. */
async function setupUpdateApp() {
  const tunnel = fiberTunnel();
  const Value = createContext(0);
  const data = createResource<number>();
  data.resolve(1);

  function Content() {
    const v = useContext(Value);
    data.useData(v);
    return <button>content {v}</button>;
  }

  let setValue!: (v: number) => void;
  let start!: (fn: () => void) => void;
  function App() {
    const [v, set] = useState(1);
    const [pending, startTransition] = useTransition();
    setValue = set;
    start = startTransition;
    return (
      <Value value={v}>
        <Suspense fallback={<p>loading</p>}>
          <tunnel.In>
            <Content />
          </tunnel.In>
        </Suspense>
        <output>
          {v}
          {pending ? " pending" : ""}
        </output>
      </Value>
    );
  }

  const primary = render(<App />);
  const out = await mountDomRoot(<tunnel.Out />);
  await act(async () => {});
  return {
    data,
    primary: primary.container,
    output: () => primary.container.querySelector("output")!.textContent,
    out: out.container,
    transition: (v: number) => start(() => setValue(v)),
  };
}

/** Publishes after commit: the primary commits at once and content's
 * suspension shows the fallback above the In. */
async function expectPublishAfterCommit(
  app: Awaited<ReturnType<typeof setupUpdateApp>>,
) {
  await act(async () => app.transition(2));
  expect(app.output()).toBe("2");
  expect(app.primary).toHaveTextContent("loading");

  await act(async () => app.data.resolve(2));
  expect(app.primary).not.toHaveTextContent("loading");
  expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
}

describe("transitions", () => {
  test("commits unverified when the Out never acknowledges a candidate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warnings = spyWarn();
    const app = await setupUpdateApp();
    doubles.dropTransitions = true;
    await act(async () => app.transition(2));
    await act(async () => void vi.advanceTimersByTime(999));
    expect(app.output()).toBe("1 pending");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 1");

    await act(async () => void vi.advanceTimersByTime(1));
    expect(app.output()).toBe("2");
    expect(app.primary).toHaveTextContent("loading");
    expect(warnings()).toEqual([
      expect.stringContaining("did not render a transition's value"),
    ]);

    await act(async () => app.data.resolve(2));
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
  });

  test("publishes after commit when the internals check fails", async () => {
    const warnings = spyWarn();
    doubles.insaneInternals = true;
    const app = await setupUpdateApp();
    expect(warnings()).toEqual([
      expect.stringContaining("the internals check failed"),
    ]);
    await expectPublishAfterCommit(app);
  });

  test("publishes after commit when the canary fails", async () => {
    const warnings = spyWarn();
    doubles.gatesAlwaysComplete = true;
    const app = await setupUpdateApp();
    expect(warnings()).toEqual([
      expect.stringContaining("the Out's canary failed"),
    ]);
    await expectPublishAfterCommit(app);
  });
});
