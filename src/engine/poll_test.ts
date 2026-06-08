import { assertEquals } from "@std/assert";
import {
  assembleSkillStatuses,
  type FetchCommit,
  makeMemoryCache,
  makeMemoryReader,
  pollRepos,
  type SourceRepoReader,
} from "./poll.ts";
import type { Commit } from "./github.ts";
import type { WatchedRepo } from "./manifest.ts";

const commit = (sha: string) => ({
  ok: true as const,
  commit: { sha, message: "", author: "", date: "" },
});

// poll ignores skills; [] keeps the fixtures focused on source/branch.
const repo = (source: string, branch: string): WatchedRepo => ({
  source,
  branch,
  skills: [],
});

Deno.test("pollRepos maps each WatchedRepo to a RepoStatus", async () => {
  const repos: WatchedRepo[] = [repo("owner/repo", "main")];
  const fetchCommit: FetchCommit = () => Promise.resolve(commit("abc1234"));

  assertEquals(await pollRepos(repos, fetchCommit), [
    { source: "owner/repo", branch: "main", result: commit("abc1234") },
  ]);
});

Deno.test("pollRepos passes parsed owner/repo and branch to fetchCommit", async () => {
  const calls: Array<[string, string, string]> = [];
  const fetchCommit: FetchCommit = (owner, repo, branch) => {
    calls.push([owner, repo, branch]);
    return Promise.resolve(commit("x"));
  };

  await pollRepos([repo("octocat/hello", "dev")], fetchCommit);

  assertEquals(calls, [["octocat", "hello", "dev"]]);
});

Deno.test("pollRepos isolates a single Source Repo's failure", async () => {
  const repos: WatchedRepo[] = [
    repo("a/one", "main"),
    repo("b/two", "dev"),
    repo("c/three", "main"),
  ];
  const fetchCommit: FetchCommit = (owner) =>
    Promise.resolve(
      owner === "b" ? { ok: false, error: "boom" } : commit(owner),
    );

  const rows = await pollRepos(repos, fetchCommit);

  assertEquals(rows, [
    { source: "a/one", branch: "main", result: commit("a") },
    { source: "b/two", branch: "dev", result: { ok: false, error: "boom" } },
    { source: "c/three", branch: "main", result: commit("c") },
  ]);
});

Deno.test("pollRepos preserves input order despite resolution timing", async () => {
  const repos: WatchedRepo[] = [
    repo("first/a", "main"),
    repo("second/b", "main"),
    repo("third/c", "main"),
  ];
  // First resolves slowest — Promise.all must still preserve input order.
  const delays: Record<string, number> = { first: 20, second: 10, third: 0 };
  const fetchCommit: FetchCommit = (owner) =>
    new Promise((resolve) =>
      setTimeout(() => resolve(commit(owner)), delays[owner])
    );

  const rows = await pollRepos(repos, fetchCommit);

  assertEquals(rows.map((r) => r.source), ["first/a", "second/b", "third/c"]);
});

Deno.test("pollRepos returns [] and never fetches for no WatchedRepos", async () => {
  let called = false;
  const fetchCommit: FetchCommit = () => {
    called = true;
    return Promise.resolve(commit("x"));
  };

  assertEquals(await pollRepos([], fetchCommit), []);
  assertEquals(called, false);
});

Deno.test("makeMemoryCache: miss is undefined, a set value round-trips, null is known-absent", async () => {
  const cache = makeMemoryCache();
  assertEquals(await cache.get("o/r", "skills/a", "h"), undefined); // uncached
  await cache.set("o/r", "skills/a", "h", "sha1");
  assertEquals(await cache.get("o/r", "skills/a", "h"), "sha1");
  await cache.set("o/r", "skills/a", "h", null);
  assertEquals(await cache.get("o/r", "skills/a", "h"), null);
});

// --- assembleSkillStatuses fixtures ---

const skill = (name: string, hash: string) => ({
  name,
  skillPath: `skills/${name}`,
  skillFolderHash: hash,
});

const repoWith = (
  source: string,
  skills: ReturnType<typeof skill>[],
): WatchedRepo => ({ source, branch: "main", skills });

// makeMemoryReader's Commit projection: the sha is what tests assert on, the rest
// defaults empty.
const wc = (sha: string): Commit => ({
  sha,
  message: "",
  author: "",
  date: "",
});

// --- makeMemoryReader ---

Deno.test("makeMemoryReader: fetchCommit returns the newest commit as HEAD", async () => {
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/alpha": "H1" } },
    ],
  });
  assertEquals(await reader.fetchCommit("o", "r", "main"), {
    ok: true,
    commit: wc("c2"),
  });
});

