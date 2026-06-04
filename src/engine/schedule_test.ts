import { assertEquals } from "@std/assert";
import { makePollScheduler } from "./schedule.ts";

// Macrotask flush so the scheduler's finally-block re-pump (a microtask chain)
// settles before we assert.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// A run() whose every call hands back a promise the test settles by hand, so
// in-flight vs settled is driven precisely. Tracks concurrency to prove the
// "never two at once" invariant.
function controllableRun() {
  const resolvers: Array<() => void> = [];
  let starts = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const run = () => {
    starts += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) => {
      resolvers.push(() => {
        inFlight -= 1;
        resolve();
      });
    });
  };
  const finishNext = () => {
    const next = resolvers.shift();
    if (!next) throw new Error("no run in flight to finish");
    next();
  };
  return {
    run,
    finishNext,
    starts: () => starts,
    maxInFlight: () => maxInFlight,
  };
}

Deno.test("makePollScheduler runs on the first trigger", async () => {
  const c = controllableRun();
  const s = makePollScheduler(c.run);

  s.trigger();

  assertEquals(c.starts(), 1);
  c.finishNext();
  await flush();
});

Deno.test("makePollScheduler coalesces overlapping triggers into one trailing run", async () => {
  const c = controllableRun();
  const s = makePollScheduler(c.run);

  s.trigger(); // leading starts
  s.trigger(); // queued as the trailing run
  s.trigger(); // coalesced into that same trailing run
  assertEquals(c.starts(), 1);

  c.finishNext(); // leading settles
  await flush(); // trailing drains
  assertEquals(c.starts(), 2); // exactly one trailing, not three

  c.finishNext(); // trailing settles
  await flush();
  assertEquals(c.starts(), 2); // nothing further queued
});

Deno.test("makePollScheduler never runs two cycles concurrently", async () => {
  const c = controllableRun();
  const s = makePollScheduler(c.run);

  s.trigger();
  s.trigger();
  s.trigger();
  c.finishNext();
  await flush();
  c.finishNext();
  await flush();

  assertEquals(c.maxInFlight(), 1);
});

Deno.test("makePollScheduler runs again on a trigger after the queue drains", async () => {
  const c = controllableRun();
  const s = makePollScheduler(c.run);

  s.trigger();
  c.finishNext();
  await flush();
  assertEquals(c.starts(), 1);

  s.trigger(); // idle again → fresh leading run
  assertEquals(c.starts(), 2);
  c.finishNext();
  await flush();
});

Deno.test("makePollScheduler drains the trailing run even if the leading run rejects", async () => {
  let starts = 0;
  const resolvers: Array<(ok: boolean) => void> = [];
  const run = () => {
    starts += 1;
    return new Promise<void>((resolve, reject) => {
      resolvers.push((ok) => (ok ? resolve() : reject(new Error("boom"))));
    });
  };
  const errors: unknown[] = [];
  const s = makePollScheduler(run, (err) => errors.push(err));

  s.trigger(); // leading
  s.trigger(); // trailing queued

  const rejectLeading = resolvers.shift();
  if (rejectLeading) rejectLeading(false);
  await flush(); // trailing must still run despite the rejection
  assertEquals(starts, 2);

  const resolveTrailing = resolvers.shift();
  if (resolveTrailing) resolveTrailing(true);
  await flush();

  assertEquals(errors.length, 1); // reported via injected onError, not swallowed
});
