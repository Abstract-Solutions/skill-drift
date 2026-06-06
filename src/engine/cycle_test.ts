import { assertEquals } from "@std/assert";
import { type CycleDeps, runPollCycle, type Snapshot } from "./cycle.ts";
import { type Fetchers, makeMemoryCache } from "./poll.ts";
import type { Commit, FolderEntry } from "./github.ts";

// Fixed clock so the snapshot's polledAt is assertable.
const NOW = new Date("2026-06-04T12:00:00.000Z");

const manifest = (skills: Record<string, unknown>) =>
  JSON.stringify({ version: 1, skills });

const ghSkill = (source: string, skillPath: string, hash: string) => ({
  source,
  sourceType: "github",
  skillPath,
  skillFolderHash: hash,
});

const c = (sha: string): Commit => ({
  sha,
  message: `msg ${sha}`,
  author: "Ada",
  date: "",
});

const dir = (name: string, sha: string): FolderEntry => ({
  name,
  sha,
  type: "dir",
});

// Fetchers that throw if touched — proves a short-circuit never polled.
const boom = (what: string): never => {
  throw new Error(`unexpected ${what}`);
};
const explodingFetchers: Fetchers = {
  fetchCommit: () => boom("fetchCommit"),
  fetchFolderTree: () => boom("fetchFolderTree"),
  fetchPathCommits: () => boom("fetchPathCommits"),
};

// Canned fetchers: one HEAD sha, a folder listing per ref, one path-commits list.
function fetchersFor(
  headSha: string,
  treeByRef: Record<string, FolderEntry[]>,
  commits: Commit[],
): Fetchers {
  return {
    fetchCommit: () =>
      Promise.resolve({
        ok: true,
        commit: { sha: headSha, message: "", author: "", date: "" },
      }),
    fetchFolderTree: (_o, _r, _d, ref) =>
      Promise.resolve({ ok: true, entries: treeByRef[ref] ?? [] }),
    fetchPathCommits: () => Promise.resolve({ ok: true, commits }),
  };
}

function spyMakeFetchers(fetchers: Fetchers) {
  const tokens: string[] = [];
  return {
    tokens,
    makeFetchers: (token: string) => {
      tokens.push(token);
      return fetchers;
    },
  };
}

function spySaveSnapshot() {
  const saved: Snapshot[] = [];
  return {
    saved,
    saveSnapshot: (s: Snapshot) => {
      saved.push(s);
      return Promise.resolve();
    },
  };
}

// Full deps with safe defaults (token present, fetchers that explode if reached);
// each test overrides only what it exercises.
function deps(raw: string | null, over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    readManifest: () => Promise.resolve(raw),
    getToken: () => Promise.resolve("tok"),
    makeFetchers: () => explodingFetchers,
    cache: makeMemoryCache(),
    saveSnapshot: () => Promise.resolve(),
    now: () => NOW,
    ...over,
  };
}

Deno.test("runPollCycle: absent Manifest → no-manifest", async () => {
  assertEquals((await runPollCycle(deps(null))).kind, "no-manifest");
});

Deno.test("runPollCycle: empty file → no-manifest", async () => {
  assertEquals((await runPollCycle(deps("  \n"))).kind, "no-manifest");
});

Deno.test("runPollCycle: unparseable Manifest → malformed", async () => {
  assertEquals((await runPollCycle(deps("{ not json"))).kind, "malformed");
});

Deno.test("runPollCycle: wrong-shaped Manifest → malformed", async () => {
  assertEquals((await runPollCycle(deps('{"version":1}'))).kind, "malformed");
});

Deno.test("runPollCycle: no GitHub Skills → no-manifest", async () => {
  const raw = manifest({
    a: { ...ghSkill("x/y", "skills/a", "h1"), sourceType: "local" },
  });
  assertEquals((await runPollCycle(deps(raw))).kind, "no-manifest");
});

Deno.test("runPollCycle: no token → no-token, never polls", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "Ha") });
  let built = false;
  const out = await runPollCycle(deps(raw, {
    getToken: () => Promise.resolve(null),
    makeFetchers: () => {
      built = true;
      return explodingFetchers;
    },
  }));

  assertEquals(out.kind, "no-token");
  assertEquals(built, false); // short-circuited before building fetchers
});

Deno.test("runPollCycle: empty-string token → no-token", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "Ha") });
  const out = await runPollCycle(
    deps(raw, { getToken: () => Promise.resolve("") }),
  );
  assertEquals(out.kind, "no-token");
});

Deno.test("runPollCycle: a getToken rejection → no-access, never polls", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "Ha") });
  let built = false;
  const out = await runPollCycle(deps(raw, {
    getToken: () => Promise.reject(new Error("keychain locked")),
    makeFetchers: () => {
      built = true;
      return explodingFetchers;
    },
  }));

  assertEquals(out.kind, "no-access");
  assertEquals(built, false); // a token-read failure short-circuits before the poll
  assertEquals(out.menu.rows.at(-1)?.kind, "quit"); // still a quittable frame
});

Deno.test("runPollCycle: installed + token → ok with assembled statuses, snapshot saved", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "Ha") });
  const fetchers = fetchersFor("HEAD", { HEAD: [dir("alpha", "Ha")] }, []);
  const { makeFetchers, tokens } = spyMakeFetchers(fetchers);
  const { saveSnapshot, saved } = spySaveSnapshot();

  const out = await runPollCycle(deps(raw, {
    getToken: () => Promise.resolve("tok-xyz"),
    makeFetchers,
    saveSnapshot,
  }));

  assertEquals(out.kind, "ok");
  if (out.kind !== "ok") return; // narrow for the fields below
  assertEquals(out.statuses, [
    {
      name: "alpha",
      source: "o/r",
      branch: "main",
      state: { kind: "current" },
    },
  ]);
  assertEquals(out.behind, 0);
  assertEquals(tokens, ["tok-xyz"]); // fetchers built with the resolved token
  assertEquals(saved, [{
    polledAt: NOW.toISOString(),
    statuses: out.statuses,
  }]);
});

Deno.test("runPollCycle: a Behind skill counts 1 toward the badge", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "H0") });
  // HEAD folder differs from the installed hash → walk; baseline is c1 (behind 2).
  const fetchers = fetchersFor("HEAD", {
    HEAD: [dir("alpha", "H3")],
    c3: [dir("alpha", "H3")],
    c2: [dir("alpha", "H2")],
    c1: [dir("alpha", "H0")],
  }, [c("c3"), c("c2"), c("c1")]);

  const out = await runPollCycle(
    deps(raw, { makeFetchers: () => fetchers }),
  );

  assertEquals(out.kind, "ok");
  if (out.kind !== "ok") return;
  assertEquals(out.behind, 1); // one Skill Behind, though it's behind by 2 commits
  assertEquals(out.statuses[0].state, {
    kind: "behind",
    behindBy: 2,
    baseline: "c1",
    commits: [c("c3"), c("c2")],
  });
});
