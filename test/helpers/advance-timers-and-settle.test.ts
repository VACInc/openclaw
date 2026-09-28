import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceTimersAndSettle } from "./advance-timers-and-settle.js";
import { createDeferred } from "./promise.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("joins timer-started worker work before advancing across its deadline", async () => {
  const events: string[] = [];
  const worker = createDeferred();
  let work = Promise.resolve();
  setTimeout(() => {
    events.push("retry");
    const deadline = setTimeout(() => events.push("worker timed out"), 5);
    work = worker.promise.then(() => {
      clearTimeout(deadline);
      events.push("worker settled");
    });
  }, 10);

  await advanceTimersAndSettle(20, async () => {
    worker.resolve();
    await work;
  });

  expect(events).toEqual(["retry", "worker settled"]);
  expect(Date.now()).toBe(20);
});

it("leaves later timers pending at the requested clock boundary", async () => {
  const later = vi.fn();
  setTimeout(later, 50);

  await advanceTimersAndSettle(20, async () => {});

  expect(later).not.toHaveBeenCalled();
  expect(Date.now()).toBe(20);
  expect(vi.getTimerCount()).toBe(1);
});

it("removes its boundary timer when owned work fails", async () => {
  setTimeout(() => {}, 5);
  setTimeout(() => {}, 50);
  const failure = new Error("owned work failed");

  await expect(
    advanceTimersAndSettle(20, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(Date.now()).toBe(5);
  expect(vi.getTimerCount()).toBe(1);
});
