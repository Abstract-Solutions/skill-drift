import { assertEquals } from "@std/assert";
import { runPollCycle } from "./cycle.ts";

// Fake readManifest port (ADR-0010): the cycle's one edge, injected as raw → the
// Promise the real Rust command resolves to.
const deps = (raw: string | null) => ({
  readManifest: () => Promise.resolve(raw),
});

const manifest = (skills: Record<string, unknown>) =>
  JSON.stringify({ version: 1, skills });

const gh = (source: string) => ({
  source,
  sourceType: "github",
  skillPath: "skills/a",
  skillFolderHash: "h1",
});

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
  const raw = manifest({ a: { ...gh("x/y"), sourceType: "local" } });
  assertEquals((await runPollCycle(deps(raw))).kind, "no-manifest");
});

Deno.test("runPollCycle: installed Manifest → ok with derived repos", async () => {
  const out = await runPollCycle(deps(manifest({ a: gh("owner/repo") })));
  assertEquals(out.kind, "ok");
  if (out.kind !== "ok") return; // narrow for the fields below
  assertEquals(out.behind, 0);
  assertEquals(out.repos, [
    {
      source: "owner/repo",
      branch: "main",
      skills: [{ name: "a", skillPath: "skills/a", skillFolderHash: "h1" }],
    },
  ]);
});
