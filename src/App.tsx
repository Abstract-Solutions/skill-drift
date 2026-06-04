import { useEffect } from "react";
import { onPollTick, readManifest, renderMenu, setBadge } from "./platform.ts";
import { makePollScheduler } from "./engine/schedule.ts";
import { runPollCycle } from "./engine/cycle.ts";
import { bootMenu } from "./engine/menu.ts";

function App() {
  useEffect(() => {
    // The Poll Cycle, coalesced (ADR-0010): the mount poll below and the Rust
    // poll-tick both drive it, and the interval can tick mid-cycle — the
    // scheduler keeps at most one run in flight plus one trailing. Each run reads
    // the Manifest, derives the Watched Repos, and returns a PollOutcome the view
    // renders (menu + badge); the cycle's menu replaces the old mount placeholder.
    const scheduler = makePollScheduler(async () => {
      const out = await runPollCycle({ readManifest });
      // Hidden webview: an unhandled rejection would be invisible, and these are
      // the visible #4 signals — the derived Watched Repos, or the empty/error
      // outcome — in the webview devtools.
      switch (out.kind) {
        case "ok":
          console.info("watched repos", out.repos);
          break;
        case "no-manifest":
          console.info("nothing installed");
          break;
        case "malformed":
          console.error("manifest malformed");
          break;
      }
      await renderMenu(out.menu);
      // Only an `ok` poll has a Behind count; the other outcomes clear the badge.
      await setBadge(out.kind === "ok" ? out.behind : 0);
    });

    // A menu-bar-only app (Accessory, ADR-0009) is quittable only via the tray
    // menu, and Rust builds the tray without one. Seed a boot frame so a Quit item
    // exists even if the first cycle's edge faults before it renders; the cycle
    // replaces it, and on a fault the scheduler keeps it as the last menu (ADR-0010).
    renderMenu(bootMenu()).catch((err) => {
      console.error("boot renderMenu failed", err);
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
