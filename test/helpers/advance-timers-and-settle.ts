import { vi } from "vitest";

export async function advanceTimersAndSettle(
  milliseconds: number,
  settleWork: () => Promise<void>,
): Promise<void> {
  // A large fake-time jump can expire worker deadlines before timer-started
  // roots finish real I/O. Join that work between timer timestamps.
  let elapsed = false;
  const boundary = setTimeout(() => {
    elapsed = true;
  }, milliseconds);
  try {
    for (;;) {
      await vi.advanceTimersToNextTimerAsync();
      await settleWork();
      if (elapsed) {
        break;
      }
    }
  } finally {
    clearTimeout(boundary);
  }
}
