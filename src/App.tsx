import { useEffect } from "react";
import { renderMenu } from "./platform.ts";
import type { MenuModel } from "./engine/menu.ts";

// A static menu frame until the poll cycle builds one from real Skill status.
const PLACEHOLDER_MENU: MenuModel = {
  rows: [
    { kind: "header", label: "skill-drift — no data yet" },
    { kind: "separator" },
    { kind: "quit", label: "Quit skill-drift" },
  ],
};

function App() {
  useEffect(() => {
    void renderMenu(PLACEHOLDER_MENU);
  }, []);

  // Window stays hidden — this webview is the engine/view worker (ADR-0009); the
  // body shows only if it's unhidden for debugging.
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      skill-drift — hidden engine webview; UI is the menu-bar tray.
    </main>
  );
}

export default App;
