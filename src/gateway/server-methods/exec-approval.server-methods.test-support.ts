import { vi, type TestContext } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

export function createExecApprovalFixture(
  testContext: TestContext,
  opts?: { config?: OpenClawConfig },
) {
  const manager = createTestApprovalManager(testContext);
  const handlers = createExecApprovalHandlers(manager);
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const responseSent = createDeferredCore();
  const respond = vi.fn().mockImplementation(() => responseSent.resolve());
  const context = {
    getRuntimeConfig: () => opts?.config ?? {},
    broadcast: (event: string, payload: unknown) => {
      broadcasts.push({ event, payload });
    },
    hasExecApprovalClients: () => true,
    chatRunState: createChatRunState(),
  };
  return { manager, handlers, broadcasts, respond, responseSent: responseSent.promise, context };
}

export function createForwardingExecApprovalFixture(
  testContext: TestContext,
  opts?: {
    webPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
    iosPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
  },
) {
  const manager = createTestApprovalManager(testContext);
  const forwarder = {
    handleRequested: vi.fn(async () => false),
    handleResolved: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const handlers = createExecApprovalHandlers(manager, {
    forwarder,
    iosPushDelivery: opts?.iosPushDelivery as never,
  });
  const responseSent = createDeferredCore();
  const respond = vi.fn().mockImplementation(() => responseSent.resolve());
  const context = {
    getRuntimeConfig: () => ({}),
    broadcast: (_eventValue: string, _payload: unknown) => {},
    hasExecApprovalClients: () => false,
    approvalWebPushDelivery: opts?.webPushDelivery,
  };
  return {
    manager,
    handlers,
    forwarder,
    webPushDelivery: opts?.webPushDelivery,
    iosPushDelivery: opts?.iosPushDelivery,
    respond,
    responseSent: responseSent.promise,
    context,
  };
}
