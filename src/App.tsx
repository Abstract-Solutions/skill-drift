import { useEffect } from "react";
import { onPollTick, renderMenu, setBadge } from "./platform.ts";
import { makePollScheduler } from "./engine/schedule.ts";
import { runPollCycle } from "./engine/cycle.ts";
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
    // Hidden webview: an unhandled rejection would be invisible, so log it.
    renderMenu(PLACEHOLDER_MENU).catch((err) => {
      console.error("renderMenu failed", err);
    });

    // The Poll Cycle, coalesced (ADR-0010): the mount poll below and the Rust
    // poll-tick both drive it, and the interval can tick mid-cycle — the
    // scheduler keeps at most one run in flight plus one trailing.
    let ticks = 0;
    const scheduler = makePollScheduler(async () => {
      // Stub this slice (#3): proves the cycle seam compiles and awaits. The
      // next slice returns a real PollOutcome whose `behind` feeds setBadge.
      await runPollCycle();
      // Tracer bullet: badge the running tick count so the whole pipe is visible
      // end to end (poll-tick → scheduler → setBadge → tray title). Swapped for
      // setBadge(out.behind) once runPollCycle returns real Behind counts.
      ticks += 1;
      await setBadge(ticks);
    });

    // Mount poll covers the startup race where Rust's launch tick beats this
    // listener (events aren't buffered); the listener catches every tick after.
    scheduler.trigger();
    // listen() resolves async but React cleanup is synchronous: capture the
    // unlisten eagerly and handle either ordering, so no tick fires after
    // teardown and a listen() failure can't surface as an unhandled rejection.
    let off: (() => void) | undefined;
    let stopped = false;
    onPollTick(() => {
      // Visible in the webview devtools — the "frontend receives it" signal (#3).
      console.info("poll-tick received");
      scheduler.trigger();
    })
      .then((fn) => {
        off = fn;
        if (stopped) fn(); // unmounted before listen resolved
      })
      .catch((err) => console.error("onPollTick listen failed", err));
    return () => {
      stopped = true;
      off?.();
    };
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
