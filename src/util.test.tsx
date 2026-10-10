import { render } from "@testing-library/react";
import { type Fiber, FiberProvider, useFiber } from "its-fine";
import { type ReactNode, useLayoutEffect } from "react";
import { describe, expect, test } from "vitest";

import { sortByFiberOrder } from "./util";

interface Probed {
  name: string;
  fiber: Fiber | undefined;
}

/** Records each Probe's fiber by name. */
function createProbes() {
  const fibers = new Map<string, Fiber | undefined>();
  function Probe({ name, children }: { name: string; children?: ReactNode }) {
    const fiber = useFiber();
    useLayoutEffect(() => {
      fibers.set(name, fiber);
    }, [name, fiber]);
    return <>{children}</>;
  }
  const items = (...names: string[]): Probed[] =>
    names.map((name) => ({ name, fiber: fibers.get(name) }));
  return { Probe, fibers, items };
}

const names = (items: Probed[]) => items.map((item) => item.name);

describe("sortByFiberOrder", () => {
  test("sorts items by React tree position, including nested items", () => {
    const { Probe, items } = createProbes();
    render(
      <FiberProvider>
        <Probe name="A" />
        <Probe name="B">
          <Probe name="C" />
        </Probe>
        <Probe name="D" />
      </FiberProvider>,
    );

    expect(names(sortByFiberOrder(items("D", "C", "B", "A")))).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("keeps input order for items without a fiber, after sorted items", () => {
    const { Probe, items } = createProbes();
    render(
      <FiberProvider>
        <Probe name="A" />
        <Probe name="B" />
      </FiberProvider>,
    );
    const unknown = (name: string): Probed => ({ name, fiber: undefined });

    expect(
      names(
        sortByFiberOrder([
          unknown("U2"),
          ...items("B"),
          unknown("U1"),
          ...items("A"),
        ]),
      ),
    ).toEqual(["A", "B", "U2", "U1"]);
  });
});
