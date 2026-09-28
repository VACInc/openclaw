import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { bindPluginRegistryGatewayOwner } from "../../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ChannelMessageSendTextContext } from "../message/types.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  deliverStructuredInboundReplyWithMessageSendContextCore,
  type DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";

const cfg: OpenClawConfig = { channels: { telegram: { enabled: true } } };

async function replacementFixture() {
  const retired = new PluginInstance("discord");
  const old = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: retired.wrap({
        ...createChannelTestPluginBase({ id: "discord" }),
        get id() {
          return "discord";
        },
      }),
    },
  ]);
  const sendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) => ({
    messageId: "accepted-final",
  }));
  const beforeSendAttempt = vi.fn(async () => {});
  const current = createTestRegistry([
    {
      pluginId: "telegram",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "telegram" }),
        message: {
          id: "telegram",
          durableFinal: { capabilities: { text: true, messageSendingHooks: true } },
          send: { text: sendText, lifecycle: { beforeSendAttempt } },
        },
      },
    },
  ]);
  const setConfig = (config: OpenClawConfig) =>
    setPluginRuntimeLoadContext(current, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: undefined,
      env: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
  setConfig(cfg);
  const publication: { current: typeof current | undefined } = { current };
  const owner = { current: () => publication.current };
  bindPluginRegistryGatewayOwner(old, owner);
  bindPluginRegistryGatewayOwner(current, owner);
  // A different process-root Gateway must never become the delivery owner.
  setActivePluginRegistry(createTestRegistry([]));
  await retired.dispose();
  const request: DurableInboundReplyDeliveryParams = {
    cfg,
    channel: "telegram",
    accountId: "default",
    agentId: "main",
    payload: { text: "Saved final answer" },
    info: { kind: "final" },
    ctxPayload: {
      CommandAuthorized: true,
      CommandTurn: { kind: "normal", source: "message", authorized: false },
      OriginatingTo: "12345",
    },
  };
  const deliver = (structured = false, scope = old) =>
    withPluginRuntimeRegistryScope(scope, () => {
      if (!structured) {
        return deliverInboundReplyWithMessageSendContextCore(request);
      }
      const [plan] = createStructuredOutboundPayloadPlan([request.payload]);
      if (!plan) {
        throw new Error("Expected a sendable final reply");
      }
      return deliverStructuredInboundReplyWithMessageSendContextCore({ ...request, plan });
    });
  return { old, current, publication, setConfig, sendText, beforeSendAttempt, deliver };
}

describe("final delivery after plugin replacement", () => {
  const state = installDeliveryQueueTmpDirHooks();
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "sends once through its own Gateway (structured=%s)",
    async (structured) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
      const fixture = await replacementFixture();
      const result = await fixture.deliver(structured);
      if (result.status === "failed") {
        throw result.error;
      }
      expect(result).toMatchObject({
        status: "handled_visible",
        delivery: { visibleReplySent: true, messageIds: ["accepted-final"] },
      });
      expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ to: "12345", text: "Saved final answer", accountId: "default" }),
      );
    },
  );

  it.each([
    "closed",
    "removed",
    "account-changed",
    "plugin-changed",
    "superseded-before-send",
    "superseded-live-send",
  ] as const)("does not send or borrow the process root when %s", async (stateChange) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    const fixture = await replacementFixture();
    setActivePluginRegistry(createTestRegistry([...fixture.current.channels]));
    if (stateChange === "closed") {
      fixture.publication.current = undefined;
    }
    if (stateChange === "removed") {
      fixture.current.channels = [];
    }
    if (stateChange === "account-changed") {
      fixture.setConfig({ channels: { telegram: { enabled: false } } });
    }
    if (stateChange === "plugin-changed") {
      fixture.setConfig({ ...cfg, plugins: { entries: { telegram: { enabled: false } } } });
    }
    if (stateChange.startsWith("superseded")) {
      fixture.beforeSendAttempt.mockImplementation(async () => {
        fixture.publication.current = undefined;
      });
    }
    const result = await fixture.deliver(
      false,
      stateChange === "superseded-live-send" ? fixture.current : fixture.old,
    );
    expect(result).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining(
          stateChange === "closed"
            ? "closing"
            : stateChange.startsWith("superseded")
              ? "runtime changed"
              : "channel changed",
        ),
      },
    });
    expect(fixture.sendText).not.toHaveBeenCalled();
  });
});
