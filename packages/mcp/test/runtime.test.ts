import { describe, expect, test } from "vitest";
import { SUPPORTED_NODE_MAJOR, assertSupportedNodeRuntime } from "../src/runtime.js";

describe("MCP native runtime compatibility", () => {
  test("accepts the Node.js runtime used to install native SQLite dependencies", () => {
    expect(() => assertSupportedNodeRuntime("24.18.0")).not.toThrow();
  });

  test("rejects an incompatible runtime before native modules are loaded", () => {
    expect(() => assertSupportedNodeRuntime("26.5.0")).toThrow(
      `Context7 Local requires Node.js ${SUPPORTED_NODE_MAJOR}.x`
    );
  });
});
