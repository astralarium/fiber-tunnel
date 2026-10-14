"use no memo";

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FiberProvider, useContextBridge as useItsFineBridge } from "its-fine";
import {
  Activity,
  Component,
  createContext,
  createRef,
  memo,
  Profiler,
  type ReactElement,
  type ReactNode,
  type Ref,
  startTransition,
  StrictMode,
  Suspense,
  use,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ItemView } from "./bridge-views";
import {
  commitHookOf,
  forgetPathFiber,
  installCommitHook,
} from "./commit-hook";
import { ContextBridge, type ContextBridgeValue } from "./context-bridge";
import {
  type Fiber,
  type FiberRootLike,
  Incomplete,
  priorWorkCompleted,
} from "./fiber";
import { FiberAnchor } from "./fiber-anchor";
import {
  FiberAnchorContext,
  type FiberAnchorValue,
} from "./fiber-anchor-context";
import { type FiberTunnel, fiberTunnel } from "./fiber-tunnel";
import { SourceReader } from "./sources";
import {
  buttonLabels,
  createResource,
  mountDomRoot,
  mountHostRoot,
  settleOut,
} from "./test-utils";
import { sortByKey } from "./util";

vi.mock("./util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util")>();
  return { ...actual, sortByKey: vi.fn(actual.sortByKey) };
});

/** Button labels in DOM order, hidden ones included. */
function allLabels() {
  return screen
    .queryAllByRole("button", { hidden: true })
    .map((button) => button.textContent);
}

/** Single-shot Suspense gate: Gate suspends until resolve(). */
function createGate() {
  let resolved = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      resolved = true;
      r();
    };
  });
  function Gate({ suspended }: { suspended: boolean }) {
    if (suspended && !resolved) throw promise;
    return null;
  }
  return { Gate, resolve, promise };
}

/** An Out in a classed div. */
function LabeledOut({ tunnel, name }: { tunnel: FiberTunnel; name: string }) {
  return (
    <div className={name}>
      <tunnel.Out />
    </div>
  );
}

const childRoots = new Set<Root>();
afterEach(async () => {
  await act(async () => childRoots.forEach((root) => root.unmount()));
  childRoots.clear();
});

/** A separate React root that bridges context, like r3f's `<Canvas>`. */
function ChildRoot({ children }: { children: ReactNode }) {
  return (
    <FiberProvider>
      <ChildRootInner>{children}</ChildRootInner>
    </FiberProvider>
  );
}

function ChildRootInner({ children }: { children: ReactNode }) {
  const Bridge = useItsFineBridge();
  const rootRef = useRef<Root | null>(null);
  useLayoutEffect(() => {
    const root = createRoot(document.createElement("div"));
    rootRef.current = root;
    childRoots.add(root);
  }, []);
  useLayoutEffect(() => {
    rootRef.current?.render(<Bridge>{children}</Bridge>);
  });
  return null;
}

