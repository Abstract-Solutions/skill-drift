import { assertEquals } from "@std/assert";
import {
  assembleSkillStatuses,
  type BaselineCache,
  type FetchCommit,
  type FetchFolderTree,
  type FetchPathCommits,
  pollRepos,
} from "./poll.ts";
import type { Commit, FolderEntry } from "./github.ts";
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

// --- assembleSkillStatuses ---

const skill = (name: string, hash: string) => ({
  name,
  skillPath: `skills/${name}`,
  skillFolderHash: hash,
});

const repoWith = (
  source: string,
  skills: ReturnType<typeof skill>[],
): WatchedRepo => ({ source, branch: "main", skills });

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

const headAt = (sha: string): FetchCommit => () =>
  Promise.resolve({
    ok: true,
    commit: { sha, message: "", author: "", date: "" },
  });

// Folder listing keyed by ref (the parent dir's children at that ref). Records
// every ref asked for, so tests can assert dedup and that no walk happened.
function fakeTree(entriesByRef: Record<string, FolderEntry[]>) {
  const refs: string[] = [];
  const fetchFolderTree: FetchFolderTree = (_o, _r, _d, ref) => {
    refs.push(ref);
    return Promise.resolve({ ok: true, entries: entriesByRef[ref] ?? [] });
  };
  return { fetchFolderTree, refs };
}

function fakeCommits(commits: Commit[]) {
  let calls = 0;
  const fetchPathCommits: FetchPathCommits = () => {
    calls++;
    return Promise.resolve({ ok: true, commits });
  };
  return { fetchPathCommits, calls: () => calls };
}

function memCache() {
  const m = new Map<string, string | null>();
  const k = (s: string, f: string, h: string) => `${s}|${f}|${h}`;
  const cache: BaselineCache = {
    get: (s, f, h) =>
      Promise.resolve(
        m.has(k(s, f, h)) ? m.get(k(s, f, h)) ?? null : undefined,
      ),
    set: (s, f, h, v) => {
      m.set(k(s, f, h), v);
      return Promise.resolve();
    },
  };
  return { cache, store: m, k };
}

Deno.test("assembleSkillStatuses marks a skill current when its folder matches HEAD", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H")])];
  const { fetchFolderTree } = fakeTree({ HEAD: [dir("alpha", "H")] });
  const { fetchPathCommits, calls } = fakeCommits([]);
  const { cache } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows, [
    {
      name: "alpha",
      source: "o/r",
      branch: "main",
      state: { kind: "current" },
    },
  ]);
  assertEquals(calls(), 0); // no path-commits fetch for an up-to-date skill
});

Deno.test("assembleSkillStatuses marks a skill removed when its folder is gone at HEAD", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H")])];
  const { fetchFolderTree } = fakeTree({ HEAD: [dir("beta", "X")] });
  const { fetchPathCommits, calls } = fakeCommits([]);
  const { cache } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, { kind: "removed" });
  assertEquals(calls(), 0);
});

Deno.test("assembleSkillStatuses resolves a Behind skill and caches the baseline", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  // folder sha per ref: HEAD/c3 current (H3), c2 -> H2, c1 -> H0 (the baseline).
  const { fetchFolderTree } = fakeTree({
    HEAD: [dir("alpha", "H3")],
    c3: [dir("alpha", "H3")],
    c2: [dir("alpha", "H2")],
    c1: [dir("alpha", "H0")],
  });
  const { fetchPathCommits } = fakeCommits([c("c3"), c("c2"), c("c1")]);
  const { cache, store, k } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, {
    kind: "behind",
    behindBy: 2,
    baseline: "c1",
    commits: [c("c3"), c("c2")],
  });
  assertEquals(store.get(k("o/r", "skills/alpha", "H0")), "c1");
});

Deno.test("assembleSkillStatuses uses a cached baseline without walking folder history", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { fetchFolderTree, refs } = fakeTree({ HEAD: [dir("alpha", "H3")] });
  const { fetchPathCommits } = fakeCommits([c("c3"), c("c2"), c("c1")]);
  const { cache, store, k } = memCache();
  store.set(k("o/r", "skills/alpha", "H0"), "c1"); // already resolved

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, {
    kind: "behind",
    behindBy: 2,
    baseline: "c1",
    commits: [c("c3"), c("c2")],
  });
  assertEquals(refs, ["HEAD"]); // only the HEAD listing — no per-commit walk
});

