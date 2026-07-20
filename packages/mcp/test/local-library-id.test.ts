import { describe, expect, test } from "vitest";
import { parseGitHubRepository, parseLibraryId } from "../src/local/library-id.js";

describe("local Context7 library identifiers", () => {
  test("parses Context7 IDs with an optional version", () => {
    expect(parseLibraryId("/vercel/next.js/v16.0.0")).toMatchObject({
      id: "/vercel/next.js/v16.0.0",
      owner: "vercel",
      repo: "next.js",
      version: "v16.0.0",
      repositoryUrl: "https://github.com/vercel/next.js.git",
    });
  });

  test("normalizes supported GitHub repository URLs", () => {
    expect(parseGitHubRepository("git+https://github.com/fastify/fastify.git")?.id).toBe(
      "/fastify/fastify"
    );
    expect(
      parseGitHubRepository("git@github.com:modelcontextprotocol/typescript-sdk.git")?.id
    ).toBe("/modelcontextprotocol/typescript-sdk");
  });

  test("rejects shell and path traversal input", () => {
    expect(() => parseLibraryId("/owner/repo;whoami")).toThrow();
    expect(() => parseLibraryId("/owner/repo/../../main")).toThrow();
    expect(parseGitHubRepository("https://example.com/owner/repo")).toBeUndefined();
  });
});
