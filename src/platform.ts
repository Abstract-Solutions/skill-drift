// The one module that touches the native edge (@tauri-apps/api); everything else
// in src/ stays pure TS (ADR-0010).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import type { MenuModel, MenuRow } from "./engine/menu.ts";

// Shared with the Rust setup hook (TrayIconBuilder::with_id).
export const TRAY_ID = "main";

// Shared with the Rust poll-clock (POLL_TICK_EVENT, emit in lib.rs).
const POLL_TICK_EVENT = "poll-tick";

// Rust emits poll-tick on launch and on the poll cadence (ADR-0005). The tick
// is a bare signal (no payload), so cb takes no args. Returns the async unlisten.
export function onPollTick(cb: () => void): Promise<UnlistenFn> {
  return listen(POLL_TICK_EVENT, () => cb());
}

// Behind count → tray title via the Rust set_badge command (ADR-0005). 0 clears
// it; a menu-bar app has no native badge, so the count is the title text. Rust
// takes u32, so clamp to a non-negative integer — a float or negative would fail
// Tauri's deserialiser at the IPC boundary.
export function setBadge(count: number): Promise<void> {
  return invoke("set_badge", { count: Math.max(0, Math.trunc(count)) });
}

export async function renderMenu(model: MenuModel): Promise<void> {
  const items = await Promise.all(model.rows.map(toNativeItem));
  const menu = await Menu.new({ items });
  const tray = await TrayIcon.getById(TRAY_ID);
  if (!tray) throw new Error(`tray "${TRAY_ID}" not found`);
  await tray.setMenu(menu);
}

function toNativeItem(row: MenuRow): Promise<MenuItem | PredefinedMenuItem> {
  switch (row.kind) {
    case "header":
      return MenuItem.new({ text: row.label, enabled: false });
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
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