Deno.test("assembleSkillStatuses marks a skill diverged when the hash isn't in history", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { fetchFolderTree } = fakeTree({
    HEAD: [dir("alpha", "H3")],
    c3: [dir("alpha", "H3")],
    c2: [dir("alpha", "H2")],
    c1: [dir("alpha", "H1")], // none match H0
  });
  const { fetchPathCommits } = fakeCommits([c("c3"), c("c2"), c("c1")]);
  const { cache, store, k } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(store.get(k("o/r", "skills/alpha", "H0")), null); // negative cached
});

Deno.test("assembleSkillStatuses treats a cached null as diverged without fetching commits", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { fetchFolderTree, refs } = fakeTree({ HEAD: [dir("alpha", "H3")] });
  const { fetchPathCommits, calls } = fakeCommits([c("c3"), c("c2"), c("c1")]);
  const { cache, store, k } = memCache();
  store.set(k("o/r", "skills/alpha", "H0"), null); // known absent from history

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(calls(), 0); // negative cache short-circuits the re-walk and re-fetch
  assertEquals(refs, ["HEAD"]); // only the HEAD listing
});

Deno.test("assembleSkillStatuses pins the path-commits fetch to the polled HEAD sha", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { fetchFolderTree } = fakeTree({
    HEAD: [dir("alpha", "H3")],
    c2: [dir("alpha", "H3")],
    c1: [dir("alpha", "H0")],
  });
  let passedRef: string | undefined;
  const fetchPathCommits: FetchPathCommits = (_o, _r, _p, ref) => {
    passedRef = ref;
    return Promise.resolve({ ok: true, commits: [c("c2"), c("c1")] });
  };
  const { cache } = memCache();

  await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(passedRef, "HEAD"); // the polled commit sha, not "main" (repo.branch)
});

Deno.test("assembleSkillStatuses surfaces a transient walk failure as error without caching", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  // HEAD differs (→ walk), but the per-commit listing fails transiently (5xx).
  const fetchFolderTree: FetchFolderTree = (_o, _r, _d, ref) =>
    Promise.resolve(
      ref === "HEAD"
        ? { ok: true, entries: [dir("alpha", "H3")] }
        : { ok: false, status: 502, error: "GitHub API 502 Bad Gateway" },
    );
  const { fetchPathCommits } = fakeCommits([c("c1")]);
  const { cache, store, k } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, {
    kind: "error",
    error: "GitHub API 502 Bad Gateway",
  });
  assertEquals(store.has(k("o/r", "skills/alpha", "H0")), false); // not poisoned
});

Deno.test("assembleSkillStatuses treats a 404 during the walk as folder-absent", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  // A 404 is a definitive "absent at this ref", not a transient failure: the walk
  // continues, finds no match, and negative-caches diverged.
  const fetchFolderTree: FetchFolderTree = (_o, _r, _d, ref) =>
    Promise.resolve(
      ref === "HEAD"
        ? { ok: true, entries: [dir("alpha", "H3")] }
        : { ok: false, status: 404, error: "GitHub API 404 Not Found" },
    );
  const { fetchPathCommits } = fakeCommits([c("c1")]);
  const { cache, store, k } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, { kind: "diverged" });
  assertEquals(store.get(k("o/r", "skills/alpha", "H0")), null);
});

Deno.test("assembleSkillStatuses surfaces a repo poll failure as an error state", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "H0")])];
  const { fetchFolderTree, refs } = fakeTree({});
  const { fetchPathCommits, calls } = fakeCommits([]);
  const { cache } = memCache();
  const fetchCommit: FetchCommit = () =>
    Promise.resolve({ ok: false, error: "boom" });

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit,
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows[0].state, { kind: "error", error: "boom" });
  assertEquals(refs.length, 0);
  assertEquals(calls(), 0);
});

Deno.test("assembleSkillStatuses lists a shared parent dir once for all its skills", async () => {
  const repos = [repoWith("o/r", [skill("alpha", "Ha"), skill("beta", "Hb")])];
  const { fetchFolderTree, refs } = fakeTree({
    HEAD: [dir("alpha", "Ha"), dir("beta", "Hb")], // both current
  });
  const { fetchPathCommits } = fakeCommits([]);
  const { cache } = memCache();

  const rows = await assembleSkillStatuses(repos, {
    fetchCommit: headAt("HEAD"),
    fetchFolderTree,
    fetchPathCommits,
    cache,
  });

  assertEquals(rows.map((r) => [r.name, r.state.kind]), [
    ["alpha", "current"],
    ["beta", "current"],
  ]);
  assertEquals(refs, ["HEAD"]); // one listing, memoized across both skills
});
