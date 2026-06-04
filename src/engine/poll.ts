// The poll-and-assemble seam: WatchedRepos in, per-Skill Behind status out (the
// path-filtered Watched Commit model; see CONTEXT.md). Adapters and the baseline
// cache are injected, never imported.

import type {
  Commit,
  CommitResult,
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

export interface AssembleDeps {
  fetchCommit: FetchCommit;
  fetchFolderTree: FetchFolderTree;
  fetchPathCommits: FetchPathCommits;
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
  const repoStatuses = await pollRepos(repos, deps.fetchCommit);

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
      p = deps.fetchFolderTree(owner, repo, dir, ref);
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
  const commitsRes = await deps.fetchPathCommits(
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
