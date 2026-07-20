import { describe, expect, test } from "vitest";
import { createSessionStore } from "../src/lib/sessionStore.js";

describe("local HTTP session store", () => {
  test("keeps protocol sessions in process memory", async () => {
    const sessions = createSessionStore();
    expect(await sessions.refresh("local-session")).toBe(false);
    await sessions.create("local-session");
    expect(await sessions.refresh("local-session")).toBe(true);
    await sessions.delete("local-session");
    expect(await sessions.refresh("local-session")).toBe(false);
  });

  test("does not share state across server processes", async () => {
    const first = createSessionStore();
    const second = createSessionStore();
    await first.create("isolated-session");
    expect(await first.refresh("isolated-session")).toBe(true);
    expect(await second.refresh("isolated-session")).toBe(false);
  });
});
