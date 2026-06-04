import { assertEquals } from "@std/assert";
import {
  makeFolderTreeFetcher,
  makeGitHubFetcher,
  makePathCommitsFetcher,
} from "./github.ts";

// Fake fetch: records each request, returns a canned Response (or rejects with
// a transport error). Injected via the makeGitHubFetcher seam — no real network.
function fakeFetch(response: Response | Error) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  };
  return { fetchImpl, calls };
}

// Returns each response in turn (last one repeats), so pagination can be driven
// page by page.
function fakeFetchSeq(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  let i = 0;
  const fetchImpl: typeof fetch = (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { fetchImpl, calls };
}

const payload = {
  sha: "abc1234def",
  commit: {
    message: "fix: thing\n\nbody",
    author: { name: "Ada", date: "2026-05-01T00:00:00Z" },
    committer: { date: "2026-05-02T00:00:00Z" },
  },
};

Deno.test("makeGitHubFetcher sends Bearer auth when given a token", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response(JSON.stringify(payload)));

  await makeGitHubFetcher("tok-123", fetchImpl)("o", "r", "main");

  assertEquals(calls[0].headers.get("Authorization"), "Bearer tok-123");
});

Deno.test("makeGitHubFetcher omits auth when no token", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response(JSON.stringify(payload)));

  await makeGitHubFetcher(undefined, fetchImpl)("o", "r", "main");

  assertEquals(calls[0].headers.has("Authorization"), false);
});

Deno.test("makeGitHubFetcher targets the commits endpoint for owner/repo/branch", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response(JSON.stringify(payload)));

  await makeGitHubFetcher(undefined, fetchImpl)("octocat", "hello", "dev");

  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/octocat/hello/commits/dev",
  );
});

Deno.test("makeGitHubFetcher maps a 200 payload into a Commit", async () => {
  const { fetchImpl } = fakeFetch(new Response(JSON.stringify(payload)));

  const result = await makeGitHubFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "main",
  );

  assertEquals(result, {
    ok: true,
    commit: {
      sha: "abc1234def",
      message: "fix: thing\n\nbody",
      author: "Ada",
      date: "2026-05-01T00:00:00Z",
    },
  });
});

Deno.test("makeGitHubFetcher reports a non-ok status as an error", async () => {
  const { fetchImpl } = fakeFetch(
    new Response("nope", { status: 404, statusText: "Not Found" }),
  );

  const result = await makeGitHubFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "main",
  );

  assertEquals(result, {
    ok: false,
    status: 404,
    error: "GitHub API 404 Not Found",
  });
});

Deno.test("makeGitHubFetcher surfaces a transport failure as an error", async () => {
  const { fetchImpl } = fakeFetch(new Error("network down"));

  const result = await makeGitHubFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "main",
  );

  assertEquals(result, { ok: false, error: "network down" });
});

Deno.test("makeGitHubFetcher falls back to unknown author and committer date", async () => {
  const { fetchImpl } = fakeFetch(
    new Response(JSON.stringify({
      sha: "deadbeef",
      commit: { message: "m", committer: { date: "2026-05-02T00:00:00Z" } },
    })),
  );

  const result = await makeGitHubFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "main",
  );

  assertEquals(result, {
    ok: true,
    commit: {
      sha: "deadbeef",
      message: "m",
      author: "unknown",
      date: "2026-05-02T00:00:00Z",
    },
  });
});

const folderPayload = [
  { name: "alpha", sha: "treeA", type: "dir" },
  { name: "beta", sha: "treeB", type: "dir" },
  { name: "README.md", sha: "blobR", type: "file" },
];

Deno.test("makeFolderTreeFetcher targets the contents endpoint for dir + ref", async () => {
  const { fetchImpl, calls } = fakeFetch(
    new Response(JSON.stringify(folderPayload)),
  );

  await makeFolderTreeFetcher(undefined, fetchImpl)(
    "octocat",
    "hello",
    "skills",
    "main",
  );

  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/octocat/hello/contents/skills?ref=main",
  );
});

Deno.test("makeFolderTreeFetcher lists the repo root for an empty dir", async () => {
  const { fetchImpl, calls } = fakeFetch(
    new Response(JSON.stringify(folderPayload)),
  );

  await makeFolderTreeFetcher(undefined, fetchImpl)("o", "r", "", "abc123");

  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/o/r/contents?ref=abc123",
  );
});

Deno.test("makeFolderTreeFetcher sends Bearer auth when given a token", async () => {
  const { fetchImpl, calls } = fakeFetch(
    new Response(JSON.stringify(folderPayload)),
  );

  await makeFolderTreeFetcher("tok-123", fetchImpl)("o", "r", "skills", "main");

  assertEquals(calls[0].headers.get("Authorization"), "Bearer tok-123");
});

Deno.test("makeFolderTreeFetcher maps entries to name/sha/type", async () => {
  const { fetchImpl } = fakeFetch(new Response(JSON.stringify(folderPayload)));

  const result = await makeFolderTreeFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "skills",
    "main",
  );

  assertEquals(result, {
    ok: true,
    entries: [
      { name: "alpha", sha: "treeA", type: "dir" },
      { name: "beta", sha: "treeB", type: "dir" },
      { name: "README.md", sha: "blobR", type: "file" },
    ],
  });
});

