import { useEffect } from "react";
import { runPollCycle } from "./engine/cycle.ts";
import { makePollScheduler } from "./engine/schedule.ts";
import { onPollTick, renderMenu, setBadge } from "./platform.ts";

function App() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unmounted = false;
    const scheduler = makePollScheduler(async () => {
      const outcome = await runPollCycle();
      await renderMenu(outcome.menu);
      await setBadge(outcome.behind);
    });

    onPollTick(() => {
      console.info("poll-tick received");
      scheduler.trigger();
    })
      .then((stop) => {
        if (unmounted) {
          stop();
          return;
        }
        unlisten = stop;
      })
      .catch((err) => {
        console.error("onPollTick failed", err);
      });

    scheduler.trigger(); // mount poll, coalesced with launch tick if both happen

    return () => {
      unmounted = true;
      unlisten?.();
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
