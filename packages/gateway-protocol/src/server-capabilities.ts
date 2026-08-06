/** Additive server behaviors advertised in the Gateway hello frame. */
export const GATEWAY_SERVER_CAPS = {
  BOARD_WIDGET_PUT_CANVAS_DOC: "board-widget-put-canvas-doc",
  CHAT_SEND_ROUTING_CONTRACT: "chat-send-routing-contract",
  HEALTH_BOUNDED_CHANNEL_HOOKS: "health-bounded-channel-hooks",
  SYSTEM_AGENT_WIZARD_CANCEL: "openclaw-chat-wizard-cancel",
  SYSTEM_AGENT_SETUP_MODEL_REF: "openclaw-setup-model-ref",
  TASK_SUGGESTIONS_ACCEPT_MODES: "taskSuggestions.acceptModes",
} as const;

export type GatewayServerCapability =
  (typeof GATEWAY_SERVER_CAPS)[keyof typeof GATEWAY_SERVER_CAPS];
