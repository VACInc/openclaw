// Test-only forwarding and push-delivery fixtures share the real approval manager.
import { vi, type TestContext } from "vitest";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestContext } from "./types.js";

export type ApprovalIosPushDelivery = NonNullable<
  GatewayRequestContext["execApprovalIosPushDelivery"]
>;
export type ApprovalWebPushDelivery = NonNullable<GatewayRequestContext["approvalWebPushDelivery"]>;

export function createForwardingExecApprovalFixture(
  testContext: TestContext,
  opts?: {
    webPushDelivery?: ApprovalWebPushDelivery;
    iosPushDelivery?: ApprovalIosPushDelivery;
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
    iosPushDelivery: opts?.iosPushDelivery,
  });
  const respond = vi.fn();
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
    context,
  };
}
