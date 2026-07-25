import { afterEach, describe, expect, test, vi } from "vitest";
import { LibraryDiscovery } from "../src/local/discovery.js";
import type { LocalContext7Config } from "../src/local/types.js";

const config: LocalContext7Config = {
  storageDir: "unused",
  refreshIntervalMs: 60_000,
  gitTimeoutMs: 30_000,
  fetchTimeoutMs: 5_000,
  maxFiles: 100,
  maxFileBytes: 100_000,
  maxIndexBytes: 1_000_000,
  maxResultChars: 10_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local library discovery", () => {
  test("prefers an official docs repository and rejects empty exact-name matches", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/GitHub/docs") {
        return Response.json({
          full_name: "github/docs",
          name: "docs",
          description: "The open-source repository for docs.github.com",
          default_branch: "main",
          stargazers_count: 17_000,
          size: 500_000,
        });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          items: [
            {
              full_name: "example/github-actions-documentation",
              name: "github-actions-documentation",
              default_branch: "main",
              stargazers_count: 0,
              size: 0,
            },
            {
              full_name: "example-valid/github-actions-documentation",
              name: "github-actions-documentation",
              default_branch: "main",
              stargazers_count: 1,
              size: 10,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const candidates = await new LibraryDiscovery(config).discoverCandidates(
      "GitHub Actions documentation"
    );

    expect(candidates[0]?.ref.id.toLowerCase()).toBe("/github/docs");
    expect(candidates.map((candidate) => candidate.ref.id)).not.toContain(
      "/example/github-actions-documentation"
    );
    expect(candidates.map((candidate) => candidate.ref.id)).toContain(
      "/example-valid/github-actions-documentation"
    );
  });
});
