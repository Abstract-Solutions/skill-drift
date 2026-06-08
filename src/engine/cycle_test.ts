import { assertEquals } from "@std/assert";
import { type CycleDeps, runPollCycle, type Snapshot } from "./cycle.ts";
import {
  makeMemoryCache,
  makeMemoryReader,
  type SourceRepoReader,
} from "./poll.ts";

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

// A reader whose every method throws — proves a short-circuit never polled.
const boom = (what: string): never => {
  throw new Error(`unexpected ${what}`);
};
const explodingReader: SourceRepoReader = {
  fetchCommit: () => boom("fetchCommit"),
  fetchFolderTree: () => boom("fetchFolderTree"),
  fetchPathCommits: () => boom("fetchPathCommits"),
};

function spyMakeReader(reader: SourceRepoReader) {
  const tokens: string[] = [];
  return {
    tokens,
    makeReader: (token: string) => {
      tokens.push(token);
      return reader;
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

// Full deps with safe defaults (token present, a reader that explodes if reached);
// each test overrides only what it exercises.
function deps(raw: string | null, over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    readManifest: () => Promise.resolve(raw),
    getToken: () => Promise.resolve("tok"),
    makeReader: () => explodingReader,
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
    makeReader: () => {
      built = true;
      return explodingReader;
    },
  }));

  assertEquals(out.kind, "no-token");
  assertEquals(built, false); // short-circuited before building the reader
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
    makeReader: () => {
      built = true;
      return explodingReader;
    },
  }));

  assertEquals(out.kind, "no-access");
  assertEquals(built, false); // a token-read failure short-circuits before the poll
});

Deno.test("runPollCycle: installed + token → ok with assembled statuses, snapshot saved", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "Ha") });
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/alpha": "Ha" } }],
  });
  const { makeReader, tokens } = spyMakeReader(reader);
  const { saveSnapshot, saved } = spySaveSnapshot();

  const out = await runPollCycle(deps(raw, {
    getToken: () => Promise.resolve("tok-xyz"),
    makeReader,
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
  assertEquals(tokens, ["tok-xyz"]); // the reader built with the resolved token
  assertEquals(saved, [{
    polledAt: NOW.toISOString(),
    statuses: out.statuses,
  }]);
});

Deno.test("runPollCycle: a Behind skill counts 1 toward the badge", async () => {
  const raw = manifest({ alpha: ghSkill("o/r", "skills/alpha", "H0") });
  // alpha's folder advances H0 → H2 → H3 (HEAD); installed at H0 → behind by 2.
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/alpha": "H2" } },
      { sha: "c3", folders: { "skills/alpha": "H3" } },
    ],
  });

  const out = await runPollCycle(deps(raw, { makeReader: () => reader }));

  assertEquals(out.kind, "ok");
  if (out.kind !== "ok") return;
  assertEquals(out.behind, 1); // one Skill Behind, though it's behind by 2 commits
  const st = out.statuses[0].state;
  assertEquals(st.kind, "behind"); // commit detail is poll_test's concern
  if (st.kind === "behind") assertEquals(st.behindBy, 2);
});
