// Coalescing scheduler for the Poll Cycle (ADR-0010). Two triggers drive the
// cycle — the webview-mount poll and the Rust poll-tick (ADR-0005) — and the
// interval can tick mid-cycle. This keeps at most one cycle in flight and
// coalesces at most one trailing run, so a Manifest/HEAD change during a long
// poll is still caught while the launch race (mount + launch tick) collapses to
// one redundant *sequential* poll, never concurrent — which also removes any
// out-of-order snapshot/menu write. Re-entrancy lives here, not in runPollCycle
// (kept a pure (deps) → PollOutcome), and not as booleans in the view.

export interface PollScheduler {
  trigger(): void;
}

export function makePollScheduler(
  run: () => Promise<unknown>,
  // Injected so tests capture failures without mutating global console state.
  onError: (err: unknown) => void = (err) =>
    console.error("poll cycle failed", err),
): PollScheduler {
  let running = false;
  let pending = false;

  const pump = async () => {
    if (running) {
      pending = true; // coalesce: one trailing run regardless of trigger count
      return;
    }
    running = true;
    pending = false;
    try {
      // `await` invokes run() synchronously (so a second trigger sees running),
      // and one try/catch handles both a synchronous throw and a rejection.
      await run();
    } catch (err) {
      // A thrown edge fault is reported, not swallowed; the scheduler keeps the
      // last menu (ADR-0010) and still drains the trailing run below, so one bad
      // poll never wedges the clock.
      onError(err);
    } finally {
      running = false;
      if (pending) void pump(); // drain the coalesced trailing run
    }
  };

  // trigger is fire-and-forget: callers (mount poll, poll-tick listener) signal
  // "go" and don't await. pump() owns its own errors, so the float is safe.
  return {
    trigger() {
      void pump();
    },
  };
}
