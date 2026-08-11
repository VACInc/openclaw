import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";

/** Lets capable Gateways own variable-duration live health while bounding rolling upgrades. */
export function resolveLiveHealthGatewayCallOptions(timeoutMs: number | undefined) {
  if (timeoutMs !== undefined) {
    return { timeoutMs };
  }
  return {
    timeoutMs: null,
    unboundedRequestCapability: GATEWAY_SERVER_CAPS.HEALTH_BOUNDED_CHANNEL_HOOKS,
  } as const;
}
