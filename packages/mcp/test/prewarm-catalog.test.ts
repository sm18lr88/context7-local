import { describe, expect, it } from "vitest";
import { mergePopularCandidates } from "../src/prewarm/catalog.js";

describe("popular library catalog", () => {
  it("keeps curated libraries first, deduplicates repositories, and excludes historical IDs", () => {
    const libraries = mergePopularCandidates(
      [
        {
          source: { name: "framework", query: "test", weight: 100 },
          repositories: [
            {
              full_name: "facebook/react",
              name: "react",
              stargazers_count: 250_000,
              default_branch: "main",
              topics: ["library"],
            },
            {
              full_name: "example/new-library",
              name: "new-library",
              stargazers_count: 50_000,
              default_branch: "main",
              topics: ["framework"],
            },
            {
              full_name: "example/awesome-library",
              name: "awesome-library",
              stargazers_count: 500_000,
              topics: ["awesome-list"],
            },
          ],
        },
      ],
      500
    );

    expect(libraries[0]?.libraryId).toBe("/facebook/react");
    expect(
      libraries.filter((library) => library.libraryId.toLowerCase() === "/facebook/react")
    ).toHaveLength(1);
    expect(libraries.some((library) => library.libraryId === "/example/new-library")).toBe(true);
    expect(libraries.some((library) => library.libraryId.includes("awesome-library"))).toBe(false);
    expect(libraries.every((library) => library.libraryId.split("/").length === 3)).toBe(true);
    expect(libraries.map((library) => library.rank)).toEqual(
      libraries.map((_, index) => index + 1)
    );
  });
});
