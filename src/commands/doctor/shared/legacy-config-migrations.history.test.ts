import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";

describe("shared group history migration", () => {
  it.each([Number.MAX_SAFE_INTEGER, 0, 7, 5000])(
    "normalizes only the schema sentinel: %s",
    (historyLimit) => {
      const raw = { messages: { groupChat: { historyLimit, visibleReplies: "automatic" } } };
      const changes: string[] = [];
      for (const migration of LEGACY_CONFIG_MIGRATIONS_CHANNELS) {
        migration.apply(raw, changes);
      }
      expect(raw.messages.groupChat).toEqual(
        historyLimit === Number.MAX_SAFE_INTEGER
          ? { visibleReplies: "automatic" }
          : { historyLimit, visibleReplies: "automatic" },
      );
      expect(changes).toEqual(
        historyLimit === Number.MAX_SAFE_INTEGER
          ? [
              "Removed unbounded messages.groupChat.historyLimit; JSON integer maximum is not a prompt history window.",
            ]
          : [],
      );
    },
  );
});
