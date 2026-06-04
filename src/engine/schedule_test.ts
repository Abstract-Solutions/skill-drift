import { makePollScheduler } from "./schedule.ts";

function assertEquals(actual: number[], expected: number[]) {
  if (
    actual.length !== expected.length ||
    actual.some((value, i) => value !== expected[i])
  ) {
    throw new Error(
      `assertEquals failed\nexpected: ${JSON.stringify(expected)}\nactual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

Deno.test("makePollScheduler runs immediately and never overlaps", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const calls: number[] = [];
  const queue = [first, second];
  const scheduler = makePollScheduler(() => {
    calls.push(calls.length + 1);
    return queue.shift()?.promise ?? Promise.resolve();
  });

  scheduler.trigger();
  scheduler.trigger();
  scheduler.trigger();

  assertEquals(calls, [1]);

  first.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(calls, [1, 2]);

  second.resolve();
  await Promise.resolve();

  assertEquals(calls, [1, 2]);
});

Deno.test("makePollScheduler keeps at most one trailing run while in flight", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const third = deferred<void>();
  const calls: number[] = [];
  const queue = [first, second, third];
  const scheduler = makePollScheduler(() => {
    calls.push(calls.length + 1);
    return queue.shift()?.promise ?? Promise.resolve();
  });

  scheduler.trigger(); // first
  scheduler.trigger(); // trailing second
  first.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(calls, [1, 2]);

  scheduler.trigger(); // trailing third
  scheduler.trigger(); // still only one trailing
  scheduler.trigger();
  second.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(calls, [1, 2, 3]);

  third.resolve();
  await Promise.resolve();
  assertEquals(calls, [1, 2, 3]);
});