Deno.test("makeMemoryReader: fetchFolderTree lists present children, carried forward", async () => {
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "Ha", "skills/beta": "Hb" } },
      { sha: "c2", folders: { "skills/beta": "Hb2" } }, // alpha carries forward
    ],
  });
  assertEquals(await reader.fetchFolderTree("o", "r", "skills", "c2"), {
    ok: true,
    entries: [
      { name: "alpha", sha: "Ha", type: "dir" },
      { name: "beta", sha: "Hb2", type: "dir" },
    ],
  });
});

Deno.test("makeMemoryReader: fetchFolderTree omits a removed folder", async () => {
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "Ha" } },
      { sha: "c2", folders: { "skills/alpha": null } }, // removed at HEAD
    ],
  });
  assertEquals(await reader.fetchFolderTree("o", "r", "skills", "c2"), {
    ok: true,
    entries: [],
  });
});

Deno.test("makeMemoryReader: fetchPathCommits returns touching commits newest-first", async () => {
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/beta": "Hb" } }, // doesn't touch alpha
      { sha: "c3", folders: { "skills/alpha": "H1" } },
    ],
  });
  assertEquals(await reader.fetchPathCommits("o", "r", "skills/alpha", "c3"), {
    ok: true,
    commits: [wc("c3"), wc("c1")], // c2 skipped — it didn't change alpha
  });
});

Deno.test("makeMemoryReader: serves only its source; another repo 404s", async () => {
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/alpha": "Ha" } }],
  });
  const res = await reader.fetchCommit("other", "repo", "main");
  assertEquals(res.ok, false);
  if (!res.ok) assertEquals(res.status, 404);
});

Deno.test("makeMemoryReader: records listed refs and path-commits calls", async () => {
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/alpha": "Ha" } }],
  });
  await reader.fetchFolderTree("o", "r", "skills", "c1");
  await reader.fetchPathCommits("o", "r", "skills/alpha", "c1");
  assertEquals(calls, { listedRefs: ["c1"], pathCommitsCalls: 1 });
});

// --- assembleSkillStatuses ---

Deno.test("assembleSkillStatuses marks a skill current when its folder matches HEAD", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H")])];
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/alpha": "H" } }],
  });

  const rows = await assembleSkillStatuses(repos, {
    reader,
    cache: makeMemoryCache(),
  });

  assertEquals(rows, [
    {
      name: "alpha",
      source: "o/r",
      branch: "main",
      state: { kind: "current" },
    },
  ]);
  assertEquals(calls.pathCommitsCalls, 0); // no path-commits fetch for an up-to-date skill
});

Deno.test("assembleSkillStatuses marks a skill removed when its folder is gone at HEAD", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H")])];
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/beta": "X" } }], // alpha absent
  });

  const rows = await assembleSkillStatuses(repos, {
    reader,
    cache: makeMemoryCache(),
  });

  assertEquals(rows[0].state, { kind: "removed" });
  assertEquals(calls.pathCommitsCalls, 0);
});

Deno.test("assembleSkillStatuses resolves a Behind skill and caches the baseline", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  // alpha's folder sha per commit: c1 H0 (the baseline), c2 H2, c3/HEAD H3.
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/alpha": "H2" } },
      { sha: "c3", folders: { "skills/alpha": "H3" } },
    ],
  });
  const cache = makeMemoryCache();

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, {
    kind: "behind",
    behindBy: 2,
    baseline: "c1",
    commits: [wc("c3"), wc("c2")],
  });
  assertEquals(await cache.get("o/r", "skills/alpha", "H0"), "c1");
});

Deno.test("assembleSkillStatuses uses a cached baseline without walking folder history", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/alpha": "H2" } },
      { sha: "c3", folders: { "skills/alpha": "H3" } },
    ],
  });
  const cache = makeMemoryCache();
  await cache.set("o/r", "skills/alpha", "H0", "c1"); // already resolved

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, {
    kind: "behind",
    behindBy: 2,
    baseline: "c1",
    commits: [wc("c3"), wc("c2")],
  });
  assertEquals(calls.listedRefs, ["c3"]); // only the HEAD listing — no per-commit walk
});

Deno.test("assembleSkillStatuses marks a skill diverged when the hash isn't in history", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { reader } = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H1" } }, // none match H0
      { sha: "c2", folders: { "skills/alpha": "H2" } },
      { sha: "c3", folders: { "skills/alpha": "H3" } },
    ],
  });
  const cache = makeMemoryCache();

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(await cache.get("o/r", "skills/alpha", "H0"), null); // negative cached
});

