// @vitest-environment node

import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { FiberAnchor } from "./fiber-anchor";
import { fiberTunnel } from "./fiber-tunnel";

describe("SSR", () => {
  test("renders an empty Out on the server", () => {
    const t = fiberTunnel();

    const html = renderToString(
      <>
        <t.In>
          <button>Tunneled</button>
        </t.In>
        <div className="out">
          <t.Out />
        </div>
      </>,
    );

    // Lifecycles don't run on the server.
    expect(html).toBe('<div class="out"></div>');
  });

  test("renders a FiberAnchor's children on the server", () => {
    const t = fiberTunnel();

    const html = renderToString(
      <>
        <FiberAnchor>
          <t.In>
            <button>Tunneled</button>
          </t.In>
          <span>anchored</span>
        </FiberAnchor>
        <div className="out">
          <t.Out />
        </div>
      </>,
    );

    expect(html).toBe('<span>anchored</span><div class="out"></div>');
  });
});
