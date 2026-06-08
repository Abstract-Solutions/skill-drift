// The poll-and-assemble seam: WatchedRepos in, per-Skill Behind status out (the
// path-filtered Watched Commit model; see CONTEXT.md). Adapters and the baseline
// cache are injected, never imported.

import type {
  Commit,
  CommitResult,
  FetchError,
  FolderEntry,
  FolderTreeResult,
  PathCommitsResult,
} from "./github.ts";
import type { WatchedRepo } from "./manifest.ts";
import { parseSource } from "./manifest.ts";

// All three never throw — failures arrive as non-ok results.
export type FetchCommit = (
  owner: string,
  repo: string,
  branch: string,
) => Promise<CommitResult>;

export type FetchFolderTree = (
  owner: string,
  repo: string,
  dir: string,
  ref: string,
) => Promise<FolderTreeResult>;

export type FetchPathCommits = (
  owner: string,
  repo: string,
  path: string,
  branch: string,
) => Promise<PathCommitsResult>;

// Resolved install baseline, keyed by the immutable folder-tree hash.
export interface BaselineCache {
  get(
    source: string,
    folder: string,
    hash: string,
  ): Promise<string | null | undefined>;
  set(
    source: string,
    folder: string,
    hash: string,
    sha: string | null,
  ): Promise<void>;
}

// The three reads the engine needs from a Skill's Source Repo, grouped behind one
// port — one seam with two adapters: makeHttpReader (github.ts) in prod, and
// makeMemoryReader (below) in tests. The methods never throw; failures arrive as
// non-ok results.
export interface SourceRepoReader {
  fetchCommit: FetchCommit;
  fetchFolderTree: FetchFolderTree;
  fetchPathCommits: FetchPathCommits;
}

export interface AssembleDeps {
  reader: SourceRepoReader;
  cache: BaselineCache;
}

export interface RepoStatus {
  source: string;
  branch: string;
  result: CommitResult;
}

// A Skill's freshness against its Source Repo's default branch. removed = folder
// gone upstream; diverged = folder changed but the installed hash isn't in history.
export type SkillState =
  | { kind: "current" }
  | { kind: "behind"; behindBy: number; baseline: string; commits: Commit[] }
  | { kind: "removed" }
  | { kind: "diverged" }
  | { kind: "error"; error: string };

export interface SkillStatus {
  name: string;
  source: string;
  branch: string;
  state: SkillState;
}

// Fetches each WatchedRepo's latest commit in parallel, preserving order.
export function pollRepos(
  repos: WatchedRepo[],
  fetchCommit: FetchCommit,
): Promise<RepoStatus[]> {
  return Promise.all(repos.map(async (r) => {
    const { owner, repo } = parseSource(r.source);
    return {
      source: r.source,
      branch: r.branch,
      result: await fetchCommit(owner, repo, r.branch),
    };
  }));
}

const dirname = (p: string) => p.split("/").slice(0, -1).join("/");
const basename = (p: string) => p.split("/").at(-1) ?? "";

// Polls each repo HEAD once, then classifies every Skill against that HEAD.
// Folder listings are memoized within the call, so Skills sharing a parent dir
// cost one listing, not one each.
export async function assembleSkillStatuses(
  repos: WatchedRepo[],
  deps: AssembleDeps,
): Promise<SkillStatus[]> {
  const repoStatuses = await pollRepos(repos, deps.reader.fetchCommit);

  const treeMemo = new Map<string, Promise<FolderTreeResult>>();
  const listFolder = (
    owner: string,
    repo: string,
    dir: string,
    ref: string,
  ) => {
    const key = `${owner}/${repo}|${dir}|${ref}`;
    let p = treeMemo.get(key);
    if (!p) {
      p = deps.reader.fetchFolderTree(owner, repo, dir, ref);
      treeMemo.set(key, p);
    }
    return p;
  };

  return Promise.all(
    repos.flatMap((repo, i) =>
      repo.skills.map((skill) =>
        classifySkill(repo, skill, repoStatuses[i].result, deps, listFolder)
      )
    ),
  );
}

async function classifySkill(
  repo: WatchedRepo,
  skill: WatchedRepo["skills"][number],
  head: CommitResult,
  deps: AssembleDeps,
  listFolder: (
    o: string,
    r: string,
    d: string,
    ref: string,
  ) => Promise<FolderTreeResult>,
): Promise<SkillStatus> {
  const meta = { name: skill.name, source: repo.source, branch: repo.branch };
  const state = await skillState(repo, skill, head, deps, listFolder);
  return { ...meta, state };
}