describe("fiberTunnel", () => {
  test("refresh re-reads order after a keyed reorder of memoized Ins while move detection is off", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    const MemoIn = memo(function MemoIn({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <>
          {order.map((label) => (
            <MemoIn key={label} label={label} />
          ))}
          <t.Out />
        </>
      );
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    // A non-configurable `current` blocks the commit hook.
    const fiberRoot = (root as unknown as { _internalRoot: object })
      ._internalRoot;
    Object.defineProperty(fiberRoot, "current", {
      configurable: false,
      writable: true,
      value: (fiberRoot as { current: unknown }).current,
    });

    await act(async () => root.render(<App order={["A", "B"]} />));
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("move detection is off"),
    );
    await act(async () => root.render(<App order={["B", "A"]} />));
    // Memoized Ins skip the move; the Out reads the previous tree.
    expect(buttonLabels()).toEqual(["A", "B"]);

    await act(async () => t.refresh());
    expect(buttonLabels()).toEqual(["B", "A"]);
    act(() => root.unmount());
    container.remove();
    consoleWarn.mockRestore();
  });

  test("removes an In's content when the In unmounts", async () => {
    const t = fiberTunnel();
    function App({ showFirst }: { showFirst: boolean }) {
      return (
        <>
          {showFirst && (
            <t.In>
              <button>First</button>
            </t.In>
          )}
          <t.In>
            <button>Second</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App showFirst={true} />);
    await flush();
    expect(buttonLabels()).toEqual(["First", "Second"]);
    await act(async () => rerender(<App showFirst={false} />));
    expect(buttonLabels()).toEqual(["Second"]);
  });

  test("keeps a Suspense-hidden In's content hidden in place and shows it on reveal", async () => {
    const t = fiberTunnel();
    const gate = createGate();
    function App({ suspended }: { suspended: boolean }) {
      return (
        <>
          <Suspense fallback={null}>
            <gate.Gate suspended={suspended} />
            <t.In>
              <button>First</button>
            </t.In>
          </Suspense>
          <t.In>
            <button>Second</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App suspended={false} />);
    const first = screen.getByRole("button", { name: "First" });
    await act(async () => rerender(<App suspended={true} />));
    expect(buttonLabels()).toEqual(["Second"]);
    expect(allLabels()).toEqual(["First", "Second"]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(buttonLabels()).toEqual(["First", "Second"]);
    expect(screen.getByRole("button", { name: "First" })).toBe(first);
  });

  test("keeps tunneled content's state and DOM when its In re-renders", async () => {
    const t = fiberTunnel();
    function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
    }
    function App({ label }: { label: string }) {
      return (
        <>
          <t.In>
            <span>{label}</span>
            <Counter />
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App label="One" />);
    await flush();
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await act(async () => rerender(<App label="Two" />));

    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBe(button);
    expect(button).toHaveTextContent("1");
  });
});

describe("tunnel ordering", () => {
  test("keeps item order when a tunneled item re-renders", async () => {
    const t = fiberTunnel();
    function CounterIn({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return (
        <t.In>
          <button onClick={() => setCount((c) => c + 1)}>
            {label} {count}
          </button>
        </t.In>
      );
    }

    render(
      <>
        <CounterIn label="First" />
        <CounterIn label="Second" />
        <CounterIn label="Third" />
        <t.Out />
      </>,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "First 0" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Second 0" }));
    await flush();

    expect(buttonLabels()).toEqual(["First 1", "Second 1", "Third 0"]);
  });

  test("keeps item order when items mount later", async () => {
    const t = fiberTunnel();
    function App({ showFirst }: { showFirst: boolean }) {
      return (
        <>
          {showFirst && (
            <t.In>
              <button>First</button>
            </t.In>
          )}
          <t.In>
            <button>Second</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App showFirst={false} />);
    await act(async () => rerender(<App showFirst={true} />));

    expect(buttonLabels()).toEqual(["First", "Second"]);
  });

  test("reorders memoized items on the commit that moves them", async () => {
    const t = fiberTunnel();
    const MemoIn = memo(function MemoIn({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });

    function Flusher() {
      const [count, setCount] = useState(0);
      return (
        <t.In>
          <button onClick={() => setCount((c) => c + 1)}>flush {count}</button>
        </t.In>
      );
    }

    function App({ order }: { order: string[] }) {
      return (
        <>
          {order.map((label) => (
            <MemoIn key={label} label={label} />
          ))}
          <Flusher />
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App order={["A", "B", "C"]} />);
    await act(async () => rerender(<App order={["C", "A", "B"]} />));
    expect(buttonLabels()).toEqual(["C", "A", "B", "flush 0"]);

    fireEvent.click(screen.getByRole("button", { name: "flush 0" }));
    expect(buttonLabels()).toEqual(["C", "A", "B", "flush 1"]);
  });
});

describe("Out", () => {
  test("renders existing content in the commit that mounts it", () => {
    const t = fiberTunnel();
    const seen: (string | null | undefined)[] = [];
    function LayoutProbe() {
      useLayoutEffect(() => {
        seen.push(document.querySelector(".out button")?.textContent);
      }, []);
      return null;
    }
    function App({ showOut }: { showOut: boolean }) {
      return (
        <>
          <t.In>
            <button>Tunneled</button>
          </t.In>
          {showOut && (
            <>
              <LabeledOut tunnel={t} name="out" />
              <LayoutProbe />
            </>
          )}
        </>
      );
    }

    const { rerender } = render(<App showOut={false} />);
    rerender(<App showOut={true} />);
    expect(seen).toEqual(["Tunneled"]);
  });

  test("keeps content state and DOM while Suspense hides the Out", async () => {
    const t = fiberTunnel();
    const gate = createGate();
    function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
    }
    function App({ suspended }: { suspended: boolean }) {
      return (
        <>
          <t.In>
            <Counter />
          </t.In>
          <Suspense fallback={null}>
            <gate.Gate suspended={suspended} />
            <t.Out />
          </Suspense>
        </>
      );
    }

    const { rerender } = render(<App suspended={false} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    rerender(<App suspended={true} />);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    expect(screen.getByRole("button")).toBe(button);
    expect(button).toHaveTextContent("1");
  });

  test("keeps content state and DOM while Activity hides the Out", async () => {
    const t = fiberTunnel();
    function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
    }
    function App({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <>
          <t.In>
            <Counter />
          </t.In>
          <Activity mode={mode}>
            <t.Out />
          </Activity>
        </>
      );
    }

    const { rerender } = render(<App mode="visible" />);
    await flush();
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await act(async () => rerender(<App mode="hidden" />));
    await act(async () => rerender(<App mode="visible" />));

    expect(screen.getByRole("button")).toBe(button);
    expect(button).toHaveTextContent("1");
  });

  test("hydrates server HTML without mismatch", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const t = fiberTunnel();
    const app = (
      <>
        <t.In>
          <button>Tunneled</button>
        </t.In>
        <div className="out">
          <t.Out />
        </div>
      </>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(app);
    document.body.append(container);

    const root = await act(async () => hydrateRoot(container, app));
    expect(container.querySelector(".out button")).toHaveTextContent(
      "Tunneled",
    );
    expect(consoleError).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });
});

describe("FiberAnchor", () => {
  test("orders content within one anchored child root", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    function App({ showFirst }: { showFirst: boolean }) {
      return (
        <>
          <FiberAnchor>
            <ChildRoot>
              {showFirst && (
                <t.In>
                  <button>First</button>
                </t.In>
              )}
              <t.In>
                <button>Second</button>
              </t.In>
            </ChildRoot>
          </FiberAnchor>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App showFirst={false} />);
    await act(async () => rerender(<App showFirst={true} />));
    expect(buttonLabels()).toEqual(["First", "Second"]);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test("warns when two child roots share one anchor", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <>
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <button>One</button>
            </t.In>
          </ChildRoot>
          <ChildRoot>
            <t.In>
              <button>Two</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.Out />
      </>,
    );

    expect(buttonLabels().sort()).toEqual(["One", "Two"]);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  test("warns when a root nested in an anchored root is unanchored", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel({ bridge: false });
    render(
      <>
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <button>B1</button>
            </t.In>
            <ChildRoot>
              <t.In>
                <button>C</button>
              </t.In>
            </ChildRoot>
            <t.In>
              <button>B2</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.Out />
      </>,
    );

    expect(buttonLabels().sort()).toEqual(["B1", "B2", "C"]);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  test("places a child root's content at the anchor's position", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <>
        <t.In>
          <button>Before</button>
        </t.In>
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <button>Inside</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.In>
          <button>After</button>
        </t.In>
        <t.Out />
      </>,
    );

    expect(buttonLabels()).toEqual(["Before", "Inside", "After"]);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test("warns once when Ins span an unanchored child root", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <>
        <t.In>
          <button>Before</button>
        </t.In>
        <ChildRoot>
          <t.In>
            <button>Inside</button>
          </t.In>
        </ChildRoot>
        <t.In>
          <button>After</button>
        </t.In>
        <t.Out />
      </>,
    );

    expect(buttonLabels().sort()).toEqual(["After", "Before", "Inside"]);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("FiberAnchor"),
    );
    consoleWarn.mockRestore();
  });

  test("chains nested anchors across roots", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <>
        <t.In>
          <button>A</button>
        </t.In>
        <NestedRoot>
          <t.In>
            <button>B1</button>
          </t.In>
          <NestedRoot>
            <t.In>
              <button>C</button>
            </t.In>
          </NestedRoot>
          <t.In>
            <button>B2</button>
          </t.In>
        </NestedRoot>
        <t.In>
          <button>D</button>
        </t.In>
        <t.Out />
      </>,
    );
    await flush();

    expect(buttonLabels()).toEqual(["A", "B1", "C", "B2", "D"]);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test("places a child root's content at the start of the anchor's subtree", () => {
    const t = fiberTunnel();
    render(
      <>
        <FiberAnchor>
          <t.In>
            <button>Sibling</button>
          </t.In>
          <ChildRoot>
            <t.In>
              <button>Inside</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.Out />
      </>,
    );

    expect(buttonLabels()).toEqual(["Inside", "Sibling"]);
  });
});

describe("multiple Outs", () => {
  test("each Out renders the content and dev errors with the extra Out's owner stack", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const t = fiberTunnel();
    const { container } = render(
      <>
        <t.In>
          <button>Tunneled</button>
        </t.In>
        <LabeledOut tunnel={t} name="out-a" />
        <LabeledOut tunnel={t} name="out-b" />
      </>,
    );
    expect(container.querySelector(".out-a button")).toBeInTheDocument();
    expect(container.querySelector(".out-b button")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Multiple tunnel Outs"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("at LabeledOut"),
    );
    consoleError.mockRestore();
  });

  test("dev errors once per Out that mounts beside another", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const t = fiberTunnel();
    function App({ second, third }: { second: boolean; third: boolean }) {
      return (
        <>
          <t.In>
            <button>Tunneled</button>
          </t.In>
          <t.Out />
          {second && <t.Out />}
          {third && <t.Out />}
        </>
      );
    }

    const { rerender } = render(<App second={false} third={false} />);
    await flush();
    expect(consoleError).not.toHaveBeenCalled();
    await act(async () => rerender(<App second={true} third={false} />));
    expect(consoleError).toHaveBeenCalledTimes(1);
    await act(async () => rerender(<App second={false} third={false} />));
    await act(async () => rerender(<App second={false} third={true} />));
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});

describe("StrictMode", () => {
  test("tunnels content in order under StrictMode", () => {
    const t = fiberTunnel();
    render(
      <StrictMode>
        <>
          <t.In>
            <button>First</button>
          </t.In>
          <t.In>
            <button>Second</button>
          </t.In>
          <t.Out />
        </>
      </StrictMode>,
    );
    expect(buttonLabels()).toEqual(["First", "Second"]);
  });

  test("dev errors once per extra Out under StrictMode", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <StrictMode>
        <>
          <t.In>
            <button>Tunneled</button>
          </t.In>
          <t.Out />
          <t.Out />
        </>
      </StrictMode>,
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

const Theme = createContext("default");

type SetTheme = (value: string) => void;

/** Provides Theme; `control` sets its value. */
function ThemeHost({
  initial,
  control,
  children,
}: {
  initial: string;
  control?: Ref<SetTheme>;
  children: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  useImperativeHandle(control, () => setValue, []);
  return <Theme value={value}>{children}</Theme>;
}

/** Button labeled with its name and Theme. */
function ThemeLabel({ name }: { name: string }) {
  return <button>{`${name} ${use(Theme)}`}</button>;
}

/** Button counting its clicks. */
function Counter({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((c) => c + 1)}>{`${name} ${count}`}</button>
  );
}

/** Visible button labels inside `container`. */
function labelsIn(container: HTMLElement) {
  return within(container)
    .queryAllByRole("button")
    .map((button) => button.textContent);
}

/** Flushes microtask emits and the renders they schedule. */
const flush = () => act(async () => {});

/** Fiber fields the assertions read. */
interface TestFiber {
  type: unknown;
  child: TestFiber | null;
  sibling: TestFiber | null;
  alternate: TestFiber | null;
  /** New object when the parent renders a new element. */
  memoizedProps: unknown;
  /** Function component: new hook list on each render. */
  memoizedState: unknown;
}

/** Fibers of `type` in the current tree of `container`'s root, in tree
 * order. */
function fibersOf(container: HTMLElement, type: unknown): TestFiber[] {
  const key = Object.keys(container).find((k) =>
    k.startsWith("__reactContainer$"),
  )!;
  const hostRoot = (
    container as unknown as Record<
      string,
      { stateNode: { current: TestFiber } }
    >
  )[key];
  const found: TestFiber[] = [];
  const visit = (fiber: TestFiber) => {
    for (let child = fiber.child; child; child = child.sibling) {
      if (child.type === type) found.push(child);
      visit(child);
    }
  };
  visit(hostRoot.stateNode.current);
  return found;
}

/** Value prop of a provider fiber. */
const valueOf = (fiber: TestFiber) =>
  (fiber.memoizedProps as { value: unknown }).value;

const nestedRoots = new Set<{ root: Root; container: HTMLElement }>();
afterEach(() => {
  act(() => nestedRoots.forEach(({ root }) => root.unmount()));
  nestedRoots.forEach(({ container }) => container.remove());
  nestedRoots.clear();
});

/** An anchored nested react-dom root rendering `children` under the
 * providers above it. */
function NestedRoot({ children }: { children: ReactNode }) {
  return (
    <FiberAnchor>
      {(bridge) => <BridgedRoot bridge={bridge}>{children}</BridgedRoot>}
    </FiberAnchor>
  );
}

/** A nested react-dom root rendering `children` under `bridge`. */
function BridgedRoot({
  bridge,
  children,
}: {
  bridge: ContextBridgeValue;
  children: ReactNode;
}) {
  const rootRef = useRef<Root | null>(null);
  useLayoutEffect(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    rootRef.current = root;
    nestedRoots.add({ root, container });
  }, []);
  useLayoutEffect(() => {
    rootRef.current?.render(
      <ContextBridge bridge={bridge}>{children}</ContextBridge>,
    );
  });
  return null;
}

/** Shows the caught error's message. */
class Boundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <p>caught {this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

/** Records the anchor each `Grab` renders under, by name. */
function anchorGrabber() {
  const anchors = new Map<string, FiberAnchorValue>();
  function Grab({ name }: { name: string }) {
    const anchor = use(FiberAnchorContext);
    if (anchor) anchors.set(name, anchor);
    return null;
  }
  return { anchors, Grab };
}

describe("bridge", () => {
  test("renders content with context provided above its In", async () => {
    const t = fiberTunnel();
    const out = await mountDomRoot(<t.Out />);
    render(
      <Theme value="dark">
        <t.In>
          <ThemeLabel name="A" />
        </t.In>
      </Theme>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["A dark"]);
  });

  test("re-renders only consumers when a bridged value changes", async () => {
    const t = fiberTunnel();
    const consumerRendered = vi.fn();
    const otherRendered = vi.fn();
    function Consumer() {
      consumerRendered();
      return <button>{use(Theme)}</button>;
    }
    function Other() {
      otherRendered();
      return <span>other</span>;
    }
    const control = createRef<SetTheme>();
    const out = await mountDomRoot(<t.Out />);
    render(
      <ThemeHost initial="dark" control={control}>
        <t.In>
          <Consumer />
          <Other />
        </t.In>
      </ThemeHost>,
    );
    await flush();
    consumerRendered.mockClear();
    otherRendered.mockClear();

    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual(["light"]);
    expect(consumerRendered).toHaveBeenCalledTimes(1);
    expect(otherRendered).not.toHaveBeenCalled();
  });

  test("re-renders one reader per provider when a value changes", async () => {
    const t = fiberTunnel();
    const u = fiberTunnel();
    const control = createRef<SetTheme>();
    const out = await mountDomRoot(
      <>
        <t.Out />
        <u.Out />
      </>,
    );
    const { container } = render(
      <>
        <ThemeHost initial="dark" control={control}>
          <t.In>
            <ThemeLabel name="A" />
          </t.In>
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
          <u.In>
            <ThemeLabel name="C" />
          </u.In>
        </ThemeHost>
        <ThemeHost initial="red">
          <t.In>
            <ThemeLabel name="D" />
          </t.In>
        </ThemeHost>
      </>,
    );
    await flush();
    const hooks = () =>
      fibersOf(container, SourceReader).map((fiber) => fiber.memoizedState);
    const before = hooks();
    expect(before).toHaveLength(2);

    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual([
      "A light",
      "B light",
      "D red",
      "C light",
    ]);
    const rendered = hooks().map((state, i) => state !== before[i]);
    expect(rendered).toEqual([true, false]);
  });

  test("renders content's first render with the provider's current value", async () => {
    const t = fiberTunnel();
    const seen: string[] = [];
    function Recorder({ name }: { name: string }) {
      const theme = use(Theme);
      seen.push(`${name} ${theme}`);
      return <button>{`${name} ${theme}`}</button>;
    }
    function App({ theme, showB }: { theme: string; showB: boolean }) {
      return (
        <Theme value={theme}>
          {showB && (
            <t.In>
              <Recorder name="B" />
            </t.In>
          )}
          <t.In>
            <Recorder name="A" />
          </t.In>
        </Theme>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    const { rerender } = render(<App theme="dark" showB={false} />);
    await flush();
    expect(seen).toEqual(["A dark"]);

    rerender(<App theme="light" showB={true} />);
    await flush();
    expect(seen).toEqual(["A dark", "B light", "A light"]);
    expect(labelsIn(out.container)).toEqual(["B light", "A light"]);
  });

  test("renders one provider instance for Ins under the same provider", async () => {
    const t = fiberTunnel();
    const out = await mountDomRoot(<t.Out />);
    render(
      <>
        <Theme value="dark">
          <t.In>
            <ThemeLabel name="A" />
          </t.In>
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
        </Theme>
        <Theme value="light">
          <t.In>
            <ThemeLabel name="C" />
          </t.In>
        </Theme>
      </>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["A dark", "B dark", "C light"]);
    expect(fibersOf(out.container, Theme).map(valueOf)).toEqual([
      "dark",
      "light",
    ]);
  });

  test("keeps content state and DOM when another In joins or leaves its provider", async () => {
    const t = fiberTunnel();
    function App({ showB }: { showB: boolean }) {
      return (
        <Theme value="dark">
          {showB && (
            <t.In>
              <Counter name="B" />
            </t.In>
          )}
          <t.In>
            <Counter name="A" />
          </t.In>
        </Theme>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    const { rerender } = render(<App showB={false} />);
    await flush();
    const button = within(out.container).getByRole("button");
    fireEvent.click(button);

    rerender(<App showB={true} />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["B 0", "A 1"]);
    expect(within(out.container).getByRole("button", { name: "A 1" })).toBe(
      button,
    );

    rerender(<App showB={false} />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["A 1"]);
    expect(within(out.container).getByRole("button")).toBe(button);
  });

  test("keeps an unchanged provider from re-rendering when an unrelated In mounts", async () => {
    const t = fiberTunnel();
    const rendered = vi.fn();
    function Counted() {
      rendered();
      return <button>{`A ${use(Theme)}`}</button>;
    }
    const showLater = createRef<(show: boolean) => void>();
    function Later({ control }: { control: Ref<(show: boolean) => void> }) {
      const [show, setShow] = useState(false);
      useImperativeHandle(control, () => setShow, []);
      return (
        show && (
          <Theme value="b">
            <t.In>
              <ThemeLabel name="B" />
            </t.In>
          </Theme>
        )
      );
    }
    const out = await mountDomRoot(<t.Out />);
    render(
      <>
        <Theme value="a">
          <t.In>
            <Counted />
          </t.In>
        </Theme>
        <Later control={showLater} />
      </>,
    );
    await flush();
    const providerProps = () =>
      fibersOf(out.container, Theme).find((fiber) => valueOf(fiber) === "a")!
        .memoizedProps;
    const before = providerProps();
    rendered.mockClear();

    await act(async () => showLater.current!(true));
    expect(labelsIn(out.container)).toEqual(["A a", "B b"]);
    expect(providerProps()).toBe(before);
    expect(rendered).not.toHaveBeenCalled();
  });

  test("unmounts a provider when its last In unmounts", async () => {
    const t = fiberTunnel();
    function App({ names }: { names: string[] }) {
      return (
        <Theme value="dark">
          {names.map((name) => (
            <t.In key={name}>
              <ThemeLabel name={name} />
            </t.In>
          ))}
        </Theme>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    const { rerender } = render(<App names={["A", "B"]} />);
    await flush();
    const [provider] = fibersOf(out.container, Theme);
    expect(fibersOf(out.container, Theme)).toHaveLength(1);

    rerender(<App names={["B"]} />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["B dark"]);
    const kept = fibersOf(out.container, Theme);
    expect(kept).toHaveLength(1);
    expect([kept[0], kept[0].alternate]).toContain(provider);

    rerender(<App names={[]} />);
    await flush();
    expect(labelsIn(out.container)).toEqual([]);
    expect(fibersOf(out.container, Theme)).toEqual([]);
  });

  test("orders content in fiber order when an inner provider shadows an outer one", async () => {
    const t = fiberTunnel();
    const out = await mountDomRoot(<t.Out />);
    render(
      <Theme value="outer">
        <t.In>
          <ThemeLabel name="1" />
        </t.In>
        <Theme value="inner">
          <t.In>
            <ThemeLabel name="2" />
          </t.In>
        </Theme>
        <t.In>
          <ThemeLabel name="3" />
        </t.In>
      </Theme>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["1 outer", "2 inner", "3 outer"]);
  });

  test("hands reading to the next In when the owner unmounts", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    function App({ showA }: { showA: boolean }) {
      return (
        <ThemeHost initial="dark" control={control}>
          {showA && (
            <t.In>
              <ThemeLabel name="A" />
            </t.In>
          )}
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
        </ThemeHost>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    const { rerender } = render(<App showA={true} />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["A dark", "B dark"]);

    rerender(<App showA={false} />);
    await flush();
    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual(["B light"]);
  });

  test("hands reading to the next In when Activity hides the owner", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    function App({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <ThemeHost initial="dark" control={control}>
          <Activity mode={mode}>
            <t.In>
              <ThemeLabel name="A" />
            </t.In>
          </Activity>
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
        </ThemeHost>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    const { rerender } = render(<App mode="visible" />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["A dark", "B dark"]);

    rerender(<App mode="hidden" />);
    await flush();
    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual(["B light"]);

    rerender(<App mode="visible" />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["A light", "B light"]);
  });

  test("shares sources across nested roots through a bridge", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    const out = await mountDomRoot(<t.Out />);
    render(
      <ThemeHost initial="dark" control={control}>
        <t.In>
          <ThemeLabel name="A" />
        </t.In>
        <NestedRoot>
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
        </NestedRoot>
      </ThemeHost>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["A dark", "B dark"]);
    expect(fibersOf(out.container, Theme)).toHaveLength(1);

    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual(["A light", "B light"]);
    expect(fibersOf(out.container, Theme)).toHaveLength(1);
  });

  test("applies StrictMode to content whose In renders under StrictMode", async () => {
    const t = fiberTunnel();
    const rendered = vi.fn();
    const effects = vi.fn();
    function Rendered({ name }: { name: string }) {
      rendered(name);
      useEffect(() => effects(name), [name]);
      return <button>{name}</button>;
    }
    const out = await mountDomRoot(<t.Out />);
    render(
      <>
        <StrictMode>
          <t.In>
            <Rendered name="strict" />
          </t.In>
        </StrictMode>
        <t.In>
          <Rendered name="plain" />
        </t.In>
      </>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["strict", "plain"]);
    expect(rendered.mock.calls).toEqual([["strict"], ["strict"], ["plain"]]);
    expect(effects.mock.calls).toEqual([["strict"], ["plain"], ["strict"]]);
  });

  test("rethrows a content error at its In for the boundary above it", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const t = fiberTunnel();
    function Throws(): ReactNode {
      throw new Error("boom");
    }
    const out = await mountDomRoot(<t.Out />);
    render(
      <>
        <Boundary>
          <t.In>
            <Throws />
          </t.In>
        </Boundary>
        <t.In>
          <button>Sibling</button>
        </t.In>
      </>,
    );
    await flush();
    expect(screen.getByText("caught boom")).toBeInTheDocument();
    expect(labelsIn(out.container)).toEqual(["Sibling"]);
    consoleError.mockRestore();
  });

  test("rethrows an isolated content error at the boundary above the Out", async () => {
    const consoleError = spyError();
    const t = fiberTunnel({ isolate: true });
    function Throws(): ReactNode {
      throw new Error("boom");
    }
    const out = await mountDomRoot(
      <Boundary>
        <t.Out />
      </Boundary>,
    );
    render(
      <Boundary>
        <t.In>
          <Throws />
        </t.In>
      </Boundary>,
    );
    await flush();
    expect(within(out.container).getByText("caught boom")).toBeInTheDocument();
    expect(screen.getAllByText("caught boom")).toHaveLength(1);
    consoleError.mockRestore();
  });

  test("keeps the In's siblings mounted when content errors at the Out", async () => {
    const consoleError = spyError();
    const t = fiberTunnel({ isolate: true });
    function Throws(): ReactNode {
      throw new Error("boom");
    }
    const out = await mountDomRoot(
      <Boundary>
        <t.Out />
      </Boundary>,
    );
    const { container } = render(
      <>
        <button>Sibling</button>
        <t.In>
          <Throws />
        </t.In>
      </>,
    );
    await flush();
    expect(labelsIn(container)).toEqual(["Sibling"]);
    expect(within(out.container).getByText("caught boom")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  test("recovers content when the boundary above the Out resets", async () => {
    const consoleError = spyError();
    const t = fiberTunnel({ isolate: true });
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("boom");
      return <button>Fixed</button>;
    }
    const out = await mountDomRoot(
      <Boundary key={0}>
        <t.Out />
      </Boundary>,
    );
    render(
      <t.In>
        <Flaky />
      </t.In>,
    );
    await flush();
    expect(within(out.container).getByText("caught boom")).toBeInTheDocument();

    broken = false;
    await act(async () =>
      out.root.render(
        <Boundary key={1}>
          <t.Out />
        </Boundary>,
      ),
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["Fixed"]);
    consoleError.mockRestore();
  });

  test("keeps the In's siblings visible while isolated content loads", async () => {
    const t = fiberTunnel({ isolate: true });
    const resource = createResource<string>();
    function Loader() {
      resource.useData("x");
      return <button>Loaded</button>;
    }
    const out = await mountDomRoot(<t.Out />);
    const { container } = await mountDomRoot(
      <Suspense fallback={<p>loading</p>}>
        <t.In>
          <Loader />
        </t.In>
        <button>Sibling</button>
      </Suspense>,
      "primary",
    );
    await flush();
    expect(labelsIn(container)).toEqual(["Sibling"]);
    expect(screen.queryByText("loading")).toBeNull();
    expect(labelsIn(out.container)).toEqual([]);

    await act(async () => resource.resolve("x"));
    expect(labelsIn(out.container)).toEqual(["Loaded"]);
  });

  test("hides isolated content while its In's boundary shows a fallback", async () => {
    const t = fiberTunnel({ isolate: true });
    const gate = createGate();
    const app = (suspended: boolean) => (
      <Suspense fallback={<p>loading</p>}>
        <gate.Gate suspended={suspended} />
        <t.In>
          <Counter name="label" />
        </t.In>
      </Suspense>
    );
    const out = await mountDomRoot(<t.Out />);
    const primary = await mountDomRoot(app(false), "primary");
    fireEvent.click(within(out.container).getByRole("button"));
    await flush();
    expect(labelsIn(out.container)).toEqual(["label 1"]);

    await act(async () => primary.root.render(app(true)));
    expect(labelsIn(out.container)).toEqual([]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(labelsIn(out.container)).toEqual(["label 1"]);
  });

  test("surfaces a nested bridged tunnel's error at the outer Out's boundary", async () => {
    const consoleError = spyError();
    const outer = fiberTunnel({ isolate: true });
    const inner = fiberTunnel({ isolate: true });
    function Throws(): ReactNode {
      throw new Error("boom");
    }
    const out = await mountDomRoot(
      <Boundary>
        <outer.Out />
      </Boundary>,
    );
    const { container } = render(
      <>
        <outer.In>
          <inner.Out />
        </outer.In>
        <inner.In>
          <Throws />
        </inner.In>
        <button>Sibling</button>
      </>,
    );
    await flush();
    expect(within(out.container).getByText("caught boom")).toBeInTheDocument();
    expect(labelsIn(container)).toEqual(["Sibling"]);
    consoleError.mockRestore();
  });

  test("orders a nested tunnel's In inside bridged content at the bridged In", async () => {
    const warnings = spyWarn();
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const { container } = render(
      <>
        <outer.Out />
        <inner.In>
          <button>A</button>
        </inner.In>
        <outer.In>
          <inner.In>
            <button>B</button>
          </inner.In>
        </outer.In>
        <inner.In>
          <button>C</button>
        </inner.In>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["A", "B", "C"]);
    expect(warnings()).toEqual([]);
  });

  test("reorders nested content when its bridged In moves", async () => {
    const warnings = spyWarn();
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const Card = memo(function Card({ name }: { name: string }) {
      return (
        <outer.In>
          <inner.In>
            <button>{name}</button>
          </inner.In>
        </outer.In>
      );
    });
    const Direct = memo(function Direct({ name }: { name: string }) {
      return (
        <inner.In>
          <button>{name}</button>
        </inner.In>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <>
          <outer.Out />
          {order.map((name) =>
            name === "M" ? (
              <Direct key={name} name={name} />
            ) : (
              <Card key={name} name={name} />
            ),
          )}
          <LabeledOut tunnel={inner} name="inner" />
        </>
      );
    }
    const { container, rerender } = render(<App order={["X", "M", "Y"]} />);
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["X", "M", "Y"]);

    await act(async () => rerender(<App order={["Y", "M", "X"]} />));
    expect(labelsIn(innerOut)).toEqual(["Y", "M", "X"]);
    expect(warnings()).toEqual([]);
  });

  test("orders nested content through bridged Ins in three roots", async () => {
    const warnings = spyWarn();
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const out = await mountHostRoot(<outer.Out />);
    const { container } = render(
      <>
        <inner.In>
          <button>A</button>
        </inner.In>
        <NestedRoot>
          <inner.In>
            <button>B1</button>
          </inner.In>
          <outer.In>
            <inner.In>
              <button>B2</button>
            </inner.In>
            <button>outer</button>
          </outer.In>
          <inner.In>
            <button>B3</button>
          </inner.In>
        </NestedRoot>
        <inner.In>
          <button>C</button>
        </inner.In>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await flush();
    await flush();
    expect(out.buttons()).toEqual(["outer"]);
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["A", "B1", "B2", "B3", "C"]);
    expect(warnings()).toEqual([]);
  });

  test("reorders nested content when its bridged In's anchor changes", async () => {
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const { anchors, Grab } = anchorGrabber();
    const { container } = render(
      <>
        <FiberAnchor>
          <Grab name="P" />
        </FiberAnchor>
        <inner.In>
          <button>M</button>
        </inner.In>
        <FiberAnchor>
          <Grab name="Q" />
        </FiberAnchor>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await mountDomRoot(<outer.Out />);
    // Stable children: only the anchor changes.
    const content = (
      <inner.In>
        <button>B</button>
      </inner.In>
    );
    const scene = (name: string) => (
      <FiberAnchorContext value={anchors.get(name)!}>
        <outer.In>{content}</outer.In>
      </FiberAnchorContext>
    );
    const { root } = await mountDomRoot(scene("P"), "scene");
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["B", "M"]);

    await act(async () => root.render(scene("Q")));
    await flush();
    expect(labelsIn(innerOut)).toEqual(["M", "B"]);
  });

  test("reorders nested content when its bridged In's anchor changes while hidden", async () => {
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const { anchors, Grab } = anchorGrabber();
    const { container } = render(
      <>
        <FiberAnchor>
          <Grab name="P" />
        </FiberAnchor>
        <inner.In>
          <button>M</button>
        </inner.In>
        <FiberAnchor>
          <Grab name="Q" />
        </FiberAnchor>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await mountDomRoot(<outer.Out />);
    const content = (
      <inner.In>
        <button>B</button>
      </inner.In>
    );
    const scene = (name: string, mode: "visible" | "hidden") => (
      <FiberAnchorContext value={anchors.get(name)!}>
        <Activity mode={mode}>
          <outer.In>{content}</outer.In>
        </Activity>
      </FiberAnchorContext>
    );
    const { root } = await mountDomRoot(scene("P", "visible"), "scene");
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["B", "M"]);

    await act(async () => root.render(scene("P", "hidden")));
    await act(async () => root.render(scene("Q", "hidden")));
    await act(async () => root.render(scene("Q", "visible")));
    await flush();
    expect(labelsIn(innerOut)).toEqual(["M", "B"]);
  });

  test("renders a consumer once when a provider above both the In and the Out changes", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    const renders: string[] = [];
    const commits: string[] = [];
    function Consumer() {
      const theme = use(Theme);
      renders.push(theme);
      useLayoutEffect(() => void commits.push(theme));
      return <button>{theme}</button>;
    }
    const content = <Consumer />;
    render(
      <ThemeHost initial="dark" control={control}>
        <t.In>{content}</t.In>
        <LabeledOut tunnel={t} name="out" />
      </ThemeHost>,
    );
    await flush();
    renders.length = 0;
    commits.length = 0;

    await act(async () => control.current!("light"));
    expect(renders).toEqual(["light"]);
    expect(commits).toEqual(["light"]);
  });

  test("renders the In's nearer provider over a provider the Out shares", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    const { container } = render(
      <ThemeHost initial="dark" control={control}>
        <Theme value="inner">
          <t.In>
            <ThemeLabel name="A" />
          </t.In>
        </Theme>
        <LabeledOut tunnel={t} name="out" />
      </ThemeHost>,
    );
    await flush();
    const out = container.querySelector<HTMLElement>(".out")!;
    expect(labelsIn(out)).toEqual(["A inner"]);

    await act(async () => control.current!("light"));
    expect(labelsIn(out)).toEqual(["A inner"]);
  });

  test("orders nested content with Ins outside it when the Out's root re-provides context", async () => {
    const warnings = spyWarn();
    const outer = fiberTunnel();
    const inner = fiberTunnel();
    const { container } = render(
      <>
        <ThemeHost initial="dark">
          <inner.In>
            <ThemeLabel name="A" />
          </inner.In>
          <outer.In>
            <inner.In>
              <ThemeLabel name="B" />
            </inner.In>
          </outer.In>
          <inner.In>
            <ThemeLabel name="C" />
          </inner.In>
          <ChildRoot>
            <outer.Out />
          </ChildRoot>
        </ThemeHost>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await flush();
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["A dark", "B dark", "C dark"]);
    expect(warnings()).toEqual([]);
  });

  test("keeps tree order when Ins under re-provided contexts interleave", async () => {
    spyWarn();
    const t = fiberTunnel();
    const { container } = render(
      <ThemeHost initial="dark">
        <t.In>
          <ThemeLabel name="A" />
        </t.In>
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <ThemeLabel name="B1" />
            </t.In>
            <FiberAnchor>
              <ChildRoot>
                <t.In>
                  <ThemeLabel name="C" />
                </t.In>
              </ChildRoot>
            </FiberAnchor>
            <t.In>
              <ThemeLabel name="B2" />
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.In>
          <ThemeLabel name="D" />
        </t.In>
        <LabeledOut tunnel={t} name="out" />
      </ThemeHost>,
    );
    await flush();
    await flush();
    const out = container.querySelector<HTMLElement>(".out")!;
    expect(labelsIn(out)).toEqual([
      "A dark",
      "B1 dark",
      "C dark",
      "B2 dark",
      "D dark",
    ]);
  });

  test("warns once when Ins under re-provided contexts interleave", async () => {
    const warnings = spyWarn();
    const t = fiberTunnel();
    function App({ label }: { label: string }) {
      return (
        <>
          <ThemeHost initial="dark">
            <t.In>
              <ThemeLabel name="A" />
            </t.In>
            <FiberAnchor>
              <ChildRoot>
                <t.In>
                  <ThemeLabel name={label} />
                </t.In>
              </ChildRoot>
            </FiberAnchor>
            <t.In>
              <ThemeLabel name="C" />
            </t.In>
          </ThemeHost>
          <LabeledOut tunnel={t} name="out" />
        </>
      );
    }
    const { rerender } = render(<App label="B" />);
    await flush();
    await flush();
    await act(async () => rerender(<App label="B2" />));
    await flush();
    const split = warnings().filter((w) => w.includes("split"));
    expect(split).toHaveLength(1);
  });

  test("renders the nearest provider when nested providers of one context sit above both the In and the Out", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    const { container } = render(
      <ThemeHost initial="outer">
        <ThemeHost initial="dark" control={control}>
          <t.In>
            <ThemeLabel name="A" />
          </t.In>
          <LabeledOut tunnel={t} name="out" />
        </ThemeHost>
      </ThemeHost>,
    );
    await flush();
    const out = container.querySelector<HTMLElement>(".out")!;
    expect(labelsIn(out)).toEqual(["A dark"]);

    await act(async () => control.current!("light"));
    expect(labelsIn(out)).toEqual(["A light"]);
  });

  test("renders a consumer once when nested providers of one context above both the In and the Out change", async () => {
    const t = fiberTunnel();
    const control = createRef<SetTheme>();
    const renders: string[] = [];
    const commits: string[] = [];
    function Consumer() {
      const theme = use(Theme);
      renders.push(theme);
      useLayoutEffect(() => void commits.push(theme));
      return <button>{theme}</button>;
    }
    const content = <Consumer />;
    render(
      <ThemeHost initial="outer">
        <ThemeHost initial="dark" control={control}>
          <t.In>{content}</t.In>
          <LabeledOut tunnel={t} name="out" />
        </ThemeHost>
      </ThemeHost>,
    );
    await flush();
    renders.length = 0;
    commits.length = 0;

    await act(async () => control.current!("light"));
    expect(renders).toEqual(["light"]);
    expect(commits).toEqual(["light"]);
  });

  test("carries contexts above the Out into a nested root inside content", async () => {
    const t = fiberTunnel();
    await mountDomRoot(
      <Theme value="out">
        <t.Out />
      </Theme>,
    );
    render(
      <t.In>
        <ThemeLabel name="direct" />
        <NestedRoot>
          <ThemeLabel name="nested" />
        </NestedRoot>
      </t.In>,
    );
    await flush();
    await flush();
    expect(buttonLabels().sort()).toEqual(["direct out", "nested out"]);
  });

  test("keeps one provider group when an In unmounts as another mounts", async () => {
    const warnings = spyWarn();
    const t = fiberTunnel();
    let setShow!: (show: boolean) => void;
    function App() {
      const [show, set] = useState(true);
      useLayoutEffect(() => {
        setShow = set;
      }, [set]);
      return (
        <>
          <Theme value="p">
            {show && (
              <t.In>
                <button>A</button>
              </t.In>
            )}
            <t.In>
              <button>B</button>
            </t.In>
          </Theme>
          <t.In>
            <button>X</button>
          </t.In>
          {!show && (
            <t.In>
              <button>N</button>
            </t.In>
          )}
        </>
      );
    }
    const out = await mountDomRoot(<t.Out />);
    render(<App />);
    await flush();
    expect(labelsIn(out.container)).toEqual(["A", "B", "X"]);

    await act(async () => flushSync(() => setShow(false)));
    await flush();
    expect(labelsIn(out.container)).toEqual(["B", "X", "N"]);
    expect(warnings()).toEqual([]);
  });

  test("keeps a later run's content state when an earlier run splits", async () => {
    spyWarn();
    const t = fiberTunnel();
    function App({ first }: { first: boolean }) {
      return (
        <>
          <ThemeHost initial="dark">
            <t.In>
              <Counter name="A" />
            </t.In>
            <FiberAnchor>
              <ChildRoot>
                {first && (
                  <t.In>
                    <Counter name="R1" />
                  </t.In>
                )}
              </ChildRoot>
            </FiberAnchor>
            <t.In>
              <Counter name="C" />
            </t.In>
            <FiberAnchor>
              <ChildRoot>
                <t.In>
                  <Counter name="R2" />
                </t.In>
              </ChildRoot>
            </FiberAnchor>
            <t.In>
              <Counter name="E" />
            </t.In>
          </ThemeHost>
          <LabeledOut tunnel={t} name="out" />
        </>
      );
    }
    const { container, rerender } = render(<App first={false} />);
    await flush();
    await flush();
    const out = container.querySelector<HTMLElement>(".out")!;
    expect(labelsIn(out)).toEqual(["A 0", "C 0", "R2 0", "E 0"]);
    fireEvent.click(within(out).getByRole("button", { name: "A 0" }));
    fireEvent.click(within(out).getByRole("button", { name: "E 0" }));
    await flush();

    await act(async () => rerender(<App first={true} />));
    await flush();
    expect(labelsIn(out)).toEqual(["A 1", "R1 0", "C 0", "R2 0", "E 1"]);
  });

  test("keeps unbridged content's nested Ins at the Out", async () => {
    const outer = fiberTunnel({ bridge: false });
    const inner = fiberTunnel();
    const { container } = render(
      <>
        <inner.In>
          <button>A</button>
        </inner.In>
        <outer.Out />
        <inner.In>
          <button>C</button>
        </inner.In>
        <outer.In>
          <inner.In>
            <button>B</button>
          </inner.In>
        </outer.In>
        <LabeledOut tunnel={inner} name="inner" />
      </>,
    );
    await flush();
    const innerOut = container.querySelector<HTMLElement>(".inner")!;
    expect(labelsIn(innerOut)).toEqual(["A", "B", "C"]);
  });

  test("shows the fallback above an In while its content loads", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    function Data({ id }: { id: string }) {
      resource.useData(id);
      return <button>{id}</button>;
    }
    const out = await mountDomRoot(<t.Out />);
    const { container } = render(
      <Suspense fallback={<p>loading</p>}>
        <button>Sibling</button>
        <t.In>
          <Data id="a" />
        </t.In>
      </Suspense>,
    );
    await flush();
    expect(within(container).getByText("loading")).toBeInTheDocument();
    expect(labelsIn(container)).toEqual([]);
    expect(labelsIn(out.container)).toEqual([]);
  });

  test("shows content when its suspension resolves", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    function Data({ id }: { id: string }) {
      resource.useData(id);
      return <button>{id}</button>;
    }
    const out = await mountDomRoot(<t.Out />);
    const { container } = render(
      <Suspense fallback={<p>loading</p>}>
        <button>Sibling</button>
        <t.In>
          <Data id="a" />
        </t.In>
      </Suspense>,
    );
    await flush();

    await act(async () => resource.resolve("a"));
    expect(within(container).queryByText("loading")).toBeNull();
    expect(labelsIn(container)).toEqual(["Sibling"]);
    expect(labelsIn(out.container)).toEqual(["a"]);
  });

  test("keeps content state when content suspends after showing", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    function Data({ id }: { id: string }) {
      resource.useData(id);
      return <span>{`data ${id}`}</span>;
    }
    function App({ id }: { id: string }) {
      return (
        <Suspense fallback={<p>loading</p>}>
          <t.In>
            <Counter name="count" />
            <Data id={id} />
          </t.In>
        </Suspense>
      );
    }
    resource.resolve("a");
    const out = await mountDomRoot(<t.Out />);
    const { container, rerender } = render(<App id="a" />);
    await flush();
    const button = within(out.container).getByRole("button");
    fireEvent.click(button);
    expect(button).toHaveTextContent("count 1");

    rerender(<App id="b" />);
    await flush();
    expect(within(container).getByText("loading")).toBeInTheDocument();

    await act(async () => resource.resolve("b"));
    expect(within(container).queryByText("loading")).toBeNull();
    expect(within(out.container).getByText("data b")).toBeInTheDocument();
    expect(within(out.container).getByRole("button")).toBe(button);
    expect(button).toHaveTextContent("count 1");
  });

  test("shows the fallback when an urgent update suspends content", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    const control = createRef<(id: string) => void>();
    function Data({ control }: { control: Ref<(id: string) => void> }) {
      const [id, setId] = useState("a");
      useImperativeHandle(control, () => setId, []);
      resource.useData(id);
      return <button>{id}</button>;
    }
    resource.resolve("a");
    const out = await mountDomRoot(<t.Out />);
    const { container } = render(
      <Suspense fallback={<p>loading</p>}>
        <t.In>
          <Data control={control} />
        </t.In>
      </Suspense>,
    );
    await flush();
    expect(labelsIn(out.container)).toEqual(["a"]);
    expect(within(container).queryByText("loading")).toBeNull();

    await act(async () => control.current!("b"));
    expect(within(container).getByText("loading")).toBeInTheDocument();
    expect(labelsIn(out.container)).toEqual([]);

    await act(async () => resource.resolve("b"));
    expect(within(container).queryByText("loading")).toBeNull();
    expect(labelsIn(out.container)).toEqual(["b"]);
  });

  test("keeps bridged content under StrictMode replays", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    const control = createRef<SetTheme>();
    function ThemeCounter() {
      const theme = use(Theme);
      const [count, setCount] = useState(0);
      return (
        <button
          onClick={() => setCount((c) => c + 1)}
        >{`A ${theme} ${count}`}</button>
      );
    }
    function Data({ id }: { id: string }) {
      resource.useData(id);
      return <button>{`${id} ${use(Theme)}`}</button>;
    }
    const out = await mountDomRoot(
      <StrictMode>
        <t.Out />
      </StrictMode>,
    );
    const { container } = render(
      <StrictMode>
        <ThemeHost initial="dark" control={control}>
          <t.In>
            <ThemeCounter />
          </t.In>
          <t.In>
            <ThemeLabel name="B" />
          </t.In>
          <Suspense fallback={<p>loading</p>}>
            <t.In>
              <Data id="c" />
            </t.In>
          </Suspense>
        </ThemeHost>
      </StrictMode>,
    );
    await flush();
    expect(within(container).getByText("loading")).toBeInTheDocument();
    expect(labelsIn(out.container)).toEqual(["A dark 0", "B dark"]);
    const button = within(out.container).getByRole("button", {
      name: "A dark 0",
    });
    fireEvent.click(button);

    await act(async () => resource.resolve("c"));
    expect(within(container).queryByText("loading")).toBeNull();
    expect(labelsIn(out.container)).toEqual(["A dark 1", "B dark", "c dark"]);

    await act(async () => control.current!("light"));
    expect(labelsIn(out.container)).toEqual([
      "A light 1",
      "B light",
      "c light",
    ]);
    expect(
      within(out.container).getByRole("button", { name: "A light 1" }),
    ).toBe(button);
  });

  test("renders `ContextBridge` children with the captured context", async () => {
    const control = createRef<SetTheme>();
    render(
      <ThemeHost initial="dark" control={control}>
        <NestedRoot>
          <ThemeLabel name="nested" />
        </NestedRoot>
      </ThemeHost>,
    );
    await flush();
    expect(screen.getByRole("button")).toHaveTextContent("nested dark");

    await act(async () => control.current!("light"));
    expect(screen.getByRole("button")).toHaveTextContent("nested light");
  });

  test("orders a nested root's Ins at the FiberAnchor that bridges it", async () => {
    const warnings = spyWarn();
    const t = fiberTunnel();
    const { container } = render(
      <ThemeHost initial="dark">
        <t.In>
          <ThemeLabel name="Before" />
        </t.In>
        <FiberAnchor>
          {(bridge) => (
            <BridgedRoot bridge={bridge}>
              <t.In>
                <ThemeLabel name="Inside" />
              </t.In>
            </BridgedRoot>
          )}
        </FiberAnchor>
        <t.In>
          <ThemeLabel name="After" />
        </t.In>
        <LabeledOut tunnel={t} name="out" />
      </ThemeHost>,
    );
    await flush();
    await flush();
    const out = container.querySelector<HTMLElement>(".out")!;
    expect(labelsIn(out)).toEqual(["Before dark", "Inside dark", "After dark"]);
    expect(warnings()).toEqual([]);
  });

  test("carries context through a FiberAnchor bridge when Function.prototype.bind is read-only", async () => {
    const proto = Function.prototype;
    const bind = proto.bind;
    Object.defineProperty(proto, "bind", {
      value: bind,
      writable: false,
      configurable: true,
    });
    try {
      render(
        <Theme value="outer">
          <FiberAnchor>
            {(bridge) => (
              <BridgedRoot bridge={bridge}>
                <ThemeLabel name="nested" />
              </BridgedRoot>
            )}
          </FiberAnchor>
        </Theme>,
      );
      await flush();
    } finally {
      Object.defineProperty(proto, "bind", {
        value: bind,
        writable: true,
        configurable: true,
      });
    }
    await flush();
    expect(buttonLabels()).toEqual(["nested outer"]);
  });

  test("carries context to an In given a ref", async () => {
    const t = fiberTunnel();
    const Value = createContext(0);
    function Content() {
      return <button>content {useContext(Value)}</button>;
    }
    const ref = createRef<Component>();
    const out = (await mountDomRoot(<t.Out />)).container;
    await mountDomRoot(
      <Value value={1}>
        {/* Untyped callers can pass one; React copies the props. */}
        <t.In {...({ ref } as object)}>
          <Content />
        </t.In>
      </Value>,
      "primary",
    );
    await act(async () => {});
    expect(out.textContent).toBe("content 1");
    expect(ref.current).not.toBeNull();
  });
});

/* Apps hand their hook setters to the test body. */
/* eslint-disable react-hooks/globals */
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Fakes only timeouts: React's scheduler and microtasks stay real. */
function fakeTimeouts() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

async function advance(ms: number) {
  await act(async () => void vi.advanceTimersByTime(ms));
}

/** Collects `console.warn` messages. */
function spyWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mock.calls.map((args) => String(args[0]));
}

/** Mounts a bridged tunnel's Out in its own root, inside an Activity;
 * settles the Out's checks. */
async function mountOut(tunnel: FiberTunnel) {
  const ui = (mode: "visible" | "hidden") => (
    <Activity mode={mode}>
      <tunnel.Out />
    </Activity>
  );
  const { root, container } = await mountDomRoot(ui("visible"));
  await settleOut(tunnel);
  return {
    container,
    hide: () => root.render(ui("hidden")),
  };
}

/** Committed `ItemView` instances under a react-dom container. */
function itemViews(container: HTMLElement): ItemView[] {
  const key = Object.keys(container).find((k) =>
    k.startsWith("__reactContainer$"),
  )!;
  const hostRoot = (container as unknown as Record<string, Fiber>)[key];
  const current = (hostRoot.stateNode as { current: Fiber }).current;
  const found: ItemView[] = [];
  const walk = (fiber: Fiber | null) => {
    for (let f = fiber; f; f = f.sibling) {
      if (f.stateNode instanceof ItemView) found.push(f.stateNode);
      walk(f.child);
    }
  };
  walk(current);
  return found;
}

/** A value provided above one In; content loads per value. */
async function setupUpdateApp({ isolate }: { isolate?: boolean } = {}) {
  const tunnel = fiberTunnel({ isolate });
  const Value = createContext(0);
  const data = createResource<number>();
  data.resolve(1);
  const log: string[] = [];
  const contentRenders = new Map<number, number>();
  let outText = "";
  let outContainer: HTMLElement | null = null;

  function Content() {
    const v = useContext(Value);
    contentRenders.set(v, (contentRenders.get(v) ?? 0) + 1);
    data.useData(v);
    useLayoutEffect(() => void log.push(`out:${v}`), [v]);
    return <button>content {v}</button>;
  }

  function Fallback() {
    useLayoutEffect(() => void log.push("fallback"), []);
    return <p>loading</p>;
  }

  let setValue!: (v: number) => void;
  let start!: (fn: () => void) => void;
  function App() {
    const [v, set] = useState(1);
    const [pending, startTransition] = useTransition();
    setValue = set;
    start = startTransition;
    useLayoutEffect(() => {
      log.push(`primary:${v}`);
      outText = outContainer?.textContent ?? "";
      queueMicrotask(() => log.push(`microtask:${v}`));
      setTimeout(() => log.push(`task:${v}`));
    }, [v]);
    return (
      <Value value={v}>
        <Suspense fallback={<Fallback />}>
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
  const out = await mountOut(tunnel);
  outContainer = out.container;
  return {
    data,
    log,
    contentRenders,
    primary: primary.container,
    output: () => primary.container.querySelector("output")!.textContent,
    out: out.container,
    hideOut: out.hide,
    /** Out text when the primary last committed. */
    outTextAtPrimaryCommit: () => outText,
    transition: (v: number) => start(() => setValue(v)),
  };
}

/** A router-like page switch: page b mounts an In beside `Page`. */
async function setupMountApp({
  page = "",
  isolate,
}: { page?: string; isolate?: boolean } = {}) {
  const tunnel = fiberTunnel({ isolate });
  const data = createResource<string>();
  const log: string[] = [];
  let pageRenders = 0;

  function Content({ id }: { id: string }) {
    data.useData(id);
    useLayoutEffect(() => {
      log.push(`mount ${id}`);
      return () => void log.push(`unmount ${id}`);
    }, [id]);
    return <button>content {id}</button>;
  }

  function Fallback() {
    useLayoutEffect(() => void log.push("fallback"), []);
    return <p>loading</p>;
  }

  /** Suspends on `page` when set. */
  function Page({ rev }: { rev: number }) {
    pageRenders++;
    if (page) data.useData(page);
    return <h1>B{rev || ""}</h1>;
  }

  interface State {
    page: string;
    /** Changes the In's children. */
    tick: number;
    /** Changes the In's sibling. */
    rev: number;
  }
  let setState!: (update: (s: State) => State) => void;
  let start!: (fn: () => void) => void;
  function App() {
    // One hook: its transitions entangle.
    const [state, set] = useState<State>({ page: "a", tick: 0, rev: 0 });
    const [, startTransition] = useTransition();
    setState = set;
    start = startTransition;
    const { tick, rev } = state;
    return (
      <Suspense fallback={<Fallback />}>
        {state.page === "a" ? (
          <h1>A</h1>
        ) : state.page === "b" ? (
          <>
            <tunnel.In>
              <Content id={`b${tick || ""}`} />
            </tunnel.In>
            <Page rev={rev} />
          </>
        ) : (
          <>
            <h2>C</h2>
          </>
        )}
      </Suspense>
    );
  }

  const primary = render(<App />);
  const out = await mountOut(tunnel);
  return {
    tunnel,
    data,
    log,
    pageRenders: () => pageRenders,
    primary: primary.container,
    out: out.container,
    goto: (page: string) => start(() => setState((s) => ({ ...s, page }))),
    gotoUrgent: (page: string) => setState((s) => ({ ...s, page })),
    tick: () => start(() => setState((s) => ({ ...s, tick: s.tick + 1 }))),
    /** Restarts the mount pass; the In's children stay equal. */
    restart: () => start(() => setState((s) => ({ ...s, rev: s.rev + 1 }))),
  };
}

describe("transitions", () => {
  test("keeps the primary pending until the Out can render the new value", async () => {
    const app = await setupUpdateApp();
    expect(app.output()).toBe("1");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 1");

    await act(async () => app.transition(2));
    expect(app.output()).toBe("1 pending");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 1");

    await act(async () => app.data.resolve(2));
    expect(app.output()).toBe("2");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
    expect(app.log).not.toContain("fallback");
  });

  test("commits the primary, then the Out, before paint", async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    const app = await setupUpdateApp();
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      app.data.resolve(2);
      app.log.length = 0;
      app.transition(2);
      await vi.waitFor(() => expect(app.log).toContain("task:2"), {
        timeout: 10_000,
      });
      // A task boundary stands in for paint.
      expect(app.log).toEqual(["primary:2", "out:2", "microtask:2", "task:2"]);
      expect(app.outTextAtPrimaryCommit()).toBe("content 1");
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  test("starts one candidate render per value", async () => {
    const app = await setupUpdateApp();
    await act(async () => app.transition(2));
    await act(async () => app.transition(2));
    await act(async () => app.transition(2));
    expect(app.contentRenders.get(2)).toBe(1);

    await act(async () => app.data.resolve(2));
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
  });

  test("keeps the previous page during a transition mount until content is ready", async () => {
    const app = await setupMountApp();
    await act(async () => app.goto("b"));
    expect(app.primary).toHaveTextContent("A");
    expect(app.out).toHaveTextContent("");

    await act(async () => app.data.resolve("b"));
    expect(app.primary).toHaveTextContent("B");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content b");
    expect(app.log).not.toContain("fallback");
  });

  test("commits a transition while isolated content loads", async () => {
    const app = await setupUpdateApp({ isolate: true });
    await act(async () => app.transition(2));
    expect(app.output()).toBe("2");

    await act(async () => app.data.resolve(2));
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
    expect(app.log).not.toContain("fallback");
  });

  test("commits a transition mount while isolated content loads", async () => {
    const app = await setupMountApp({ isolate: true });
    await act(async () => app.goto("b"));
    expect(app.primary).toHaveTextContent("B");

    await act(async () => app.data.resolve("b"));
    expect(within(app.out).getByRole("button")).toHaveTextContent("content b");
    expect(app.log).not.toContain("fallback");
  });

  test("registers one probe across restarted mount passes", async () => {
    const app = await setupMountApp({ page: "page" });
    await act(async () => app.goto("b"));
    await act(async () => app.restart());
    await act(async () => app.restart());
    expect(app.pageRenders()).toBeGreaterThan(2);
    expect(app.primary).toHaveTextContent("A");
    expect(itemViews(app.out)).toHaveLength(1);

    await act(async () => app.data.resolve("page"));
    await act(async () => app.data.resolve("b"));
    expect(app.primary).toHaveTextContent("B2");
    expect(itemViews(app.out)).toHaveLength(1);
    expect(within(app.out).getByRole("button")).toHaveTextContent("content b");
  });

  test("keeps the probe's fibers when it becomes the real item", async () => {
    const app = await setupMountApp({ page: "page" });
    app.data.resolve("b");
    await act(async () => app.goto("b"));
    const probes = itemViews(app.out);
    expect(probes).toHaveLength(1);

    await act(async () => app.data.resolve("page"));
    expect(app.primary).toHaveTextContent("B");
    expect(itemViews(app.out)).toEqual(probes);
    const button = within(app.out).getByRole("button");
    await act(async () => app.tunnel.refresh());
    expect(within(app.out).getByRole("button")).toBe(button);
    expect(app.log).toEqual(["mount b"]);
  });

  test("re-arms readiness when a restarted pass changes the probe's children", async () => {
    const app = await setupMountApp({ page: "page" });
    app.data.resolve("b");
    await act(async () => app.goto("b"));
    await act(async () => app.tick());
    await act(async () => app.data.resolve("page"));
    expect(app.primary).toHaveTextContent("A");

    await act(async () => app.data.resolve("b1"));
    expect(app.primary).toHaveTextContent("B");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content b1");
    expect(app.log).not.toContain("fallback");
  });

  test("expires a probe whose mount pass never commits", async () => {
    fakeTimeouts();
    spyWarn();
    const app = await setupMountApp({ page: "never" });
    app.data.resolve("b");
    await act(async () => app.goto("b"));
    expect(itemViews(app.out)).toHaveLength(1);

    await advance(59_000);
    expect(itemViews(app.out)).toHaveLength(1);
    await advance(1_000);
    expect(itemViews(app.out)).toHaveLength(0);
    expect(app.primary).toHaveTextContent("A");
  });

  test("drops a probe whose committed ancestor commits without its In", async () => {
    const app = await setupMountApp({ page: "never" });
    await act(async () => app.goto("b"));
    expect(itemViews(app.out)).toHaveLength(1);

    await act(async () => app.gotoUrgent("c"));
    expect(app.primary).toHaveTextContent("C");
    expect(itemViews(app.out)).toHaveLength(0);
  });

  test("commits unverified when readiness times out", async () => {
    fakeTimeouts();
    spyWarn();
    const app = await setupUpdateApp();
    await act(async () => app.transition(2));
    await advance(9_000);
    expect(app.output()).toBe("1 pending");

    await advance(1_000);
    expect(app.output()).toBe("2");
    expect(app.primary).toHaveTextContent("loading");

    await act(async () => app.data.resolve(2));
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
    expect(app.primary).not.toHaveTextContent("loading");
  });

  test("commits unverified while the Out is hidden", async () => {
    const app = await setupUpdateApp();
    await act(async () => app.transition(2));
    expect(app.output()).toBe("1 pending");

    await act(async () => app.hideOut());
    expect(app.output()).toBe("2");

    await act(async () => app.transition(3));
    expect(app.output()).toBe("3");
  });

  test("waits past the acknowledgement window while acknowledged content loads", async () => {
    fakeTimeouts();
    const warnings = spyWarn();
    const app = await setupUpdateApp();
    await act(async () => app.transition(2));
    await advance(5_000);
    expect(app.output()).toBe("1 pending");

    await act(async () => app.data.resolve(2));
    expect(app.output()).toBe("2");
    expect(within(app.out).getByRole("button")).toHaveTextContent("content 2");
    expect(app.log).not.toContain("fallback");
    expect(warnings()).toEqual([]);
  });

  test("reports ready when the gate meets an unrecognized fiber shape", () => {
    const fiber = (fields: Partial<Fiber>) =>
      ({ tag: 0, flags: 0, child: null, sibling: null, ...fields }) as Fiber;
    /** Gate result with `before` as the gate's prior sibling. */
    const check = (before: Fiber) => {
      const top = fiber({});
      const gate = fiber({ return: top });
      before.return = top;
      before.sibling = gate;
      top.child = before;
      return priorWorkCompleted(gate, top);
    };
    expect(check(fiber({ flags: Incomplete }))).toBe(false);
    expect(check(fiber({ tag: 999, flags: undefined }))).toBe(true);
    const drifted = fiber({});
    Object.defineProperty(drifted, "child", {
      get() {
        throw new Error("drifted");
      },
    });
    expect(check(drifted)).toBe(true);
  });

  test("warns in dev when the readiness watchdog fires", async () => {
    fakeTimeouts();
    const warnings = spyWarn();
    const app = await setupUpdateApp();
    await act(async () => app.transition(2));
    await advance(10_000);
    expect(warnings()).toEqual([
      expect.stringContaining("did not finish a transition's value"),
    ]);
  });

  test("warns in dev when a probe expires", async () => {
    fakeTimeouts();
    const warnings = spyWarn();
    const app = await setupMountApp({ page: "never" });
    app.data.resolve("b");
    await act(async () => app.goto("b"));
    await advance(60_000);
    expect(warnings()).toEqual([
      expect.stringContaining("transition mount did not commit"),
    ]);
  });

  test("classifies a mount inside a retrying boundary as urgent", async () => {
    const tunnel = fiberTunnel();
    const data = createResource<string>();
    let setShow!: (show: boolean) => void;
    let start!: (fn: () => void) => void;
    function Loader() {
      data.useData("page");
      return <h1>page</h1>;
    }
    function App() {
      const [show, set] = useState(false);
      const [, startTransition] = useTransition();
      setShow = set;
      start = startTransition;
      return (
        <Suspense fallback={<p>loading</p>}>
          {show && (
            <tunnel.In>
              <button>content</button>
            </tunnel.In>
          )}
          <Loader />
        </Suspense>
      );
    }
    const primary = render(<App />);
    const out = await mountOut(tunnel);
    expect(primary.container).toHaveTextContent("loading");

    await act(async () => start(() => setShow(true)));
    expect(itemViews(out.container)).toHaveLength(0);

    await act(async () => data.resolve("page"));
    expect(primary.container).toHaveTextContent("page");
    expect(within(out.container).getByRole("button")).toHaveTextContent(
      "content",
    );
    expect(itemViews(out.container)).toHaveLength(1);
  });

  test("keeps the committed value at the Out when a transition is abandoned", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    const Value = createContext(0);
    const data = createResource<string>();
    data.resolve("a");
    function Content() {
      return <button>content {useContext(Value)}</button>;
    }
    function Page({ id }: { id: string }) {
      data.useData(id);
      return <h1>page {id}</h1>;
    }
    let setState!: (state: { v: number; page: string }) => void;
    let setTick!: (tick: number) => void;
    let start!: (fn: () => void) => void;
    function App() {
      const [state, set] = useState({ v: 1, page: "a" });
      const [tick, setT] = useState(0);
      const [pending, startT] = useTransition();
      setState = set;
      setTick = setT;
      start = startT;
      return (
        <Value value={state.v}>
          <Suspense fallback={<p>loading</p>}>
            <t.In>
              <Content />
            </t.In>
            <Page id={state.page} />
          </Suspense>
          <output>
            {state.v}
            {pending ? " pending" : ""} t{tick}
          </output>
        </Value>
      );
    }
    const primary = (await mountDomRoot(<App />, "primary")).container;
    const out = (await mountDomRoot(<t.Out />)).container;
    await settleOut(t);
    const output = () => primary.querySelector("output")!.textContent;

    await act(async () => start(() => setState({ v: 2, page: "b" })));
    expect(output()).toBe("1 pending t0");
    // An urgent re-render of the In keeps the transition pending.
    await act(async () => setTick(1));
    expect(within(out).getByRole("button")).toHaveTextContent("content 1");

    // Abandon: an urgent update back to the committed value.
    await act(async () => setState({ v: 1, page: "a" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => void vi.advanceTimersByTime(70_000));
    vi.useRealTimers();
    expect(output()).toBe("1 t1");
    expect(within(out).getByRole("button")).toHaveTextContent("content 1");
  });

  test("waits for the Out when a FiberAnchor bridge owns the source", async () => {
    const t = fiberTunnel();
    const Value = createContext(0);
    const data = createResource<number>();
    data.resolve(1);
    const nested = await mountHostRoot(null);
    let fallbacks = 0;
    function Fallback() {
      useLayoutEffect(() => void fallbacks++, []);
      return <p>loading</p>;
    }
    function Content() {
      const v = useContext(Value);
      data.useData(v);
      return <button>content {v}</button>;
    }
    function Leaf() {
      return <b>{useContext(Value)}</b>;
    }
    function SceneRoot({ bridge }: { bridge: ContextBridgeValue }) {
      useLayoutEffect(() => {
        nested.render(
          <ContextBridge bridge={bridge}>
            <Leaf />
          </ContextBridge>,
        );
      }, [bridge]);
      return null;
    }
    function Scene() {
      return (
        <FiberAnchor>{(bridge) => <SceneRoot bridge={bridge} />}</FiberAnchor>
      );
    }
    let setValue!: (v: number) => void;
    let start!: (fn: () => void) => void;
    function App() {
      const [v, set] = useState(1);
      const [pending, startT] = useTransition();
      setValue = set;
      start = startT;
      return (
        <Value value={v}>
          <Scene />
          <Suspense fallback={<Fallback />}>
            <t.In>
              <Content />
            </t.In>
          </Suspense>
          <output>
            {v}
            {pending ? " pending" : ""}
          </output>
        </Value>
      );
    }
    const primary = (await mountDomRoot(<App />, "primary")).container;
    const out = (await mountDomRoot(<t.Out />)).container;
    await settleOut(t);
    const output = () => primary.querySelector("output")!.textContent;
    expect(nested.text()).toBe("1");

    await act(async () => start(() => setValue(2)));
    expect(output()).toBe("1 pending");
    expect(within(out).getByRole("button")).toHaveTextContent("content 1");

    await act(async () => data.resolve(2));
    expect(output()).toBe("2");
    expect(within(out).getByRole("button")).toHaveTextContent("content 2");
    expect(nested.text()).toBe("2");
    expect(fallbacks).toBe(0);
  });

  // React 19.2 replays StrictMode effects below every fiber a keyed move
  // passes.
  test("keeps the primary pending when a StrictMode move replays the Out's waiting group", async () => {
    const t = fiberTunnel();
    const data = createResource<string>();
    data.resolve("light");
    function Content() {
      const theme = use(Theme);
      data.useData(theme);
      return <button>content {theme}</button>;
    }
    const content = <Content />;
    let setTheme!: (theme: string) => void;
    let setOrder!: (order: string[]) => void;
    function App() {
      const [theme, setT] = useState("light");
      const [order, setO] = useState(["x", "y"]);
      setTheme = setT;
      setOrder = setO;
      return (
        <>
          <p>{theme}</p>
          {order.map((key) =>
            key === "x" ? (
              <Theme key="x" value={theme}>
                <t.In>{content}</t.In>
              </Theme>
            ) : (
              <t.In key="y">
                <button>y</button>
              </t.In>
            ),
          )}
        </>
      );
    }
    const out = await mountDomRoot(
      <StrictMode>
        <t.Out />
      </StrictMode>,
    );
    await settleOut(t);
    const { container } = render(<App />);
    await flush();
    const primary = container.querySelector("p")!;
    expect(labelsIn(out.container)).toEqual(["content light", "y"]);

    await act(async () => startTransition(() => setTheme("dark")));
    expect(primary).toHaveTextContent("light");
    // The Out's Theme group moves behind y.
    await act(async () => setOrder(["y", "x"]));
    expect(primary).toHaveTextContent("light");

    await act(async () => data.resolve("dark"));
    expect(primary).toHaveTextContent("dark");
    expect(labelsIn(out.container)).toEqual(["y", "content dark"]);
  });

  test("keeps a transition mount pending when a StrictMode move replays its nested Out", async () => {
    const t = fiberTunnel();
    const u = fiberTunnel();
    const data = createResource<string>();
    function Content() {
      data.useData("b");
      return <button>content b</button>;
    }
    let setPage!: (page: string) => void;
    let setOrder!: (order: string[]) => void;
    function App() {
      const [page, setP] = useState("a");
      const [order, setO] = useState(["p", "q"]);
      setPage = setP;
      setOrder = setO;
      return (
        <>
          <p>{page}</p>
          {order.map((key) =>
            key === "p" ? (
              <t.In key="p">
                <u.Out />
              </t.In>
            ) : (
              <t.In key="q">
                <button>q</button>
              </t.In>
            ),
          )}
          {page === "b" && (
            <u.In>
              <Content />
            </u.In>
          )}
        </>
      );
    }
    const out = await mountDomRoot(
      <StrictMode>
        <t.Out />
      </StrictMode>,
    );
    await settleOut(t);
    const { container } = render(<App />);
    await settleOut(u);
    const primary = container.querySelector("p")!;

    await act(async () => startTransition(() => setPage("b")));
    expect(primary).toHaveTextContent("a");
    // u's Out, inside p's content, moves behind q.
    await act(async () => setOrder(["q", "p"]));
    expect(primary).toHaveTextContent("a");

    await act(async () => data.resolve("b"));
    expect(primary).toHaveTextContent("b");
    expect(labelsIn(out.container)).toEqual(["q", "content b"]);
  });
});
/* eslint-enable react-hooks/globals */

/** Visible button labels, in DOM order. */
function visibleLabels() {
  return screen.queryAllByRole("button").map((button) => button.textContent);
}

/** Button labels in the DOM, hidden included. */
function domLabels() {
  return screen
    .queryAllByRole("button", { hidden: true })
    .map((button) => button.textContent);
}

/** A button counting its clicks. */
function HidingCounter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      {label} {count}
    </button>
  );
}

describe("hiding", () => {
  describe.each([{ bridge: false }, { bridge: true }])(
    "bridge: $bridge",
    ({ bridge }) => {
      test("keeps content state while Activity hides its In", async () => {
        const t = fiberTunnel({ bridge });
        function App({ mode }: { mode: "visible" | "hidden" }) {
          return (
            <>
              <Activity mode={mode}>
                <t.In>
                  <HidingCounter label="A" />
                </t.In>
              </Activity>
              <t.In>
                <HidingCounter label="B" />
              </t.In>
              <t.Out />
            </>
          );
        }

        const { rerender } = render(<App mode="visible" />);
        const button = screen.getByText("A 0");
        fireEvent.click(button);
        await act(async () => rerender(<App mode="hidden" />));
        expect(visibleLabels()).toEqual(["B 0"]);
        expect(domLabels()).toEqual(["A 1", "B 0"]);

        await act(async () => rerender(<App mode="visible" />));
        expect(visibleLabels()).toEqual(["A 1", "B 0"]);
        expect(screen.getByText("A 1")).toBe(button);
      });

      test("keeps content state while Suspense hides its In", async () => {
        const t = fiberTunnel({ bridge });
        const resource = createResource<string>();
        function Data({ suspended }: { suspended: boolean }) {
          if (suspended) resource.useData("x");
          return null;
        }
        function App({ suspended }: { suspended: boolean }) {
          return (
            <>
              <Suspense fallback={null}>
                <Data suspended={suspended} />
                <t.In>
                  <HidingCounter label="A" />
                </t.In>
              </Suspense>
              <t.In>
                <HidingCounter label="B" />
              </t.In>
              <t.Out />
            </>
          );
        }

        const { rerender } = render(<App suspended={false} />);
        const button = screen.getByText("A 0");
        fireEvent.click(button);
        await act(async () => rerender(<App suspended={true} />));
        expect(visibleLabels()).toEqual(["B 0"]);
        expect(domLabels()).toEqual(["A 1", "B 0"]);

        await act(async () => resource.resolve("x"));
        expect(visibleLabels()).toEqual(["A 1", "B 0"]);
        expect(screen.getByText("A 1")).toBe(button);
      });

      test("removes content when its In unmounts", async () => {
        const t = fiberTunnel({ bridge });
        function App({ show }: { show: boolean }) {
          return (
            <>
              {show && (
                <t.In>
                  <HidingCounter label="A" />
                </t.In>
              )}
              <t.In>
                <HidingCounter label="B" />
              </t.In>
              <t.Out />
            </>
          );
        }

        const { rerender } = render(<App show={true} />);
        fireEvent.click(screen.getByText("A 0"));
        await act(async () => rerender(<App show={false} />));
        expect(domLabels()).toEqual(["B 0"]);

        await act(async () => rerender(<App show={true} />));
        expect(visibleLabels()).toEqual(["A 0", "B 0"]);
      });

      test("removes content when its subtree is deleted while hidden", async () => {
        const t = fiberTunnel({ bridge });
        function App({
          mode,
          show,
        }: {
          mode: "visible" | "hidden";
          show: boolean;
        }) {
          return (
            <>
              <Activity mode={mode}>
                {show && (
                  <div>
                    <t.In>
                      <HidingCounter label="A" />
                    </t.In>
                  </div>
                )}
              </Activity>
              <t.In>
                <HidingCounter label="B" />
              </t.In>
              <t.Out />
            </>
          );
        }

        const { rerender } = render(<App mode="visible" show={true} />);
        await act(async () => rerender(<App mode="hidden" show={true} />));
        expect(domLabels()).toEqual(["A 0", "B 0"]);

        await act(async () => rerender(<App mode="hidden" show={false} />));
        expect(domLabels()).toEqual(["B 0"]);

        await act(async () => rerender(<App mode="visible" show={false} />));
        expect(domLabels()).toEqual(["B 0"]);
      });

      test("removes content when a hidden Activity unmounts", async () => {
        const t = fiberTunnel({ bridge });
        function App({
          mode,
          show,
        }: {
          mode: "visible" | "hidden";
          show: boolean;
        }) {
          return (
            <>
              {show && (
                <Activity mode={mode}>
                  <t.In>
                    <HidingCounter label="A" />
                  </t.In>
                </Activity>
              )}
              <t.In>
                <HidingCounter label="B" />
              </t.In>
              <t.Out />
            </>
          );
        }

        const { rerender } = render(<App mode="visible" show={true} />);
        await act(async () => rerender(<App mode="hidden" show={true} />));
        expect(domLabels()).toEqual(["A 0", "B 0"]);

        await act(async () => rerender(<App mode="hidden" show={false} />));
        expect(domLabels()).toEqual(["B 0"]);
      });
    },
  );

  test("hides content that finishes loading while its In is hidden", async () => {
    const t = fiberTunnel();
    const data = createResource<string>();
    function Content() {
      data.useData("x");
      return <button>content</button>;
    }
    let setMode!: (mode: "visible" | "hidden") => void;
    function App() {
      const [mode, set] = useState<"visible" | "hidden">("visible");
      useLayoutEffect(() => {
        setMode = set;
      }, [set]);
      return (
        <Activity mode={mode}>
          <Suspense fallback={<p>loading</p>}>
            <t.In>
              <Content />
            </t.In>
          </Suspense>
        </Activity>
      );
    }
    await mountDomRoot(<App />, "primary");
    const out = (await mountDomRoot(<t.Out />)).container;
    await act(async () => {});
    await act(async () => setMode("hidden"));
    await act(async () => data.resolve("x"));
    expect(within(out).queryByRole("button")).toBeNull();
    await act(async () => setMode("visible"));
    expect(within(out).getByRole("button")).toHaveTextContent("content");
  });

  test.each([{ bridge: false }, { bridge: true }])(
    "removes deleted content in one Out commit (bridge: $bridge)",
    async ({ bridge }) => {
      const t = fiberTunnel({ bridge });
      let setShow!: (show: boolean) => void;
      function App() {
        const [show, set] = useState(true);
        useLayoutEffect(() => {
          setShow = set;
        }, [set]);
        return show ? (
          <t.In>
            <button>content</button>
          </t.In>
        ) : null;
      }
      await mountDomRoot(<App />, "primary");
      const out = (await mountDomRoot(<t.Out />)).container;
      await act(async () => {});
      let batches = 0;
      const observer = new MutationObserver(() => void batches++);
      observer.observe(out, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      await act(async () => setShow(false));
      observer.disconnect();
      expect(out.textContent).toBe("");
      expect(batches).toBe(1);
    },
  );
});

function sortLabelsIn(node: ParentNode = document.body) {
  return [...node.querySelectorAll("button")].map((b) => b.textContent);
}

/** Item content labels in the Out's committed fiber order, content still
 * suspended included. Content elements carry a `label` prop. */
function itemOrder(container: HTMLElement): string[] {
  interface FiberNode {
    child: FiberNode | null;
    sibling: FiberNode | null;
    stateNode: unknown;
    memoizedProps: {
      item?: unknown;
      children?: ReactElement<{ label: string }>;
    } | null;
  }
  const key = Object.keys(container).find((k) =>
    k.startsWith("__reactContainer$"),
  )!;
  const created = (container as unknown as Record<string, FiberNode>)[key];
  const top = (created.stateNode as { current: FiberNode }).current;
  const labels: string[] = [];
  const visit = (fiber: FiberNode) => {
    const props = fiber.memoizedProps;
    if (props?.item && props.children) {
      labels.push(props.children.props.label);
      return;
    }
    for (let c = fiber.child; c; c = c.sibling) visit(c);
  };
  visit(top);
  return labels;
}

afterEach(() => {
  vi.useRealTimers();
});

/** Node's task queue, beside jsdom's globals. */
const nodeGlobals = globalThis as unknown as {
  setImmediate: (callback: () => void) => void;
};

/** Freezes `Date`: the dev cross-check re-sorts at most once per 100 ms,
 * so only its first run with two items sorts. */
function freezeCrossCheck() {
  vi.useFakeTimers({ toFake: ["Date"] });
}

describe("sort", () => {
  test("orders content by current positions after a parent bails out", async () => {
    const t = fiberTunnel();
    const Leaf = memo(function Leaf({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });
    function App({ n, first, showB }: AppProps) {
      return (
        <>
          <div data-n={n}>
            <Leaf label={first} />
            {showB && <Leaf label="B" />}
            <Leaf label="C" />
          </div>
          <t.Out />
        </>
      );
    }
    interface AppProps {
      n: number;
      first: string;
      showB: boolean;
    }

    const { rerender } = render(<App n={0} first="A" showB={false} />);
    // A's In gains a second generation; later passes bail out above it.
    await act(async () => rerender(<App n={0} first="A1" showB={false} />));
    await act(async () => rerender(<App n={1} first="A1" showB={false} />));
    await act(async () => rerender(<App n={2} first="A1" showB={false} />));
    await act(async () => rerender(<App n={3} first="A1" showB={true} />));

    expect(buttonLabels()).toEqual(["A1", "B", "C"]);
  });

  test("reorders content moved without re-rendering its In before the next paint", async () => {
    const t = fiberTunnel();
    let leafRenders = 0;
    const Leaf = memo(function Leaf({ label }: { label: string }) {
      "use no memo";
      leafRenders++;
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <>
          {order.map((label) => (
            <Leaf key={label} label={label} />
          ))}
          <t.Out />
        </>
      );
    }

    // Real scheduling: act would flush scheduled tasks too.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<App order={["A", "B", "C"]} />));
      await vi.waitFor(() =>
        expect(sortLabelsIn(container)).toEqual(["A", "B", "C"]),
      );
      leafRenders = 0;

      flushSync(() => root.render(<App order={["C", "A", "B"]} />));
      // Runs after this task's microtasks, before tasks queued later.
      const labels = await new Promise((resolve) =>
        nodeGlobals.setImmediate(() => resolve(sortLabelsIn(container))),
      );

      expect(labels).toEqual(["C", "A", "B"]);
      expect(leafRenders).toBe(0);
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  test("reorders content under a memoized ancestor", async () => {
    const t = fiberTunnel();
    const Group = memo(function Group({ labels }: { labels: string[] }) {
      "use no memo";
      return (
        <section>
          {labels.map((label) => (
            <div key={label}>
              <t.In>
                <button>{label}</button>
              </t.In>
            </div>
          ))}
        </section>
      );
    });
    function App({ groups }: { groups: string[][] }) {
      return (
        <>
          <div>
            {groups.map((group) => (
              <Group key={group[0]} labels={group} />
            ))}
          </div>
          <t.Out />
        </>
      );
    }
    const first = ["A", "B"];
    const second = ["C", "D"];

    const { rerender } = render(<App groups={[first, second]} />);
    await act(async () => rerender(<App groups={[second, first]} />));

    expect(buttonLabels()).toEqual(["C", "D", "A", "B"]);
  });

  test("reorders content when its list reorders the same element objects", async () => {
    const t = fiberTunnel();
    function Leaf({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    }
    const elements = [
      <Leaf key="A" label="A" />,
      <Leaf key="B" label="B" />,
      <Leaf key="C" label="C" />,
    ];
    let setList!: (list: ReactElement[]) => void;
    function List() {
      "use no memo";
      const [list, set] = useState(elements);
      useLayoutEffect(() => {
        setList = set;
      }, [set]);
      return <ul>{list}</ul>;
    }

    render(
      <>
        <List />
        <t.Out />
      </>,
    );
    await act(async () => setList([elements[2], elements[0], elements[1]]));

    expect(buttonLabels()).toEqual(["C", "A", "B"]);
  });

  test("reorders anchored content when its anchor moves", async () => {
    const t = fiberTunnel();
    const Canvas = memo(function Canvas({ name }: { name: string }) {
      return (
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <button>{name}1</button>
            </t.In>
            <t.In>
              <button>{name}2</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <>
          <t.In>
            <button>A</button>
          </t.In>
          {order.map((name) => (
            <Canvas key={name} name={name} />
          ))}
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App order={["X", "Y"]} />);
    expect(buttonLabels()).toEqual(["A", "X1", "X2", "Y1", "Y2"]);
    await act(async () => rerender(<App order={["Y", "X"]} />));

    expect(buttonLabels()).toEqual(["A", "Y1", "Y2", "X1", "X2"]);
  });

  test("reorders content moved inside a hidden Activity", async () => {
    const t = fiberTunnel();
    const Leaf = memo(function Leaf({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });
    function App({
      mode,
      order,
    }: {
      mode: "visible" | "hidden";
      order: string[];
    }) {
      return (
        <>
          <t.In>
            <button>Z</button>
          </t.In>
          <Activity mode={mode}>
            <ul>
              {order.map((label) => (
                <Leaf key={label} label={label} />
              ))}
            </ul>
          </Activity>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App mode="visible" order={["A", "B"]} />);
    await act(async () => rerender(<App mode="hidden" order={["A", "B"]} />));
    await act(async () => rerender(<App mode="hidden" order={["B", "A"]} />));
    expect(sortLabelsIn()).toEqual(["Z", "B", "A"]);

    await act(async () => rerender(<App mode="visible" order={["B", "A"]} />));
    expect(buttonLabels()).toEqual(["Z", "B", "A"]);
  });

  test("skips the sort on a children-only update", async () => {
    freezeCrossCheck();
    const t = fiberTunnel();
    function App({ label }: { label: string }) {
      return (
        <>
          <t.In>
            <button>{label}</button>
          </t.In>
          <t.In>
            <button>B</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App label="A" />);
    await act(async () => {});
    vi.mocked(sortByKey).mockClear();
    await act(async () => rerender(<App label="A2" />));

    expect(buttonLabels()).toEqual(["A2", "B"]);
    expect(sortByKey).not.toHaveBeenCalled();
  });

  test("skips the sort on a commit that inserts or deletes siblings without Ins", async () => {
    freezeCrossCheck();
    const t = fiberTunnel();
    function App({ order }: { order: string[] }) {
      return (
        <>
          <div>
            {order.map((key) =>
              key === "A" || key === "B" ? (
                <t.In key={key}>
                  <button>{key}</button>
                </t.In>
              ) : (
                <i key={key} />
              ),
            )}
          </div>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App order={["A", "B"]} />);
    await act(async () => {});
    vi.mocked(sortByKey).mockClear();
    await act(async () => rerender(<App order={["x", "A", "y", "B"]} />));
    await act(async () => rerender(<App order={["A", "y", "B"]} />));
    await act(async () => rerender(<App order={["A", "B"]} />));

    expect(buttonLabels()).toEqual(["A", "B"]);
    expect(sortByKey).not.toHaveBeenCalled();
  });

  test("re-sorts only the tunnels whose Ins change relative order", async () => {
    freezeCrossCheck();
    const labels = ["A", "B", "C", "D"];
    const every = fiberTunnel();
    const sparse = fiberTunnel();
    const own = new Map(labels.map((label) => [label, fiberTunnel()]));
    const Card = memo(function Card({ label }: { label: string }) {
      const single = own.get(label)!;
      return (
        <>
          <every.In>
            <button>{label}</button>
          </every.In>
          {(label === "A" || label === "C") && (
            <sparse.In>
              <button>{label}</button>
            </sparse.In>
          )}
          <single.In>
            <button>{label}</button>
          </single.In>
        </>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <>
          <div>
            {order.map((label) => (
              <Card key={label} label={label} />
            ))}
          </div>
          <div className="every">
            <every.Out />
          </div>
          <div className="sparse">
            <sparse.Out />
          </div>
          {labels.map((label) => {
            const single = own.get(label)!;
            return (
              <div key={label} className={`own-${label}`}>
                <single.Out />
              </div>
            );
          })}
        </>
      );
    }

    const { rerender, container } = render(<App order={labels} />);
    await flush();
    vi.mocked(sortByKey).mockClear();
    // React marks A, B, and C moved.
    await act(async () => rerender(<App order={["D", "A", "B", "C"]} />));

    const at = (name: string) => labelsIn(container.querySelector(name)!);
    expect(at(".every")).toEqual(["D", "A", "B", "C"]);
    expect(at(".sparse")).toEqual(["A", "C"]);
    for (const label of labels) expect(at(`.own-${label}`)).toEqual([label]);
    expect(sortByKey).toHaveBeenCalledTimes(1);
  });

  test("keeps passed items' content when a StrictMode keyed move replays their effects", async () => {
    // React 19.2 replays effects below every fiber a keyed move passes.
    const t = fiberTunnel();
    const Card = memo(function Card({ label }: { label: string }) {
      return (
        <t.In>
          <button>{label}</button>
        </t.In>
      );
    });
    function App({ order }: { order: string[] }) {
      return (
        <StrictMode>
          {order.map((label) => (
            <Card key={label} label={label} />
          ))}
          <t.Out />
        </StrictMode>
      );
    }

    const { rerender } = render(<App order={["A", "B", "C", "D", "E", "F"]} />);
    await flush();
    const renders = vi.spyOn(ItemView.prototype, "render");
    await act(async () =>
      rerender(<App order={["F", "A", "B", "C", "D", "E"]} />),
    );

    expect(buttonLabels()).toEqual(["F", "A", "B", "C", "D", "E"]);
    expect(renders).not.toHaveBeenCalled();
  });

  test("places a probe by its committed ancestor's position before it commits", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    for (const label of ["A", "B", "C"]) resource.resolve(label);
    function Content({ label }: { label: string }) {
      resource.useData(label);
      return <button>{label}</button>;
    }
    let setOrder!: (order: string[]) => void;
    function List() {
      "use no memo";
      const [order, set] = useState(["A", "B", "C"]);
      useLayoutEffect(() => {
        setOrder = set;
      }, [set]);
      return (
        <ul>
          {order.map((label) => (
            <li key={label}>
              <t.In>
                <Content label={label} />
              </t.In>
            </li>
          ))}
        </ul>
      );
    }

    const { container: out } = await mountDomRoot(<t.Out />);
    await settleOut(t);
    const { container } = render(<List />);
    await act(async () => {});

    await act(async () =>
      startTransition(() => setOrder(["A", "X", "B", "C"])),
    );
    // The mount pass waits on X's content; the Out holds its probe.
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(itemOrder(out)).toEqual(["A", "X", "B", "C"]);
    expect(sortLabelsIn(out)).toEqual(["A", "B", "C"]);

    await act(async () => resource.resolve("X"));
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(sortLabelsIn(out)).toEqual(["A", "X", "B", "C"]);
  });

  test("re-sorts a probe when its committed ancestor's children reorder", async () => {
    const warnings = spyWarn();
    const t = fiberTunnel();
    const resource = createResource<string>();
    resource.resolve("X");
    function Content({ label }: { label: string }) {
      resource.useData(label);
      return <button>{label}</button>;
    }
    let setOrder!: (order: string[]) => void;
    let setShowN!: (show: boolean) => void;
    function List() {
      "use no memo";
      const [order, setO] = useState(["Y", "X"]);
      const [showN, setN] = useState(false);
      useLayoutEffect(() => {
        setOrder = setO;
        setShowN = setN;
      }, [setO, setN]);
      const items = order.map((label) => (
        <li key={label}>
          {label === "X" && (
            <t.In>
              <Content label="X" />
            </t.In>
          )}
        </li>
      ));
      if (showN) {
        items.splice(
          1,
          0,
          <li key="N">
            <t.In>
              <Content label="N" />
            </t.In>
          </li>,
        );
      }
      return <ul>{items}</ul>;
    }

    const { container: out } = await mountDomRoot(<t.Out />);
    await settleOut(t);
    render(<List />);
    await act(async () => {});
    await act(async () => startTransition(() => setShowN(true)));
    expect(itemOrder(out)).toEqual(["N", "X"]);

    // X passes the probe; N's pass keeps its rank.
    await act(async () => setOrder(["X", "Y"]));
    expect(itemOrder(out)).toEqual(["X", "N"]);

    await act(async () => resource.resolve("N"));
    expect(sortLabelsIn(out)).toEqual(["X", "N"]);
    expect(warnings()).toEqual([]);
  });

  test("places a probe under a FiberAnchor mounting in its pass by its committed ancestor's position", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    for (const label of ["A", "B", "C"]) resource.resolve(label);
    function Content({ label }: { label: string }) {
      resource.useData(label);
      return <button>{label}</button>;
    }
    let setOrder!: (order: string[]) => void;
    function List() {
      "use no memo";
      const [order, set] = useState(["A", "B", "C"]);
      useLayoutEffect(() => {
        setOrder = set;
      }, [set]);
      return (
        <ul>
          {order.map((label) => (
            <li key={label}>
              <FiberAnchor>
                <t.In>
                  <Content label={label} />
                </t.In>
              </FiberAnchor>
            </li>
          ))}
        </ul>
      );
    }

    const { container: out } = await mountDomRoot(<t.Out />);
    await settleOut(t);
    render(<List />);
    await act(async () => {});

    await act(async () =>
      startTransition(() => setOrder(["A", "X", "B", "C"])),
    );
    expect(itemOrder(out)).toEqual(["A", "X", "B", "C"]);

    await act(async () => resource.resolve("X"));
    expect(sortLabelsIn(out)).toEqual(["A", "X", "B", "C"]);
  });

  test("orders a probe at commit when its pass also moves committed siblings", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    for (const label of ["A", "B", "C"]) resource.resolve(label);
    function Content({ label }: { label: string }) {
      resource.useData(label);
      return <button>{label}</button>;
    }
    let setOrder!: (order: string[]) => void;
    function List() {
      "use no memo";
      const [order, set] = useState(["A", "B", "C"]);
      useLayoutEffect(() => {
        setOrder = set;
      }, [set]);
      return (
        <ul>
          {order.map((label) => (
            <li key={label}>
              <t.In>
                <Content label={label} />
              </t.In>
            </li>
          ))}
        </ul>
      );
    }

    const { container: out } = await mountDomRoot(<t.Out />);
    await settleOut(t);
    const { container } = render(<List />);
    await act(async () => {});

    await act(async () =>
      startTransition(() => setOrder(["C", "X", "A", "B"])),
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(sortLabelsIn(out)).toEqual(["A", "B", "C"]);

    await act(async () => resource.resolve("X"));
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(sortLabelsIn(out)).toEqual(["C", "X", "A", "B"]);
  });

  test("keeps an `Activity`-hidden In's content in position", async () => {
    const t = fiberTunnel();
    function App({
      mode,
      showFirst,
    }: {
      mode: "visible" | "hidden";
      showFirst: boolean;
    }) {
      return (
        <>
          {showFirst && (
            <t.In>
              <button>First</button>
            </t.In>
          )}
          <t.In>
            <button>A</button>
          </t.In>
          <Activity mode={mode}>
            <t.In>
              <button>B</button>
            </t.In>
          </Activity>
          <t.In>
            <button>C</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App mode="visible" showFirst={false} />);
    await act(async () => rerender(<App mode="hidden" showFirst={false} />));
    expect(buttonLabels()).toEqual(["A", "C"]);
    expect(sortLabelsIn()).toEqual(["A", "B", "C"]);

    // A mount re-sorts while B is hidden.
    await act(async () => rerender(<App mode="hidden" showFirst={true} />));
    expect(buttonLabels()).toEqual(["First", "A", "C"]);
    expect(sortLabelsIn()).toEqual(["First", "A", "B", "C"]);

    await act(async () => rerender(<App mode="visible" showFirst={true} />));
    expect(buttonLabels()).toEqual(["First", "A", "B", "C"]);
  });

  test("orders a hidden primary before its Suspense fallback", async () => {
    const t = fiberTunnel();
    const resource = createResource<string>();
    function Gate({ suspended }: { suspended: boolean }) {
      if (suspended) resource.useData("gate");
      return null;
    }
    function App({ suspended }: { suspended: boolean }) {
      return (
        <>
          <t.In>
            <button>A</button>
          </t.In>
          <Suspense
            fallback={
              <t.In>
                <button>Fallback</button>
              </t.In>
            }
          >
            <Gate suspended={suspended} />
            <t.In>
              <button>Primary</button>
            </t.In>
          </Suspense>
          <t.In>
            <button>Z</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App suspended={false} />);
    await act(async () => rerender(<App suspended={true} />));
    expect(buttonLabels()).toEqual(["A", "Fallback", "Z"]);
    expect(sortLabelsIn()).toEqual(["A", "Primary", "Fallback", "Z"]);

    await act(async () => resource.resolve("gate"));
    expect(sortLabelsIn()).toEqual(["A", "Primary", "Z"]);
  });

  test("orders a nested root's content by its anchor, then its own position", async () => {
    const t = fiberTunnel();
    function Canvas({ name, inner }: { name: string; inner: string[] }) {
      return (
        <FiberAnchor>
          <ChildRoot>
            {inner.map((label) => (
              <t.In key={label}>
                <button>
                  {name}
                  {label}
                </button>
              </t.In>
            ))}
          </ChildRoot>
        </FiberAnchor>
      );
    }
    function App({ inner }: { inner: string[] }) {
      return (
        <>
          <t.In>
            <button>A</button>
          </t.In>
          <Canvas name="X" inner={inner} />
          <Canvas name="Y" inner={["1", "2"]} />
          <t.In>
            <button>Z</button>
          </t.In>
          <t.Out />
        </>
      );
    }

    const { rerender } = render(<App inner={["1", "2"]} />);
    expect(buttonLabels()).toEqual(["A", "X1", "X2", "Y1", "Y2", "Z"]);

    await act(async () => rerender(<App inner={["2", "0", "1"]} />));
    expect(buttonLabels()).toEqual(["A", "X2", "X0", "X1", "Y1", "Y2", "Z"]);
  });

  test("sorts once per Out render when many Ins mount in one commit", async () => {
    freezeCrossCheck();
    const t = fiberTunnel();
    // StrictMode renders the Out twice per update.
    function App({ count }: { count: number }) {
      return (
        <StrictMode>
          {Array.from({ length: count }, (_, i) => (
            <t.In key={i}>
              <button>{i}</button>
            </t.In>
          ))}
          <t.Out />
        </StrictMode>
      );
    }

    const { rerender } = render(<App count={2} />);
    await act(async () => {});
    vi.mocked(sortByKey).mockClear();
    await act(async () => rerender(<App count={200} />));

    expect(buttonLabels()).toEqual(
      Array.from({ length: 200 }, (_, i) => `${i}`),
    );
    expect(sortByKey).toHaveBeenCalledTimes(1);
  });
});

const hookKey = Symbol.for("fiber-tunnel.commit-hook");
const fallbackPrefix = "fiber-tunnel: move detection is off";

afterEach(() => {
  vi.restoreAllMocks();
});

/** FiberRoot behind a react-dom root. */
function fiberRootOf(root: Root): FiberRootLike {
  return (root as unknown as { _internalRoot: FiberRootLike })._internalRoot;
}

/** Button labels under `container`, in DOM order. */
function labels(container: HTMLElement) {
  return [...container.querySelectorAll("button")].map((b) => b.textContent);
}

/** Silenced console.warn spy. */
function hookSpyWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** Silenced console.error spy. */
function spyError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** First fiber of `type` in a depth-first walk. */
function findFiber(fiber: Fiber | null, type: unknown): Fiber | null {
  for (let f = fiber; f; f = f.sibling) {
    if (f.type === type) return f;
    const found = findFiber(f.child, type);
    if (found) return found;
  }
  return null;
}

/** An accessor on `current` from another library: stores and counts. */
function defineForeignAccessor(root: FiberRootLike, throws = false) {
  let stored = root.current;
  const foreign = {
    sets: 0,
    get value() {
      return stored;
    },
  };
  Object.defineProperty(root, "current", {
    configurable: true,
    enumerable: true,
    get: () => stored,
    set(value: Fiber) {
      foreign.sets++;
      if (throws) throw new Error("foreign setter");
      stored = value;
    },
  });
  return foreign;
}

/** Memoized In: a keyed move re-renders no In. */
const Tile = memo(function Tile({
  tunnel,
  label,
}: {
  tunnel: FiberTunnel;
  label: string;
}) {
  return (
    <tunnel.In>
      <button>{label}</button>
    </tunnel.In>
  );
});

function Tiles({ tunnel, order }: { tunnel: FiberTunnel; order: string[] }) {
  "use no memo";
  return order.map((label) => (
    <Tile key={label} tunnel={tunnel} label={label} />
  ));
}

/** Tiles in `order`, an optional trailing tile, then the Out. */
function Board({
  tunnel,
  order,
  extra,
}: {
  tunnel: FiberTunnel;
  order: string[];
  extra?: string;
}) {
  "use no memo";
  return (
    <>
      <Tiles tunnel={tunnel} order={order} />
      {extra && <Tile tunnel={tunnel} label={extra} />}
      <tunnel.Out />
    </>
  );
}

/** Logs each of its commits. */
function Top({
  onLayout,
  children,
}: {
  n: number;
  onLayout: () => void;
  children: ReactNode;
}) {
  "use no memo";
  useLayoutEffect(() => void onLayout());
  return children;
}

describe("commit hook", () => {
  test("fires once per commit in react-dom and `react-reconciler` roots", async () => {
    const warn = hookSpyWarn();

    // react-dom
    {
      const t = fiberTunnel();
      const out = await mountDomRoot(<t.Out />);
      let layouts = 0;
      const ui = (n: number) => (
        <StrictMode>
          <Top n={n} onLayout={() => layouts++}>
            <Tiles tunnel={t} order={["A", "B"]} />
          </Top>
        </StrictMode>
      );
      const { root } = await mountDomRoot(ui(0));
      const fiberRoot = fiberRootOf(root);
      const hook = commitHookOf(fiberRoot)!;
      expect(hook).not.toBeNull();
      expect(hook.last).toBe(fiberRoot.current);

      let commits = 0;
      hook.listeners.add(() => commits++);
      layouts = 0;
      await act(async () => root.render(ui(1)));
      await act(async () => root.render(ui(2)));
      await act(async () => startTransition(() => root.render(ui(3))));
      expect(layouts).toBe(3);
      expect(commits).toBe(3);
      expect(hook.last).toBe(fiberRoot.current);
      expect(labels(out.container)).toEqual(["A", "B"]);
    }

    // react-reconciler
    {
      const t = fiberTunnel();
      const out = await mountDomRoot(<t.Out />);
      let layouts = 0;
      const ui = (n: number) => (
        <Top n={n} onLayout={() => layouts++}>
          <Tiles tunnel={t} order={["A", "B"]} />
        </Top>
      );
      const host = await mountHostRoot(ui(0));
      const fiberRoot = host.fiberRoot as unknown as FiberRootLike;
      const hook = commitHookOf(fiberRoot)!;
      expect(hook).not.toBeNull();
      expect(hook.last).toBe(fiberRoot.current);

      let commits = 0;
      hook.listeners.add(() => commits++);
      layouts = 0;
      await act(async () => host.render(ui(1)));
      await act(async () => host.render(ui(2)));
      await act(async () => startTransition(() => host.render(ui(3))));
      expect(layouts).toBe(3);
      expect(commits).toBe(3);
      expect(hook.last).toBe(fiberRoot.current);
      expect(labels(out.container)).toEqual(["A", "B"]);
    }

    expect(warn).not.toHaveBeenCalled();
  });

  test("chains an accessor already on the root", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(null);
    const fiberRoot = fiberRootOf(root);
    const foreign = defineForeignAccessor(fiberRoot);

    await act(async () => root.render(<Board tunnel={t} order={["A", "B"]} />));
    const hook = commitHookOf(fiberRoot)!;
    expect(hook).not.toBeNull();
    expect(Object.getOwnPropertyDescriptor(fiberRoot, "current")?.set).toBe(
      hook.set,
    );
    const sets = foreign.sets;
    expect(sets).toBeGreaterThan(0);
    expect(fiberRoot.current).toBe(foreign.value);
    expect(fiberRoot.current).toBe(hook.last);

    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(labels(container)).toEqual(["B", "A"]);
    expect(foreign.sets).toBeGreaterThan(sets);
    expect(fiberRoot.current).toBe(foreign.value);
    expect(fiberRoot.current).toBe(hook.last);
    expect(warn).not.toHaveBeenCalled();
  });

  test("shares one hook among tunnels on one root", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const u = fiberTunnel();
    function App({ order }: { order: string[] }) {
      "use no memo";
      return (
        <>
          <div className="t">
            <Board tunnel={t} order={order} />
          </div>
          <div className="u">
            <Board tunnel={u} order={order.map((l) => l.toLowerCase())} />
          </div>
        </>
      );
    }
    const { root, container } = await mountDomRoot(<App order={["A", "B"]} />);
    const fiberRoot = fiberRootOf(root);
    const hook = commitHookOf(fiberRoot)!;
    expect(hook.listeners.size).toBe(1);
    expect(Object.getOwnPropertyDescriptor(fiberRoot, "current")?.set).toBe(
      hook.set,
    );

    await act(async () => root.render(<App order={["B", "A"]} />));
    expect(labels(container.querySelector(".t")!)).toEqual(["B", "A"]);
    expect(labels(container.querySelector(".u")!)).toEqual(["b", "a"]);
    expect(commitHookOf(fiberRoot)).toBe(hook);
    expect(warn).not.toHaveBeenCalled();
  });

  test("shares one hook across fiber-tunnel copies", async () => {
    const warn = hookSpyWarn();
    vi.resetModules();
    const copy = await import("./fiber-tunnel");
    const copyHook = await import("./commit-hook");
    expect(copy.fiberTunnel).not.toBe(fiberTunnel);
    expect(copyHook.commitHookOf).not.toBe(commitHookOf);

    const t = fiberTunnel();
    const u = copy.fiberTunnel();
    function App({ order }: { order: string[] }) {
      "use no memo";
      return (
        <>
          <div className="t">
            <Board tunnel={t} order={order} />
          </div>
          <div className="u">
            <Board tunnel={u} order={order.map((l) => l.toLowerCase())} />
          </div>
        </>
      );
    }
    const { root, container } = await mountDomRoot(<App order={["A", "B"]} />);
    const fiberRoot = fiberRootOf(root);
    const hook = commitHookOf(fiberRoot)!;
    expect(copyHook.commitHookOf(fiberRoot)).toBe(hook);
    expect(hook.listeners.size).toBe(2);
    expect(Object.getOwnPropertyDescriptor(fiberRoot, "current")?.set).toBe(
      hook.set,
    );

    await act(async () => root.render(<App order={["B", "A"]} />));
    expect(labels(container.querySelector(".t")!)).toEqual(["B", "A"]);
    expect(labels(container.querySelector(".u")!)).toEqual(["b", "a"]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("returns React's value when an earlier setter throws", async () => {
    const error = spyError();
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(null);
    const fiberRoot = fiberRootOf(root);
    const foreign = defineForeignAccessor(fiberRoot, true);

    await act(async () => root.render(<Board tunnel={t} order={["A", "B"]} />));
    expect(foreign.sets).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "foreign setter" }),
    );
    const hook = commitHookOf(fiberRoot)!;
    expect(fiberRoot.current).toBe(hook.last);
    expect(fiberRoot.current?.stateNode).toBe(fiberRoot);
    expect(labels(container)).toEqual(["A", "B"]);

    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(labels(container)).toEqual(["B", "A"]);
    expect(fiberRoot.current).toBe(hook.last);
    expect(fiberRoot.current?.stateNode).toBe(fiberRoot);
    expect(foreign.sets).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("completes the commit when a listener throws", async () => {
    const error = spyError();
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(
      <Board tunnel={t} order={["A", "B"]} />,
    );
    const fiberRoot = fiberRootOf(root);
    const hook = commitHookOf(fiberRoot)!;
    // The throwing listener runs first.
    const own = [...hook.listeners];
    hook.listeners.clear();
    hook.listeners.add(() => {
      throw new Error("listener");
    });
    for (const listener of own) hook.listeners.add(listener);

    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener" }),
    );
    expect(fiberRoot.current).toBe(hook.last);
    expect(fiberRoot.current?.stateNode).toBe(fiberRoot);
    expect(labels(container)).toEqual(["B", "A"]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps a chained accessor when falling back", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(null);
    const fiberRoot = fiberRootOf(root);
    const foreign = defineForeignAccessor(fiberRoot);
    const hook = installCommitHook(fiberRoot)!;
    // Fails the sanity check at the first In mount.
    const tamper = () => void (hook.last = null);
    hook.listeners.add(tamper);

    await act(async () => root.render(<Board tunnel={t} order={["A", "B"]} />));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the commit hook failed its sanity check"),
    );
    hook.listeners.delete(tamper);

    const sets = foreign.sets;
    await act(async () =>
      root.render(<Board tunnel={t} order={["A", "B"]} extra="C" />),
    );
    expect(labels(container)).toEqual(["A", "B", "C"]);
    expect(Object.getOwnPropertyDescriptor(fiberRoot, "current")?.set).toBe(
      hook.set,
    );
    expect(foreign.sets).toBeGreaterThan(sets);
    expect(fiberRoot.current).toBe(foreign.value);
    expect(fiberRoot.current).toBe(hook.last);
    expect(fiberRoot.current?.stateNode).toBe(fiberRoot);
  });

  test("detects a replaced accessor and falls back", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(
      <Board tunnel={t} order={["A", "B"]} />,
    );
    const fiberRoot = fiberRootOf(root);
    Object.defineProperty(fiberRoot, "current", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: fiberRoot.current,
    });

    await act(async () =>
      root.render(<Board tunnel={t} order={["A", "B"]} extra="C" />),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("another accessor replaced the commit hook"),
    );
    expect(labels(container)).toEqual(["A", "B", "C"]);

    // Moves wait for the next emit or refresh().
    await act(async () =>
      root.render(<Board tunnel={t} order={["B", "A"]} extra="C" />),
    );
    expect(labels(container)).toEqual(["A", "B", "C"]);
    await act(async () => t.refresh());
    expect(labels(container)).toEqual(["B", "A", "C"]);
  });

  test("emits after the commit, outside it", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const log: string[] = [];
    const out = await mountDomRoot(
      <Profiler id="out" onRender={() => log.push("out render")}>
        <t.Out />
      </Profiler>,
    );
    const outRoot = fiberRootOf(out.root);
    const ui = (order: string[]) => (
      <Top
        n={0}
        onLayout={() => log.push(`layout pending=${outRoot.pendingLanes}`)}
      >
        <Tiles tunnel={t} order={order} />
      </Top>
    );
    const { root } = await mountDomRoot(ui(["A", "B"]));
    const hook = commitHookOf(fiberRootOf(root))!;
    hook.listeners.add(() =>
      log.push(
        `commit pending=${outRoot.pendingLanes} ${labels(out.container)}`,
      ),
    );
    log.length = 0;

    await act(async () => root.render(ui(["B", "A"])));
    expect(log).toEqual([
      "commit pending=0 A,B",
      "layout pending=0",
      "out render",
    ]);
    expect(labels(out.container)).toEqual(["B", "A"]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns in dev when the cross-check finds a move the hook missed", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(
      <Board tunnel={t} order={["A", "B"]} />,
    );
    const fiberRoot = fiberRootOf(root);
    forgetPathFiber(findFiber(fiberRoot.current!, Tiles)!);
    // Past the cross-check interval.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);

    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "the cross-check found a move the commit hook missed",
      ),
    );
    expect(labels(container)).toEqual(["B", "A"]);
  });

  test("skips the dev cross-check until the tunnel holds two items", async () => {
    const warn = hookSpyWarn();
    // Each read passes the cross-check interval.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(
      <Board tunnel={t} order={["A"]} />,
    );
    vi.mocked(sortByKey).mockClear();
    await act(async () => root.render(<Board tunnel={t} order={["A"]} />));
    expect(sortByKey).not.toHaveBeenCalled();

    await act(async () => root.render(<Board tunnel={t} order={["A", "B"]} />));
    const fiberRoot = fiberRootOf(root);
    forgetPathFiber(findFiber(fiberRoot.current!, Tiles)!);
    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "the cross-check found a move the commit hook missed",
      ),
    );
    expect(labels(container)).toEqual(["B", "A"]);
  });

  test("chains a hook with an unknown protocol version as a foreign accessor", async () => {
    const warn = hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(null);
    const fiberRoot = fiberRootOf(root);
    // A later fiber-tunnel copy's hook.
    let stored = fiberRoot.current;
    const future = { version: 99, sets: 0 };
    Object.defineProperty(fiberRoot, "current", {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set(value: Fiber) {
        future.sets++;
        stored = value;
      },
    });
    Object.defineProperty(fiberRoot, hookKey, {
      configurable: true,
      writable: true,
      value: future,
    });

    await act(async () => root.render(<Board tunnel={t} order={["A", "B"]} />));
    const hook = commitHookOf(fiberRoot)!;
    expect(hook).not.toBeNull();
    expect(hook).not.toBe(future);
    expect(hook.version).not.toBe(future.version);
    expect(Object.getOwnPropertyDescriptor(fiberRoot, "current")?.set).toBe(
      hook.set,
    );
    const sets = future.sets;
    expect(sets).toBeGreaterThan(0);

    await act(async () => root.render(<Board tunnel={t} order={["B", "A"]} />));
    expect(labels(container)).toEqual(["B", "A"]);
    expect(future.sets).toBeGreaterThan(sets);
    expect(fiberRoot.current).toBe(stored);
    expect(fiberRoot.current).toBe(hook.last);
    expect(warn).not.toHaveBeenCalled();
  });

  test("falls back to sorting on every emit when the commit hook fails its check", async () => {
    hookSpyWarn();
    const t = fiberTunnel();
    const { root, container } = await mountDomRoot(null);
    const fiberRoot = fiberRootOf(root);
    const hook = installCommitHook(fiberRoot)!;
    const tamper = () => void (hook.last = null);
    hook.listeners.add(tamper);
    await act(async () =>
      root.render(<Board tunnel={t} order={["A", "B"]} extra="x" />),
    );
    hook.listeners.delete(tamper);
    expect(labels(container)).toEqual(["A", "B", "x"]);

    // A move alone emits nothing.
    await act(async () =>
      root.render(<Board tunnel={t} order={["B", "A"]} extra="x" />),
    );
    expect(labels(container)).toEqual(["A", "B", "x"]);
    // Any emit re-sorts.
    await act(async () =>
      root.render(<Board tunnel={t} order={["B", "A"]} extra="y" />),
    );
    expect(labels(container)).toEqual(["B", "A", "y"]);
  });

  test("warns in dev when the commit hook falls back", async () => {
    const warn = hookSpyWarn();

    // Failed sanity check.
    {
      const t = fiberTunnel();
      const { root } = await mountDomRoot(null);
      const hook = installCommitHook(fiberRootOf(root))!;
      hook.listeners.add(() => void (hook.last = null));
      await act(async () =>
        root.render(<Board tunnel={t} order={["A", "B"]} />),
      );
    }

    // Replaced accessor.
    {
      const t = fiberTunnel();
      const { root } = await mountDomRoot(
        <Board tunnel={t} order={["A", "B"]} />,
      );
      const fiberRoot = fiberRootOf(root);
      Object.defineProperty(fiberRoot, "current", {
        configurable: true,
        writable: true,
        value: fiberRoot.current,
      });
      await act(async () =>
        root.render(<Board tunnel={t} order={["A", "B"]} extra="C" />),
      );
    }

    // Failed install: `current` is non-configurable.
    {
      const t = fiberTunnel();
      const { root, container } = await mountDomRoot(null);
      const fiberRoot = fiberRootOf(root);
      Object.defineProperty(fiberRoot, "current", {
        configurable: false,
        writable: true,
        value: fiberRoot.current,
      });
      await act(async () =>
        root.render(<Board tunnel={t} order={["A", "B"]} />),
      );
      expect(commitHookOf(fiberRoot)).toBeNull();
      expect(labels(container)).toEqual(["A", "B"]);
    }

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual([
      `${fallbackPrefix}; the tunnel sorts on every change and refresh() re-reads moves. Cause: the commit hook failed its sanity check`,
      `${fallbackPrefix}; the tunnel sorts on every change and refresh() re-reads moves. Cause: another accessor replaced the commit hook`,
      `${fallbackPrefix}; the tunnel sorts on every change and refresh() re-reads moves. Cause: the commit hook did not install`,
    ]);
  });
});
