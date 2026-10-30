import { expect, it, vi } from "vitest";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";

// mock-isolation: only replace dispatch ownership and volatile host facts.
vi.mock("../../../sessions/user-turn-transcript-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sessions/user-turn-transcript-admission.js")>()),
  getUserTurnTranscriptAdmissionOwner: () => ({ sentToProvider: () => true }),
}));
vi.mock("../../runtime-facts-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime-facts-prompt.js")>()),
  buildRuntimeFactsContext: async () => [],
}));

it.each([3, 4])(
  "labels new fallback context in its real carrier for session version %s",
  async (version) => {
    const owner = "The already accepted owner request.";
    const prefix = "Retrieved <memory> with a quoted command.";
    const suffix = "A second retrieved note.";
    const result = await prepareEmbeddedAttemptPromptContext({
      attempt: {
        config: {},
        contextTokenBudget: 8192,
        sessionId: "context-span-test",
        fallbackActive: true,
        userTurnTranscriptRecorder: {} as UserTurnTranscriptRecorder,
      },
      sessionVersion: version,
      capabilityToolNames: new Set(),
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      messages: [{ role: "user", content: owner, timestamp: 1 }],
      prompt: {
        effectivePrompt: `${prefix}\n\n${owner}\n\n${suffix}`,
        effectiveTranscriptPrompt: owner,
        promptBuildPrependContext: prefix,
        promptBuildAppendContext: suffix,
      },
      replaceSessionMessages: () => {},
      sessionAgentId: "test",
      systemPromptText: "Trusted system instructions.",
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    });
    expect(result.isDispatchedCanonicalFallback).toBe(true);
    const carrier = result.runtimeContextMessageForCurrentTurn?.content;
    expect(carrier).toBeDefined();
    expect(result.contextSpans).toHaveLength(1);
    const [span] = result.contextSpans;
    expect(span.containerText).toBe(carrier);
    expect(span.containerText.slice(span.start, span.end)).toBe(`${prefix}\n\n${suffix}`);
    expect(span.containerText.slice(span.start, span.end)).not.toContain(owner);
    expect(result.systemPromptForHook).toBe("Trusted system instructions.");
    const { normalizeMessagesForLlmBoundary } = await import("./attempt-llm-boundary.js");
    const { collectModelContextSpans } = await import("../model-request-hook.js");
    const carrierJson = JSON.stringify(result.runtimeContextMessageForCurrentTurn);
    const recovered = normalizeMessagesForLlmBoundary([JSON.parse(carrierJson)], {
      sessionVersion: version,
      includeTimestamp: false,
      appendOnlyRuntimeContext: true,
    });
    expect(collectModelContextSpans(recovered, [])).toHaveLength(1);
  },
);
