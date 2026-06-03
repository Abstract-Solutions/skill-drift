// The one module that touches the native edge (@tauri-apps/api); everything else
// in src/ stays pure TS (ADR-0010).

import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import type { MenuModel, MenuRow } from "./engine/menu.ts";

// Shared with the Rust setup hook (TrayIconBuilder::with_id).
export const TRAY_ID = "main";

export async function renderMenu(model: MenuModel): Promise<void> {
  const items = await Promise.all(model.rows.map(toNativeItem));
  const menu = await Menu.new({ items });
  const tray = await TrayIcon.getById(TRAY_ID);
  await tray?.setMenu(menu);
}

function toNativeItem(row: MenuRow): Promise<MenuItem | PredefinedMenuItem> {
  switch (row.kind) {
    case "header":
      return MenuItem.new({ text: row.label, enabled: false });
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
    case "quit":
      return PredefinedMenuItem.new({ item: "Quit", text: row.label });
  }
}
