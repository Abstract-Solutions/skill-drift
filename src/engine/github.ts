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

// The shared failure arm for every GitHub fetch. status is set only on a non-ok
// HTTP response (e.g. 404) — the case callers classify on (poll.ts: 404 = folder
// absent at this ref). It is left undefined otherwise: a transport failure has no
// response, and a parse failure of an otherwise-ok (200) body has no failure status
// worth matching. error stays human-readable, surfaced in the Error freshness state.
export type FetchError = { ok: false; status?: number; error: string };

export type CommitResult = { ok: true; commit: Commit } | FetchError;

// A directory's child entries at a ref. sha on a "dir" entry is its tree SHA —
// the same kind of hash the Manifest stores as skillFolderHash.
export interface FolderEntry {
  name: string;
  sha: string;
  type: string;
}

export type FolderTreeResult =
  | { ok: true; entries: FolderEntry[] }
  | FetchError;

export type PathCommitsResult = { ok: true; commits: Commit[] } | FetchError;

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

// The request core (internal seam): headers, fetch, the status-check error, JSON
// parse, and Link extraction, in one place. On success returns the parsed body and
// the rel="next" link; otherwise a typed FetchError — status set only when the
// response was non-ok, so a transport or parse failure carries none. The three
// fetchers below shape `data` into their domain result; tests drive them, not this.
async function ghGet(
  url: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: unknown; link: string | null } | FetchError> {
  try {
    const res = await fetchImpl(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `GitHub API ${res.status} ${res.statusText}`,
      };
    }
    return {
      ok: true,
      data: await res.json(),
      link: nextLink(res.headers.get("link")),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Latest commit on a branch. The edge calls makeGitHubFetcher(token); tests inject
// fetchImpl through ghGet.
export function makeGitHubFetcher(
  token?: string,
  fetchImpl: typeof fetch = fetch,
) {
  return async (
    owner: string,
    repo: string,
    branch: string,
  ): Promise<CommitResult> => {
    const r = await ghGet(
      `${GITHUB_API}/repos/${owner}/${repo}/commits/${branch}`,
      token,
      fetchImpl,
    );
    return r.ok ? { ok: true, commit: toCommit(r.data as RawCommit) } : r;
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
    // dir segments keep their "/" separators; encode each part. ref is a query
    // value, so encode it whole.
    const path = dir
      ? "/" + dir.split("/").map(encodeURIComponent).join("/")
      : "";
    const r = await ghGet(
      `${GITHUB_API}/repos/${owner}/${repo}/contents${path}?ref=${
        encodeURIComponent(ref)
      }`,
      token,
      fetchImpl,
    );
    if (!r.ok) return r;
    const entries: FolderEntry[] = Array.isArray(r.data)
      ? r.data.map((e) => ({ name: e.name, sha: e.sha, type: e.type }))
      : [];
    return { ok: true, entries };
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
    // sha (branch) and path are query values — encode both.
    let url: string | null =
      `${GITHUB_API}/repos/${owner}/${repo}/commits?sha=${
        encodeURIComponent(branch)
      }&path=${encodeURIComponent(path)}&per_page=100`;
    const commits: Commit[] = [];
    while (url) {
      const r = await ghGet(url, token, fetchImpl);
      if (!r.ok) return r;
      if (Array.isArray(r.data)) {
        for (const c of r.data) commits.push(toCommit(c));
      }
      url = r.link;
    }
    return { ok: true, commits };
  };
}

// One constructor for the three fetchers, shaped for AssembleDeps (poll.ts's
// Fetchers). The edge calls makeFetchers(token) once and spreads it; the token and
// fetchImpl flow through to each. Inferred return matches Fetchers structurally —
// annotating it here would import poll.ts (which imports this module).
export function makeFetchers(token?: string, fetchImpl: typeof fetch = fetch) {
  return {
    fetchCommit: makeGitHubFetcher(token, fetchImpl),
    fetchFolderTree: makeFolderTreeFetcher(token, fetchImpl),
    fetchPathCommits: makePathCommitsFetcher(token, fetchImpl),
  };
}
