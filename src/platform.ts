// The one module that touches the native edge (@tauri-apps/api); everything else
// in src/ stays pure TS (ADR-0010).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import type { MenuModel, MenuRow } from "./engine/menu.ts";
import type { Snapshot } from "./engine/cycle.ts";
import { makeMemoryCache } from "./engine/poll.ts";

// Shared with the Rust setup hook (TrayIconBuilder::with_id).
export const TRAY_ID = "main";

// Shared with the Rust poll-clock (POLL_TICK_EVENT, emit in lib.rs).
const POLL_TICK_EVENT = "poll-tick";

// Rust emits poll-tick on launch and on the poll cadence (ADR-0005). The tick
// is a bare signal (no payload), so cb takes no args. Returns the async unlisten.
export function onPollTick(cb: () => void): Promise<UnlistenFn> {
  return listen(POLL_TICK_EVENT, () => cb());
}

// The menu-bar attention mark via the Rust set_alert command (ADR-0013): on=true
// swaps the tray to the exclamation template, on=false the plain branch glyph. The
// Behind count is no longer surfaced in the bar — it's a binary "anything Behind?"
// signal; the exact counts live in the menu rows (· N behind). Revises ADR-0005's
// count-as-tray-title.
export function setAlert(on: boolean): Promise<void> {
  return invoke("set_alert", { on });
}

// Reads the Manifest via the Rust read_manifest command (ADR-0007) — the
// webview's only filesystem reach, the path fixed in Rust. Resolves to the raw
// contents, or null when the file is absent. All parsing stays in TS (the cycle's
// parseManifest); Rust's Option<String> maps to string | null at the IPC edge.
export function readManifest(): Promise<string | null> {
  return invoke<string | null>("read_manifest");
}

// The GitHub token, resolved by Rust via get_token (ADR-0006): Rust owns where the
// secret lives and hands over the bytes; TS uses the token — it flows into the
// fetchers' Authorization header — but never persists it, so ADR-0002 holds (Rust
// hands over bytes, never classifies). Resolves to the stored Keychain PAT, else a
// gh-resolved token (env GH_TOKEN/GITHUB_TOKEN or `gh auth token`), or null when
// none — the cycle's no-token short-circuit. The unauthenticated degrade (ADR-0006)
// stays deferred past the tracer bullet.
export function getToken(): Promise<string | null> {
  return invoke<string | null>("get_token");
}

// App-private cycle state (ADR-0008). For this slice both are in-memory: the
// store-backed cache + snapshot are deferred. The cache is a module singleton so
// resolved baselines survive across polls within the session; saveSnapshot stamps
// polledAt-bearing snapshots — held only in the webview's log until #6's popover
// reads them back. now is the injectable clock the cycle stamps the snapshot with.
export const cache = makeMemoryCache();

export function saveSnapshot(snapshot: Snapshot): Promise<void> {
  console.debug("snapshot saved", snapshot);
  return Promise.resolve();
}

export const now = (): Date => new Date();

export async function renderMenu(model: MenuModel): Promise<void> {
  const items = await Promise.all(model.rows.map(toNativeItem));
  const menu = await Menu.new({ items });
  const tray = await TrayIcon.getById(TRAY_ID);
  if (!tray) throw new Error(`tray "${TRAY_ID}" not found`);
  await tray.setMenu(menu);
}

type NativeItem = MenuItem | PredefinedMenuItem;

function toNativeItem(row: MenuRow): Promise<NativeItem> {
  switch (row.kind) {
    case "header":
      return MenuItem.new({ text: row.label, enabled: false });
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
    case "item":
      return MenuItem.new({ text: row.label, enabled: row.enabled });
    case "quit":
      return PredefinedMenuItem.new({ item: "Quit", text: row.label });
    default:
      // Exhaustiveness: a new MenuRow kind fails tsc here; guards a bad kind at runtime.
      return assertNever(row);
  }
}

function assertNever(row: never): never {
  throw new Error(`unknown menu row kind: ${(row as MenuRow).kind}`);
}
