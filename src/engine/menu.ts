// The tray menu as data: platform.ts walks a MenuModel into native
// @tauri-apps/api/menu items, keeping menu policy off the native edge (ADR-0009).

export type MenuModel = { readonly rows: readonly MenuRow[] };

export type MenuRow =
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | { kind: "quit"; label: string };
