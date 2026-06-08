import { assertEquals } from "@std/assert";
import {
  deriveWatchedRepos,
  type Manifest,
  parseManifest,
} from "./manifest.ts";

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

Deno.test("deriveWatchedRepos drops a github entry missing a polled field", () => {
  const manifest = {
    version: 1,
    skills: {
      good: gh("owner/repo", "skills/good", "h1"),
      incomplete: {
        source: "owner/repo",
        sourceType: "github",
        skillPath: "x",
      },
    },
  } as unknown as Manifest;

  assertEquals(deriveWatchedRepos(manifest), [
    {
      source: "owner/repo",
      branch: "main",
      skills: [{
        name: "good",
        skillPath: "skills/good",
        skillFolderHash: "h1",
      }],
    },
  ]);
});

Deno.test("deriveWatchedRepos drops an entry whose fields are not strings", () => {
  const manifest = {
    version: 1,
    skills: {
      good: gh("owner/repo", "skills/good", "h1"),
      // A non-string skillPath is truthy, so it slips past a bare presence check
      // and would throw in skillFolder — it must be dropped, not crash.
      bad: {
        source: "owner/repo",
        sourceType: "github",
        skillPath: 42,
        skillFolderHash: "h2",
      },
    },
  } as unknown as Manifest;

  assertEquals(deriveWatchedRepos(manifest), [
    {
      source: "owner/repo",
      branch: "main",
      skills: [{
        name: "good",
        skillPath: "skills/good",
        skillFolderHash: "h1",
      }],
    },
  ]);
});

Deno.test("deriveWatchedRepos normalises a SKILL.md path to the Skill folder", () => {
  const manifest: Manifest = {
    version: 1,
    skills: {
      nested: gh("acme/repo", "skills/git-helper/SKILL.md", "h1"),
      root: gh("acme/repo", "git-helper/SKILL.md", "h2"),
    },
  };

  assertEquals(deriveWatchedRepos(manifest), [
    {
      source: "acme/repo",
      branch: "main",
      skills: [
        {
          name: "nested",
          skillPath: "skills/git-helper",
          skillFolderHash: "h1",
        },
        { name: "root", skillPath: "git-helper", skillFolderHash: "h2" },
      ],
    },
  ]);
});

Deno.test("parseManifest accepts a well-formed Manifest", () => {
  const manifest: Manifest = {
    version: 1,
    skills: { a: gh("owner/repo", "skills/a", "h1") },
  };
  assertEquals(parseManifest(JSON.stringify(manifest)), manifest);
});

Deno.test("parseManifest accepts an empty skills map", () => {
  assertEquals(parseManifest('{"version":1,"skills":{}}'), {
    version: 1,
    skills: {},
  });
});

Deno.test("parseManifest returns null for invalid JSON", () => {
  assertEquals(parseManifest("{ not json"), null);
});

Deno.test("parseManifest returns null when skills is missing", () => {
  assertEquals(parseManifest('{"version":1}'), null);
});

Deno.test("parseManifest returns null when skills is an array", () => {
  assertEquals(parseManifest('{"version":1,"skills":[]}'), null);
});

Deno.test("parseManifest returns null when skills is not an object", () => {
  assertEquals(parseManifest('{"version":1,"skills":"nope"}'), null);
});

Deno.test("parseManifest returns null for a non-object top value", () => {
  assertEquals(parseManifest("42"), null);
});
