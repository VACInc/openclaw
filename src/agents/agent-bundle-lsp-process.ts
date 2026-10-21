/** Spawns bundled LSP server processes with sanitized environment and platform handling. */
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess, type OwnedStdioProcess } from "../process/owned-stdio.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

// Locale, temp, XDG, and toolchain locations language servers read. None is a
// credential. Bundle authors, not operators, write a server's `env`, and the exec
// override policy refuses the XDG and rustup names there, so keep them inherited.
const LSP_INHERITED_ENV_KEYS = new Set([
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "GOROOT",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "JAVA_HOME",
]);

/** Bundle LSP base env: the MCP stdio defaults plus toolchain locations, never Gateway secrets. */
function resolveLspBaseEnv(): Record<string, string> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [key, value] of Object.entries(process.env)) {
    // Windows names are case-insensitive; keep the spelling the host used.
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (value !== undefined && (name.startsWith("LC_") || LSP_INHERITED_ENV_KEYS.has(name))) {
      env[key] = value;
    }
  }
  return env;
}

export async function spawnLspServerProcess(
  config: StdioMcpServerLaunchConfig,
  options: { abortSignal?: AbortSignal } = {},
): Promise<OwnedStdioProcess> {
  const mergedEnv = sanitizeHostExecEnv({
    baseEnv: resolveLspBaseEnv(),
    overrides: config.env ?? null,
  });
  const program = resolveWindowsSpawnProgram({
    command: config.command,
    env: mergedEnv,
    allowShellFallback: true,
  });
  const invocation = materializeWindowsSpawnProgram(program, config.args ?? []);
  return await createOwnedStdioProcess({
    argv: [invocation.command, ...invocation.argv],
    env: mergedEnv,
    exactEnv: true,
    cwd: config.cwd,
    abortSignal: options.abortSignal,
    // Stable LSP config permits unresolved Windows wrappers to use Node's shell parsing.
    ...(invocation.shell === true ? { windowsShell: true } : {}),
  });
}
