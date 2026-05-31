import { assertEquals } from "@std/assert";
import { deriveWatchedRepos, type Manifest } from "./manifest.ts";

const gh = (source: string, skillPath: string, skillFolderHash: string) => ({
  source,
  sourceType: "github",
  skillPath,
  skillFolderHash,
});

Deno.test("deriveWatchedRepos keeps only github sources", () => {
  const manifest: Manifest = {
    version: 1,
    skills: {
      a: gh("owner/gh", "skills/a", "h1"),
      b: { ...gh("owner/x", "skills/b", "h2"), sourceType: "local" },
    },
  };

  assertEquals(deriveWatchedRepos(manifest), [
    {
      source: "owner/gh",
      branch: "main",
      skills: [{ name: "a", skillPath: "skills/a", skillFolderHash: "h1" }],
    },
  ]);
});

Deno.test("deriveWatchedRepos groups skills sharing a Source Repo", () => {
  const manifest: Manifest = {
    version: 1,
    skills: {
      one: gh("acme/repo", "skills/one", "h1"),
      two: gh("acme/repo", "skills/two", "h2"),
    },
  };

  assertEquals(deriveWatchedRepos(manifest), [
    {
      source: "acme/repo",
      branch: "main",
      skills: [
        { name: "one", skillPath: "skills/one", skillFolderHash: "h1" },
        { name: "two", skillPath: "skills/two", skillFolderHash: "h2" },
      ],
    },
  ]);
});

Deno.test("deriveWatchedRepos sorts repos by source", () => {
  const manifest: Manifest = {
    version: 1,
    skills: {
      z: gh("zeta/z", "p", "hz"),
      a: gh("alpha/a", "p", "ha"),
      m: gh("mu/m", "p", "hm"),
    },
  };

  assertEquals(
    deriveWatchedRepos(manifest).map((r) => r.source),
    ["alpha/a", "mu/m", "zeta/z"],
  );
});

Deno.test("deriveWatchedRepos returns [] for an empty Manifest", () => {
  assertEquals(deriveWatchedRepos({ version: 1, skills: {} }), []);
});
