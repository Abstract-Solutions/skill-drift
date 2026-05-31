// GitHub REST client (makeGitHubFetcher, makeFolderTreeFetcher,
// makePathCommitsFetcher). The caller (edge) supplies the token; this module
// never reads the environment.

const GITHUB_API = "https://api.github.com";

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export type CommitResult =
  | { ok: true; commit: Commit }
  | { ok: false; error: string };

// A directory's child entries at a ref. sha on a "dir" entry is its tree SHA —
// the same kind of hash the Manifest stores as skillFolderHash.
export interface FolderEntry {
  name: string;
  sha: string;
  type: string;
}

export type FolderTreeResult =
  | { ok: true; entries: FolderEntry[] }
  | { ok: false; error: string };

export type PathCommitsResult =
  | { ok: true; commits: Commit[] }
  | { ok: false; error: string };

// One commit element from the /commits endpoint.
interface RawCommit {
  sha: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
}

function toCommit(data: RawCommit): Commit {
  return {
    sha: data.sha,
    message: data.commit?.message ?? "",
    author: data.commit?.author?.name ?? "unknown",
    date: data.commit?.author?.date ?? data.commit?.committer?.date ?? "",
  };
}

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// fetchImpl is an internal seam: tests inject a fake; the edge calls makeGitHubFetcher(token).
export function makeGitHubFetcher(
  token?: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (
    owner: string,
    repo: string,
    branch: string,
  ): Promise<CommitResult> => {
    try {
      const res = await fetchImpl(
        `${GITHUB_API}/repos/${owner}/${repo}/commits/${branch}`,
        { headers: ghHeaders(token) },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: `GitHub API ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true, commit: toCommit(await res.json()) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// Lists a directory's child entries at a ref (branch or commit SHA); dir "" lists
// the repo root.
export function makeFolderTreeFetcher(
  token?: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (
    owner: string,
    repo: string,
    dir: string,
    ref: string,
  ): Promise<FolderTreeResult> => {
    try {
      // dir segments keep their "/" separators; encode each part. ref is a
      // query value, so encode it whole.
      const path = dir
        ? "/" + dir.split("/").map(encodeURIComponent).join("/")
        : "";
      const res = await fetchImpl(
        `${GITHUB_API}/repos/${owner}/${repo}/contents${path}?ref=${
          encodeURIComponent(ref)
        }`,
        { headers: ghHeaders(token) },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: `GitHub API ${res.status} ${res.statusText}`,
        };
      }
      const data = await res.json();
      const entries: FolderEntry[] = Array.isArray(data)
        ? data.map((e) => ({ name: e.name, sha: e.sha, type: e.type }))
        : [];
      return { ok: true, entries };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// The rel="next" URL from a GitHub Link header, or null on the last page.
function nextLink(header: string | null): string | null {
  const m = header?.match(/<([^>]+)>\s*;\s*rel="next"/);
  return m ? m[1] : null;
}

// Lists every commit that touched path on branch, newest first — a Skill's
// Watched Commits. Pages through the full history via the Link header so a
// baseline older than 100 commits is still found (the null baseline cache
// depends on this walk being exhaustive).
export function makePathCommitsFetcher(
  token?: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (
    owner: string,
    repo: string,
    path: string,
    branch: string,
  ): Promise<PathCommitsResult> => {
    try {
      // sha (branch) and path are query values — encode both.
      let url: string | null =
        `${GITHUB_API}/repos/${owner}/${repo}/commits?sha=${
          encodeURIComponent(branch)
        }&path=${encodeURIComponent(path)}&per_page=100`;
      const commits: Commit[] = [];
      while (url) {
        const res = await fetchImpl(url, { headers: ghHeaders(token) });
        if (!res.ok) {
          return {
            ok: false,
            error: `GitHub API ${res.status} ${res.statusText}`,
          };
        }
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const c of data) commits.push(toCommit(c));
        }
        url = nextLink(res.headers.get("link"));
      }
      return { ok: true, commits };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const sec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
