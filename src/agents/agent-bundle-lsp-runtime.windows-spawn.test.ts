import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as hostEnv from "../infra/host-env-security.js";
import * as windowsSpawn from "../plugin-sdk/windows-spawn.js";
import type { WindowsSpawnProgram } from "../plugin-sdk/windows-spawn.js";
import * as ownedStdio from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";

const realSanitize = hostEnv.sanitizeHostExecEnv;
const resolve = vi.fn<typeof windowsSpawn.resolveWindowsSpawnProgram>();
const sanitize = vi.fn<typeof hostEnv.sanitizeHostExecEnv>();
const spawn = vi.fn<typeof ownedStdio.createOwnedStdioProcess>();
const { spawnAndWait } = vi.hoisted(() => ({ spawnAndWait: vi.fn() }));
vi.mock("../process/spawn-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/spawn-utils.js")>()),
  spawnAndWait,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostEnv, "sanitizeHostExecEnv").mockImplementation(sanitize);
  spawn.mockRejectedValue(new Error("stop after spawn"));
  spawnAndWait.mockRejectedValue(new Error("captured Windows spawn"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function program(shell: boolean): WindowsSpawnProgram {
  return {
    command: shell ? "cmd.exe" : "typescript-language-server",
    leadingArgv: shell ? ["/c", "typescript-language-server.cmd"] : [],
    resolution: shell ? "shell-fallback" : "direct",
    shell,
    windowsHide: true,
  };
}
const overrides = { MY_TOKEN: "secret", TOOL_PATH: "/custom" };
it.each([
  { shell: false, env: overrides, argv: ["typescript-language-server", "--stdio"] },
  {
    shell: true,
    env: undefined,
    argv: ["cmd.exe", "/c", "typescript-language-server.cmd", "--stdio"],
  },
])(
  "sanitizes and forwards the materialized LSP invocation (shell=$shell)",
  async ({ shell, env, argv }) => {
    vi.spyOn(windowsSpawn, "resolveWindowsSpawnProgram").mockImplementation(resolve);
    vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawn);
    const sanitized = { PATH: "/usr/bin", ...env };
    sanitize.mockReturnValue(sanitized);
    resolve.mockReturnValue(program(shell));
    const abortSignal = new AbortController().signal;
    await expect(
      spawnLspServerProcess(
        { command: "typescript-language-server", args: ["--stdio"], ...(env ? { env } : {}) },
        { abortSignal },
      ),
    ).rejects.toThrow("stop after spawn");

    const sanitation = sanitize.mock.calls[0]?.[0];
    expect(sanitation?.baseEnv).not.toBe(process.env);
    expect(sanitation?.baseEnv).toMatchObject(getDefaultEnvironment());
    if (env) {
      expect(sanitation?.overrides).toStrictEqual(env);
    }
    expect(resolve.mock.calls[0]?.[0]?.env).toBe(sanitized);
    expect(resolve.mock.calls[0]?.[0]?.allowShellFallback).toBe(true);
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      argv,
      env: sanitized,
      exactEnv: true,
      cwd: undefined,
      abortSignal,
      ...(shell ? { windowsShell: true } : {}),
    });
  },
);

it("preserves Windows shell arguments through the real owned adapter", async () => {
  const env = { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" };
  const command = "C:\\Program Files\\language-server.cmd";
  const args = ["--stdio", "two words", "%LSP_ARGUMENT%", "echo ready & exit /b"];
  sanitize.mockReturnValue(env);
  await expect(
    withMockedWindowsPlatform(() => spawnLspServerProcess({ command, args })),
  ).rejects.toThrow("captured Windows spawn");
  expect(spawnAndWait).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      argv: [command, ...args],
      options: expect.objectContaining({ env, shell: true, windowsHide: true }),
    }),
  );
});

async function capturedChildEnv(env?: Record<string, string>) {
  sanitize.mockImplementation(realSanitize);
  vi.spyOn(ownedStdio, "createOwnedStdioProcess").mockImplementation(spawn);
  await expect(
    spawnLspServerProcess({
      command: "typescript-language-server",
      args: ["--stdio"],
      ...(env ? { env } : {}),
    }),
  ).rejects.toThrow("stop after spawn");
  return spawn.mock.calls[0]?.[0]?.env ?? {};
}

describe.skipIf(process.platform === "win32")("bundle LSP child environment", () => {
  it("withholds Gateway secrets while keeping process essentials", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token-canary");
    vi.stubEnv("OPENAI_API_KEY", "provider-key-canary");
    vi.stubEnv("OP_CONNECT_TOKEN", "secret-manager-canary");
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
    vi.stubEnv("HOME", "/home/lsp-user");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("RUSTUP_HOME", "/opt/rustup");

    const env = await capturedChildEnv();

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OP_CONNECT_TOKEN");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.HOME).toBe("/home/lsp-user");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.RUSTUP_HOME).toBe("/opt/rustup");
  });

  it("still applies the server's configured env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-key-canary");

    const env = await capturedChildEnv({
      LSP_LOG_LEVEL: "verbose",
      OPENAI_API_KEY: "server-owned",
    });

    expect(env.LSP_LOG_LEVEL).toBe("verbose");
    expect(env.OPENAI_API_KEY).toBe("server-owned");
  });
});
