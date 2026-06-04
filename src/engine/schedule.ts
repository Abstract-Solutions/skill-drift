export interface PollScheduler {
  trigger(): void;
}

export function makePollScheduler(
  run: () => Promise<unknown>,
): PollScheduler {
  let inFlight = false;
  let queued = false;

  const runNext = () => {
    if (inFlight) return;

    inFlight = true;
    void Promise.resolve()
      .then(run)
      .catch(() => {
        // run handles user-visible error reporting; scheduler keeps flowing
      })
      .finally(() => {
        inFlight = false;
        if (!queued) return;
        queued = false;
        runNext();
      });
  };

  return {
    trigger() {
      if (inFlight) {
        queued = true;
        return;
      }
      runNext();
    },
  };
}
