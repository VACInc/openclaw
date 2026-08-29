import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  enqueueCommandInLane,
  GatewayDrainingError,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const systemAgentGatewayExecutionQueue = new KeyedAsyncQueue();

type SystemAgentGatewayTaskState = {
  acceptedCount: number;
  idleWaiters: Set<() => void>;
  sealed: boolean;
};

const systemAgentGatewayTaskStates = new WeakMap<object, SystemAgentGatewayTaskState>();

function getSystemAgentGatewayTaskState(owner: object): SystemAgentGatewayTaskState {
  let state = systemAgentGatewayTaskStates.get(owner);
  if (!state) {
    state = {
      acceptedCount: 0,
      idleWaiters: new Set(),
      sealed: false,
    };
    systemAgentGatewayTaskStates.set(owner, state);
  }
  return state;
}

function assertSystemAgentGatewayTaskAdmissionOpen(state: SystemAgentGatewayTaskState): void {
  if (state.sealed) {
    throw new GatewayDrainingError();
  }
}

function settleAcceptedSystemAgentGatewayTask(state: SystemAgentGatewayTaskState): void {
  state.acceptedCount -= 1;
  if (state.acceptedCount !== 0) {
    return;
  }
  for (const resolve of state.idleWaiters) {
    resolve();
  }
  state.idleWaiters.clear();
}

/** Reject queued work once shutdown has sealed this Gateway generation. */
export function assertSystemAgentTaskOpen(owner: object): void {
  assertSystemAgentGatewayTaskAdmissionOpen(getSystemAgentGatewayTaskState(owner));
}

/** Serialize one accepted Gateway system-agent task and retain it in the shutdown drain. */
export async function runSystemAgentTask<T>(owner: object, task: () => Promise<T>): Promise<T> {
  const state = getSystemAgentGatewayTaskState(owner);
  assertSystemAgentGatewayTaskAdmissionOpen(state);
  state.acceptedCount += 1;
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  try {
    return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
      systemAgentGatewayExecutionQueue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, async () => {
        assertSystemAgentGatewayTaskAdmissionOpen(state);
        return await task();
      }),
    );
  } finally {
    settleAcceptedSystemAgentGatewayTask(state);
  }
}

/** Seal this Gateway generation and wait for every already accepted task to settle. */
export function beginGatewaySystemAgentTaskShutdown(owner: object): Promise<void> {
  const state = getSystemAgentGatewayTaskState(owner);
  state.sealed = true;
  if (state.acceptedCount === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.idleWaiters.add(resolve);
  });
}
