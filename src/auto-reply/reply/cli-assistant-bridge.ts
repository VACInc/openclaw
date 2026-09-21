import { createAgentEventBridge, type AgentEventDeliveryStartOrder } from "./agent-event-bridge.js";

export function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<boolean | void>;
  deliverCompleted?: (text: string) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    startOrder: params.startOrder,
    deliver: async (payload: { text: string; completed: boolean }) => {
      if (payload.completed) {
        await params.deliverCompleted?.(payload.text);
      } else {
        await params.deliver?.(payload.text);
      }
    },
    read: (evt) => {
      if (evt.stream !== "assistant") {
        return undefined;
      }
      if (typeof evt.data.completedText === "string") {
        return { text: evt.data.completedText, completed: true };
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return { text, completed: false };
    },
  });
}