async function skillState(
  repo: WatchedRepo,
  skill: WatchedRepo["skills"][number],
  head: CommitResult,
  deps: AssembleDeps,
  listFolder: (
    o: string,
    r: string,
    d: string,
    ref: string,
  ) => Promise<FolderTreeResult>,
): Promise<SkillState> {
  if (!head.ok) return { kind: "error", error: head.error };

  const { owner, repo: repoName } = parseSource(repo.source);
  // skillPath is the Skill's folder (e.g. "skills/git-helper"), not a file —
  // see CONTEXT.md. Don't dirname it.
  const folder = skill.skillPath;
  const parent = dirname(folder);
  const leaf = basename(folder);
  const folderShaAt = async (ref: string): Promise<FolderShaResult> => {
    const res = await listFolder(owner, repoName, parent, ref);
    if (!res.ok) {
      // 404 = parent dir absent at this ref (definitive). Other failures are
      // transient (rate limit / 5xx / network) — surface them so the walk aborts
      // instead of negative-caching a wrong "diverged". Match the typed status, not
      // the error text (human-facing, free to change).
      if (res.status === 404) {
        return { ok: true, sha: null };
      }
      return { ok: false, error: res.error };
    }
    const sha = res.entries.find((e) => e.name === leaf && e.type === "dir")
      ?.sha ?? null;
    return { ok: true, sha };
  };

  // Folder-tree at HEAD: missing → removed; equal → current.
  const headTree = await listFolder(owner, repoName, parent, head.commit.sha);
  if (!headTree.ok) return { kind: "error", error: headTree.error };
  const headEntry = headTree.entries.find((e) =>
    e.name === leaf && e.type === "dir"
  );
  if (!headEntry) return { kind: "removed" };
  if (headEntry.sha === skill.skillFolderHash) return { kind: "current" };

  // Behind or diverged: count the Watched Commits down to the install baseline.
  // A cached null means the hash is known absent from the full history —
  // diverged without re-fetching or re-walking.
  const hash = skill.skillFolderHash;
  const cached = await deps.cache.get(repo.source, folder, hash);
  if (cached === null) return { kind: "diverged" };

  // Pin the commit list to the polled HEAD sha (not repo.branch) so it can't
  // drift if the branch advances mid-request — the folder-tree compare used the
  // same sha.
  const commitsRes = await deps.reader.fetchPathCommits(
    owner,
    repoName,
    folder,
    head.commit.sha,
  );
  if (!commitsRes.ok) return { kind: "error", error: commitsRes.error };
  const commits = commitsRes.commits;

  let idx: number;
  if (typeof cached === "string") {
    idx = commits.findIndex((c) => c.sha === cached); // resolved baseline; no walk
  } else {
    const walked = await baselineIndex(commits, hash, folderShaAt);
    if (!walked.ok) return { kind: "error", error: walked.error };
    idx = walked.idx;
    // commits is the full path history (the adapter paginates) and every listing
    // succeeded, so a miss here is a definitive "not in history" — safe to cache.
    await deps.cache.set(
      repo.source,
      folder,
      hash,
      idx >= 0 ? commits[idx].sha : null,
    );
  }
  if (idx < 0) return { kind: "diverged" };
  if (idx === 0) return { kind: "current" };
  return {
    kind: "behind",
    behindBy: idx,
    baseline: commits[idx].sha,
    commits: commits.slice(0, idx),
  };
}

// sha of the leaf folder at a ref (null = absent), or a transient listing failure.
type FolderShaResult =
  | { ok: true; sha: string | null }
  | { ok: false; error: string };

// Index of the commit whose folder-tree == hash (newest-first, so the index is the
// Behind count); -1 if none in the history. A transient folder-listing failure
// aborts the walk as an error, so it isn't mistaken for "not in history".
async function baselineIndex(
  commits: Commit[],
  hash: string,
  folderShaAt: (ref: string) => Promise<FolderShaResult>,
): Promise<{ ok: true; idx: number } | { ok: false; error: string }> {
  for (let i = 0; i < commits.length; i++) {
    const r = await folderShaAt(commits[i].sha);
    if (!r.ok) return r;
    if (r.sha === hash) return { ok: true, idx: i };
  }
  return { ok: true, idx: -1 };
}

// In-memory BaselineCache for the tracer-bullet slice (#5); the store-backed
// implementation (ADR-0008) replaces it later. Resolved baselines live only for
// the session — losing them on relaunch costs one poll, not data (ADR-0004). Key
// matches the store schema (`${source}|${folder}|${hash}`); a missing key reads as
// undefined (uncached), a stored null as known-absent (Diverged).
export function makeMemoryCache(): BaselineCache {
  const store = new Map<string, string | null>();
  const key = (source: string, folder: string, hash: string) =>
    `${source}|${folder}|${hash}`;
  return {
    get: (source, folder, hash) =>
      Promise.resolve(store.get(key(source, folder, hash))),
    set: (source, folder, hash, sha) => {
      store.set(key(source, folder, hash), sha);
      return Promise.resolve();
    },
  };
}

