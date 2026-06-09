import { useEffect } from "react";
import {
  cache,
  getToken,
  now,
  onPollTick,
  readManifest,
  renderMenu,
  saveSnapshot,
  setAlert,
} from "./platform.ts";
import { makeHttpReader } from "./engine/github.ts";
import { makePollScheduler } from "./engine/schedule.ts";
import { runPollCycle } from "./engine/cycle.ts";
import { bootMenu, buildMenuModel } from "./engine/menu.ts";

function App() {
  useEffect(() => {
    // The Poll Cycle, coalesced (ADR-0010): the mount poll below and the Rust
    // poll-tick both drive it, and the interval can tick mid-cycle — the
    // scheduler keeps at most one run in flight plus one trailing. Each run reads
    // the Manifest, derives the Watched Repos, and returns a PollOutcome; the view
    // builds the menu from it (buildMenuModel) and the attention mark, then renders.
    //
    // What was last pushed to the tray, so a cycle re-applies only what changed
    // (see the apply block for why). undefined until the first cycle, so it always
    // renders over the boot frame.
    let lastModelKey: string | undefined;
    let lastAlert: boolean | undefined;
    // Stop touching the tray once this effect is torn down. StrictMode mounts the
    // effect twice in dev (mount, cleanup, remount), so the first scheduler is
    // orphaned — but its in-flight cycle keeps running and would still push a menu,
    // landing on the live effect's open menu and dismissing it. The dedup above is
    // per-effect, so it can't catch the orphan; this flag does. Also covers a real
    // unmount. Set in cleanup below.
    let cancelled = false;
    const scheduler = makePollScheduler(async () => {
      const out = await runPollCycle({
        readManifest,
        getToken,
        makeReader: makeHttpReader,
        cache,
        saveSnapshot,
        now,
      });
      // Torn down while this cycle was in flight (StrictMode remount or unmount):
      // don't push to the tray — a late write dismisses the live effect's open menu.
      if (cancelled) return;
      // Hidden webview: an unhandled rejection would be invisible, and these are
      // the visible #5 signals — the real per-Skill statuses, or the empty / no-
      // token / error outcome — in the webview devtools.
      switch (out.kind) {
        case "ok":
          console.info("skill statuses", out.statuses);
          break;
        case "no-manifest":
          console.info("nothing installed");
          break;
        case "no-token":
          console.warn("no github token — add one to the Keychain");
          break;
        case "no-access":
          console.error("github token unreadable — keychain locked or access denied");
          break;
        case "malformed":
          console.error("manifest malformed");
          break;
      }
      // The view composes presentation from the pure outcome (ADR-0011): the tray
      // menu via buildMenuModel, and the attention mark — on when a poll found any
      // Behind Skill, off on every other outcome (ADR-0013).
      //
      // Apply only what changed. Re-pushing the menu (setMenu) or re-setting the
      // tray icon dismisses an *open* menu on macOS, and cycles run on a cadence the
      // user can't see — notably a burst at launch (the mount poll + the launch tick
      // coalesce into a run plus a trailing run). Re-applying identical presentation
      // there yanks the menu out from under a first click; guarding on change also
      // spares the native edge rebuilding every item each poll. A genuine change
      // still re-renders — rare while the menu happens to be open, and then wanted.
      const model = buildMenuModel(out, { now: now() });
      const modelKey = JSON.stringify(model);
      if (modelKey !== lastModelKey) {
        await renderMenu(model);
        lastModelKey = modelKey;
      }
      // renderMenu's await can span a teardown (StrictMode cleanup / unmount), so
      // re-gate before the second tray write: a late setAlert re-sets the icon and
      // would dismiss the live effect's open menu — the same write the top gate stops.
      if (cancelled) return;
      const alert = out.kind === "ok" && out.behind > 0;
      if (alert !== lastAlert) {
        await setAlert(alert);
        lastAlert = alert;
      }
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
    onPollTick(() => {
      // Visible in the webview devtools — the "frontend receives it" signal (#3).
      console.info("poll-tick received");
      scheduler.trigger();
    })
      .then((fn) => {
        off = fn;
        if (cancelled) fn(); // unmounted before listen resolved
      })
      .catch((err) => console.error("onPollTick listen failed", err));
    return () => {
      cancelled = true;
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
