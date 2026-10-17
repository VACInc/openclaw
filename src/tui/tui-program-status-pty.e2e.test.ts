import { expect, it } from "vitest";
import { iterateAnsiSegments } from "../../packages/terminal-core/src/ansi-sequences.js";
import { objectFieldEquals, startTuiFixture } from "./tui-pty-harness-fixture-test-support.js";
import { waitFor } from "./tui-pty-test-support.js";

function programStatusSequences(output: string): string[] {
  const sequences: string[] = [];
  for (const segment of iterateAnsiSegments(output)) {
    if (segment.kind === "ansi" && segment.value.startsWith("\x1b]7501;")) {
      const terminatorLength = segment.value.endsWith("\x1b\\") ? 2 : 1;
      sequences.push(segment.value.slice("\x1b]7501;".length, -terminatorLength));
    }
  }
  return sequences;
}

it.for([
  {
    // The fixture PTY cannot answer the support query, so this forces reporting on.
    label: "a terminal with OSC 7501 support",
    programStatus: "1",
    expected: [
      "state=idle:app=openclaw",
      "state=working:app=openclaw",
      "state=done:app=openclaw",
      "state=clear",
    ],
  },
  {
    label: "a terminal that never answers the support query",
    programStatus: undefined,
    expected: ["?"],
  },
])(
  "reports the run lifecycle to $label",
  { timeout: 30_000 },
  async ({ label, programStatus, expected }, { signal }) => {
    const message = "program status probe";
    const fixture = await startTuiFixture({ env: { PI_PROGRAM_STATUS: programStatus } });
    try {
      await fixture.run.waitForOutput("local ready", 20_000);
      await fixture.run.write(`${message}\r`, { delay: false });
      await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", message),
        signal,
      );
      await fixture.run.waitForOutput("PTY_RESPONSE:", 20_000);
      // The run settles back to idle after its final reply renders.
      await waitFor({
        timeoutMs: 20_000,
        read: () => {
          const raw = fixture.run.output();
          return raw.slice(raw.lastIndexOf("PTY_RESPONSE:")).includes("| idle") ? true : null;
        },
        onTimeout: () => new Error("timed out waiting for the run to settle"),
      });
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      const sequences = programStatusSequences(fixture.run.output());
      console.log(
        `[behavior-evidence] ${JSON.stringify({ label, sequences, terminal: "real PTY" })}`,
      );
      expect(sequences).toEqual(expected);
    } finally {
      await fixture.cleanup();
    }
  },
);