// In-memory SourceRepoReader for tests — the reader seam's second adapter, mirroring
// makeMemoryCache for the cache seam. A git-shaped world replaces the three
// hand-rolled fetcher fakes: one history is described once, and the three reads are
// derived as views of it, so a test can't construct a HEAD/commits/tree triple that
// disagrees the way three separate fakes could.

// One commit in a MemoryWorld. folders names only the watched folders this commit
// *changes*, folder path → tree-sha (null = removed from this commit on); unlisted
// folders carry forward. message/author/date default to empty for commits a test
// doesn't decorate.
export interface MemoryCommit {
  sha: string;
  folders: Record<string, string | null>;
  message?: string;
  author?: string;
  date?: string;
}

// A git-shaped in-memory Source Repo: an ordered history, oldest → newest, the last
// entry being HEAD.
export interface MemoryWorld {
  /** "owner/repo" — the one Source Repo this reader serves; other repos 404. */
  source: string;
  /** Oldest → newest; the last entry is HEAD. Non-empty. */
  history: MemoryCommit[];
}

// What the reader recorded, so tests keep the hand-rolled fakes' interaction checks:
// listedRefs is every folder-tree ref actually listed (post-memoization), in order;
// pathCommitsCalls counts the path-history fetches.
export interface ReaderCalls {
  listedRefs: string[];
  pathCommitsCalls: number;
}

export function makeMemoryReader(
  world: MemoryWorld,
): { reader: SourceRepoReader; calls: ReaderCalls } {
  const calls: ReaderCalls = { listedRefs: [], pathCommitsCalls: 0 };
  const history = world.history;
  const allFolders = new Set(history.flatMap((c) => Object.keys(c.folders)));

  const indexOf = (ref: string) => history.findIndex((c) => c.sha === ref);

  // Carry-forward tree-sha of a folder as of commit index i: the latest declaration
  // in history[0..i], or null when never declared or last removed.
  const folderShaAt = (i: number, folder: string): string | null => {
    let sha: string | null = null;
    for (let j = 0; j <= i; j++) {
      const v = history[j].folders[folder];
      if (v !== undefined) sha = v;
    }
    return sha;
  };

  const asCommit = (c: MemoryCommit): Commit => ({
    sha: c.sha,
    message: c.message ?? "",
    author: c.author ?? "",
    date: c.date ?? "",
  });

  const notFound = (what: string): FetchError => ({
    ok: false,
    status: 404,
    error: `memory reader: ${what} not found`,
  });

  const serves = (owner: string, repo: string) =>
    `${owner}/${repo}` === world.source;

  const reader: SourceRepoReader = {
    fetchCommit: (owner, repo) => {
      if (!serves(owner, repo)) {
        return Promise.resolve(notFound(`${owner}/${repo}`));
      }
      const head = history.at(-1);
      if (!head) return Promise.resolve(notFound("HEAD"));
      return Promise.resolve({ ok: true, commit: asCommit(head) });
    },
    fetchFolderTree: (owner, repo, dir, ref) => {
      if (!serves(owner, repo)) {
        return Promise.resolve(notFound(`${owner}/${repo}`));
      }
      // An unknown ref is a missing commit: 404 as the HTTP adapter would, so the two
      // adapters stay substitutable rather than this one silently listing nothing.
      const i = indexOf(ref);
      if (i < 0) return Promise.resolve(notFound(`ref ${ref}`));
      calls.listedRefs.push(ref);
      // The parent's children at this ref: every watched folder under `dir` present
      // (non-null) after carry-forward.
      const entries: FolderEntry[] = [];
      for (const folder of allFolders) {
        if (dirname(folder) !== dir) continue;
        const sha = folderShaAt(i, folder);
        if (sha !== null) {
          entries.push({ name: basename(folder), sha, type: "dir" });
        }
      }
      return Promise.resolve({ ok: true, entries });
    },
    fetchPathCommits: (owner, repo, path, ref) => {
      if (!serves(owner, repo)) {
        return Promise.resolve(notFound(`${owner}/${repo}`));
      }
      const start = indexOf(ref);
      if (start < 0) return Promise.resolve(notFound(`ref ${ref}`));
      calls.pathCommitsCalls++;
      // Newest-first: walk down from the ref, emitting each commit that *changed*
      // path — its declared sha differs from the carry-forward at the prior commit.
      const commits: Commit[] = [];
      for (let i = start; i >= 0; i--) {
        const declared = history[i].folders[path];
        if (declared !== undefined && declared !== folderShaAt(i - 1, path)) {
          commits.push(asCommit(history[i]));
        }
      }
      return Promise.resolve({ ok: true, commits });
    },
  };

  return { reader, calls };
}