Deno.test("makeFolderTreeFetcher yields [] when the path is a file (object body)", async () => {
  const { fetchImpl } = fakeFetch(
    new Response(JSON.stringify({ name: "SKILL.md", type: "file" })),
  );

  const result = await makeFolderTreeFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "skills/x/SKILL.md",
    "main",
  );

  assertEquals(result, { ok: true, entries: [] });
});

Deno.test("makeFolderTreeFetcher reports a non-ok status as an error", async () => {
  const { fetchImpl } = fakeFetch(
    new Response("nope", { status: 404, statusText: "Not Found" }),
  );

  const result = await makeFolderTreeFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "gone",
    "main",
  );

  assertEquals(result, {
    ok: false,
    status: 404,
    error: "GitHub API 404 Not Found",
  });
});

Deno.test("makeFolderTreeFetcher surfaces a transport failure as an error", async () => {
  const { fetchImpl } = fakeFetch(new Error("network down"));

  const result = await makeFolderTreeFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "skills",
    "main",
  );

  assertEquals(result, { ok: false, error: "network down" });
});

const pathCommitsPayload = [
  {
    sha: "c2",
    commit: {
      message: "newer\n\nbody",
      author: { name: "Bo", date: "2026-05-02T00:00:00Z" },
    },
  },
  {
    sha: "c1",
    commit: {
      message: "older",
      author: { name: "Ada", date: "2026-05-01T00:00:00Z" },
    },
  },
];

Deno.test("makePathCommitsFetcher targets the commits endpoint with sha, path, per_page", async () => {
  const { fetchImpl, calls } = fakeFetch(
    new Response(JSON.stringify(pathCommitsPayload)),
  );

  await makePathCommitsFetcher(undefined, fetchImpl)(
    "octocat",
    "hello",
    "skills/x",
    "main",
  );

  assertEquals(
    calls[0].url,
    "https://api.github.com/repos/octocat/hello/commits?sha=main&path=skills%2Fx&per_page=100",
  );
});

Deno.test("makePathCommitsFetcher maps commits newest-first via toCommit", async () => {
  const { fetchImpl } = fakeFetch(
    new Response(JSON.stringify(pathCommitsPayload)),
  );

  const result = await makePathCommitsFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "p",
    "main",
  );

  assertEquals(result, {
    ok: true,
    commits: [
      {
        sha: "c2",
        message: "newer\n\nbody",
        author: "Bo",
        date: "2026-05-02T00:00:00Z",
      },
      {
        sha: "c1",
        message: "older",
        author: "Ada",
        date: "2026-05-01T00:00:00Z",
      },
    ],
  });
});

Deno.test("makePathCommitsFetcher reports a non-ok status as an error", async () => {
  const { fetchImpl } = fakeFetch(
    new Response("nope", { status: 422, statusText: "Unprocessable" }),
  );

  const result = await makePathCommitsFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "p",
    "main",
  );

  assertEquals(result, {
    ok: false,
    status: 422,
    error: "GitHub API 422 Unprocessable",
  });
});

Deno.test("makePathCommitsFetcher surfaces a transport failure as an error", async () => {
  const { fetchImpl } = fakeFetch(new Error("network down"));

  const result = await makePathCommitsFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "p",
    "main",
  );

  assertEquals(result, { ok: false, error: "network down" });
});

const page = (shas: string[]) =>
  JSON.stringify(shas.map((sha) => ({ sha, commit: { message: sha } })));

Deno.test("makePathCommitsFetcher follows rel=next and concatenates all pages", async () => {
  const next =
    "https://api.github.com/repos/o/r/commits?sha=main&path=p&per_page=100&page=2";
  const { fetchImpl, calls } = fakeFetchSeq([
    new Response(page(["c3", "c2"]), {
      headers: { link: `<${next}>; rel="next", <${next}>; rel="last"` },
    }),
    new Response(page(["c1"])), // no Link → last page
  ]);

  const result = await makePathCommitsFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "p",
    "main",
  );

  assertEquals(result.ok && result.commits.map((c) => c.sha), [
    "c3",
    "c2",
    "c1",
  ]);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].url, next); // followed the header URL verbatim
});

Deno.test("makePathCommitsFetcher stops after one request when there's no rel=next", async () => {
  const { fetchImpl, calls } = fakeFetchSeq([new Response(page(["c1"]))]);

  await makePathCommitsFetcher(undefined, fetchImpl)("o", "r", "p", "main");

  assertEquals(calls.length, 1);
});

Deno.test("makePathCommitsFetcher fails the whole fetch when a later page errors", async () => {
  const next =
    "https://api.github.com/repos/o/r/commits?sha=main&path=p&per_page=100&page=2";
  const { fetchImpl } = fakeFetchSeq([
    new Response(page(["c2"]), {
      headers: { link: `<${next}>; rel="next"` },
    }),
    new Response("nope", { status: 500, statusText: "Server Error" }),
  ]);

  const result = await makePathCommitsFetcher(undefined, fetchImpl)(
    "o",
    "r",
    "p",
    "main",
  );

  assertEquals(result, {
    ok: false,
    status: 500,
    error: "GitHub API 500 Server Error",
  });
});