Deno.test("assembleSkillStatuses treats a cached null as diverged without fetching commits", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  // HEAD differs from the installed hash (would normally walk), but the cache says
  // the hash is known-absent — so it short-circuits to diverged.
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c3", folders: { "skills/alpha": "H3" } }],
  });
  const cache = makeMemoryCache();
  await cache.set("o/r", "skills/alpha", "H0", null); // known absent from history

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(calls.pathCommitsCalls, 0); // negative cache short-circuits the re-walk and re-fetch
  assertEquals(calls.listedRefs, ["c3"]); // only the HEAD listing
});

Deno.test("assembleSkillStatuses pins the path-commits fetch to the polled HEAD sha", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const mem = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: "c2", folders: { "skills/alpha": "H3" } }, // HEAD
    ],
  });
  // Capture the ref poll pins the path-commits fetch to.
  let passedRef: string | undefined;
  const reader: SourceRepoReader = {
    ...mem.reader,
    fetchPathCommits: (o, r, p, ref) => {
      passedRef = ref;
      return mem.reader.fetchPathCommits(o, r, p, ref);
    },
  };

  await assembleSkillStatuses(repos, { reader, cache: makeMemoryCache() });

  assertEquals(passedRef, "c2"); // the polled HEAD sha, not "main" (repo.branch)
});

Deno.test("assembleSkillStatuses surfaces a transient walk failure as error without caching", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const head = "c2";
  const mem = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: head, folders: { "skills/alpha": "H3" } }, // HEAD differs → walk
    ],
  });
  // HEAD listing succeeds; the per-commit walk fails transiently (5xx).
  const reader: SourceRepoReader = {
    ...mem.reader,
    fetchFolderTree: (o, r, d, ref) =>
      ref === head
        ? mem.reader.fetchFolderTree(o, r, d, ref)
        : Promise.resolve({
          ok: false,
          status: 502,
          error: "GitHub API 502 Bad Gateway",
        }),
  };
  const cache = makeMemoryCache();

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, {
    kind: "error",
    error: "GitHub API 502 Bad Gateway",
  });
  assertEquals(await cache.get("o/r", "skills/alpha", "H0"), undefined); // not poisoned
});

Deno.test("assembleSkillStatuses treats a 404 during the walk as folder-absent", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const head = "c2";
  const mem = makeMemoryReader({
    source: "o/r",
    history: [
      { sha: "c1", folders: { "skills/alpha": "H0" } },
      { sha: head, folders: { "skills/alpha": "H3" } },
    ],
  });
  // A 404 is a definitive "absent at this ref", not a transient failure: the walk
  // continues, finds no match, and negative-caches diverged.
  const reader: SourceRepoReader = {
    ...mem.reader,
    fetchFolderTree: (o, r, d, ref) =>
      ref === head
        ? mem.reader.fetchFolderTree(o, r, d, ref)
        : Promise.resolve({
          ok: false,
          status: 404,
          error: "GitHub API 404 Not Found",
        }),
  };
  const cache = makeMemoryCache();

  const rows = await assembleSkillStatuses(repos, { reader, cache });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(await cache.get("o/r", "skills/alpha", "H0"), null);
});

Deno.test("assembleSkillStatuses surfaces a repo poll failure as an error state", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const mem = makeMemoryReader({
    source: "o/r",
    history: [{ sha: "c1", folders: { "skills/alpha": "H0" } }],
  });
  const reader: SourceRepoReader = {
    ...mem.reader,
    fetchCommit: () => Promise.resolve({ ok: false, error: "boom" }),
  };

  const rows = await assembleSkillStatuses(repos, {
    reader,
    cache: makeMemoryCache(),
  });

  assertEquals(rows[0].state, { kind: "error", error: "boom" });
  assertEquals(mem.calls.listedRefs.length, 0); // never listed a folder
  assertEquals(mem.calls.pathCommitsCalls, 0);
});

Deno.test("assembleSkillStatuses lists a shared parent dir once for all its skills", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "Ha"), skill("beta", "Hb")])];
  const { reader, calls } = makeMemoryReader({
    source: "o/r",
    history: [{
      sha: "c1",
      folders: { "skills/alpha": "Ha", "skills/beta": "Hb" },
    }],
  });

  const rows = await assembleSkillStatuses(repos, {
    reader,
    cache: makeMemoryCache(),
  });

  assertEquals(rows.map((r) => [r.name, r.state.kind]), [
    ["alpha", "current"],
    ["beta", "current"],
  ]);
  assertEquals(calls.listedRefs, ["c1"]); // one listing, memoized across both skills
});
