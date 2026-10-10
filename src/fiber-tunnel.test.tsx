import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { FiberProvider, useContextBridge } from "its-fine";
import {
  Activity,
  memo,
  type ReactNode,
  StrictMode,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FiberAnchor } from "./fiber-anchor";
import { type FiberTunnel, fiberTunnel } from "./fiber-tunnel";

function buttonLabels() {
  return screen.getAllByRole("button").map((button) => button.textContent);
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
afterEach(() => {
  act(() => childRoots.forEach((root) => root.unmount()));
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
  const Bridge = useContextBridge();
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
  test("refresh re-reads order after a keyed reorder of memoized Ins", () => {
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

    const { rerender } = render(<App order={["A", "B"]} />);
    rerender(<App order={["B", "A"]} />);
    // Memoized Ins skip the move; the Out reads the previous tree.
    expect(buttonLabels()).toEqual(["A", "B"]);

    act(() => t.refresh());
    expect(buttonLabels()).toEqual(["B", "A"]);
  });

  test("removes an In's content when the In unmounts", () => {
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
    expect(buttonLabels()).toEqual(["First", "Second"]);
    rerender(<App showFirst={false} />);
    expect(buttonLabels()).toEqual(["Second"]);
  });

  test("drops a Suspense-hidden In's content and restores it in place on reveal", async () => {
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
    rerender(<App suspended={true} />);
    expect(buttonLabels()).toEqual(["Second"]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(buttonLabels()).toEqual(["First", "Second"]);
  });

  test("keeps tunneled content's state and DOM when its In re-renders", () => {
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
    const button = screen.getByRole("button");
    fireEvent.click(button);
    rerender(<App label="Two" />);

    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBe(button);
    expect(button).toHaveTextContent("1");
  });
});

describe("tunnel ordering", () => {
  test("keeps item order when a tunneled item re-renders", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "First 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Second 0" }));

    expect(buttonLabels()).toEqual(["First 1", "Second 1", "Third 0"]);
  });

  test("keeps item order when items mount later", () => {
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
    act(() => {
      rerender(<App showFirst={true} />);
    });

    expect(buttonLabels()).toEqual(["First", "Second"]);
  });

  test("picks up a reorder of memoized items on the next tunnel update", () => {
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
    // Memoized Ins skip the move; the next update re-sorts.
    rerender(<App order={["C", "A", "B"]} />);
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

  test("keeps content state and DOM while Activity hides the Out", () => {
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
    const button = screen.getByRole("button");
    fireEvent.click(button);
    rerender(<App mode="hidden" />);
    rerender(<App mode="visible" />);

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
  test("orders content within one anchored child root", () => {
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
    rerender(<App showFirst={true} />);
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
    const t = fiberTunnel();
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

  test("chains nested anchors across roots", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fiberTunnel();
    render(
      <>
        <t.In>
          <button>A</button>
        </t.In>
        <FiberAnchor>
          <ChildRoot>
            <t.In>
              <button>B1</button>
            </t.In>
            <FiberAnchor>
              <ChildRoot>
                <t.In>
                  <button>C</button>
                </t.In>
              </ChildRoot>
            </FiberAnchor>
            <t.In>
              <button>B2</button>
            </t.In>
          </ChildRoot>
        </FiberAnchor>
        <t.In>
          <button>D</button>
        </t.In>
        <t.Out />
      </>,
    );

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

  test("dev errors once per Out that mounts beside another", () => {
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
    expect(consoleError).not.toHaveBeenCalled();
    rerender(<App second={true} third={false} />);
    expect(consoleError).toHaveBeenCalledTimes(1);
    rerender(<App second={false} third={false} />);
    rerender(<App second={false} third={true} />);
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
