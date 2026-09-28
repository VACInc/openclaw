import fs from "node:fs/promises";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginRegistryOwner,
  createTestRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
  setPluginRuntimeLoadContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";

const finalText = "Saved final answer after an unrelated reload.";
const replacementToken = "654321:reload-test-replacement";

describe("Telegram final sender after registry replacement", () => {
  const http = createTelegramDispatchHttpFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["unchanged", "environment", "token-file", "secret-ref"] as const)(
    "keeps the admitted bot when credentials are %s",
    async (source) => {
      const old = getActivePluginRegistry();
      if (!old) {
        throw new Error("Expected the fixture's Telegram registry");
      }
      const owner = createPluginRegistryOwner(old);
      const next = createTestRegistry([...old.channels]);
      const tokenFile = http.state.path("telegram-token");
      if (source === "token-file") {
        await fs.writeFile(tokenFile, http.token, { mode: 0o600 });
      }
      vi.stubEnv("TELEGRAM_BOT_TOKEN", http.token);
      vi.stubEnv("TELEGRAM_TEST_RELOAD_TOKEN", http.token);
      try {
        await withPluginRuntimeRegistryScope(old, () =>
          http.dispatchProgressTurn(
            async () => {
              if (source === "environment") {
                vi.stubEnv("TELEGRAM_BOT_TOKEN", replacementToken);
              } else if (source === "token-file") {
                await fs.writeFile(tokenFile, replacementToken, { mode: 0o600 });
              } else if (source === "secret-ref") {
                vi.stubEnv("TELEGRAM_TEST_RELOAD_TOKEN", replacementToken);
              }
              setActivePluginRegistry(next);
              owner.publish(next);
              // Another Gateway's process projection is never our delivery owner.
              setActivePluginRegistry(createTestRegistry([]));
            },
            {
              mode: "off",
              toolProgress: false,
              finalReply: { text: finalText },
              allowErrors: source !== "unchanged",
              telegramCfg:
                source === "token-file"
                  ? { botToken: undefined, tokenFile }
                  : source === "environment"
                    ? { botToken: undefined }
                    : source === "secret-ref"
                      ? {
                          botToken: {
                            source: "env",
                            provider: "reload",
                            id: "TELEGRAM_TEST_RELOAD_TOKEN",
                          },
                        }
                      : {},
              cfg: {
                secrets: {
                  providers: {
                    reload: { source: "env", allowlist: ["TELEGRAM_TEST_RELOAD_TOKEN"] },
                  },
                },
              },
              onDispatch(cfg) {
                for (const registry of [old, next]) {
                  setPluginRuntimeLoadContext(registry, {
                    rawConfig: cfg,
                    config: cfg,
                    activationSourceConfig: cfg,
                    autoEnabledReasons: {},
                    workspaceDir: undefined,
                    env: {},
                    logger: { info() {}, warn() {}, error() {}, debug() {} },
                  });
                }
              },
            },
          ),
        );
        const finals = http.calls.filter(
          (call) => call.method === "sendMessage" && call.fields.text === finalText,
        );
        if (source === "unchanged") {
          expect(finals).toHaveLength(1);
          expect(http.endpoints[http.calls.findIndex((call) => call === finals[0])]).toBe(
            "/bot" + http.token + "/sendMessage",
          );
          expect([...http.visibleMessages.values()]).toContain(finalText);
        } else {
          expect(finals).toEqual([]);
          expect([...http.visibleMessages.values()]).not.toContain(finalText);
        }
        expect(http.endpoints.some((endpoint) => endpoint.includes(replacementToken))).toBe(false);
      } finally {
        await owner.close();
      }
    },
  );
});
