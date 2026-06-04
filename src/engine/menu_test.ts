import { assertEquals } from "@std/assert";
import {
  bootMenu,
  installedMenu,
  malformedMenu,
  type MenuModel,
  nothingInstalledMenu,
} from "./menu.ts";
import type { WatchedRepo } from "./manifest.ts";

const repo = (...names: string[]): WatchedRepo => ({
  source: "owner/repo",
  branch: "main",
  skills: names.map((name) => ({ name, skillPath: "p", skillFolderHash: "h" })),
});

const header = (model: MenuModel): string => {
  const row = model.rows.find((r) => r.kind === "header");
  if (row?.kind !== "header") throw new Error("menu has no header row");
  return row.label;
};

// Every outcome's menu ends in Quit so the app is always dismissable (ADR-0009).
const endsInQuit = (model: MenuModel): boolean =>
  model.rows.at(-1)?.kind === "quit";

Deno.test("installedMenu singularises a single Skill", () => {
  assertEquals(
    header(installedMenu([repo("a")])),
    "skill-drift — watching 1 skill",
  );
});

Deno.test("installedMenu counts Skills across repos", () => {
  assertEquals(
    header(installedMenu([repo("a", "b"), repo("c")])),
    "skill-drift — watching 3 skills",
  );
});

Deno.test("nothingInstalledMenu and malformedMenu headline their state", () => {
  assertEquals(
    header(nothingInstalledMenu()),
    "skill-drift — no skills installed",
  );
  assertEquals(header(malformedMenu()), "skill-drift — manifest unreadable");
});

Deno.test("bootMenu headlines the starting state", () => {
  assertEquals(header(bootMenu()), "skill-drift — starting…");
});

Deno.test("every menu frame ends in Quit", () => {
  assertEquals(endsInQuit(bootMenu()), true);
  assertEquals(endsInQuit(installedMenu([repo("a")])), true);
  assertEquals(endsInQuit(nothingInstalledMenu()), true);
  assertEquals(endsInQuit(malformedMenu()), true);
});
