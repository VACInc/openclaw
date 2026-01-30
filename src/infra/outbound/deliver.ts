import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveChannelMediaMaxBytes } from "../../channels/plugins/media-limits.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import {
  buildInternalHookContext,
  summarizeMediaUrls,
  summarizeText,
} from "../../hooks/hook-context.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import { markdownToSignalTextChunks, type SignalTextStyleRange } from "../../signal/format.js";
import { sendMessageSignal } from "../../signal/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "../../config/sessions.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import type { OutboundChannel } from "./targets.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

type SendMatrixMessage = (
  to: string,
  text: string,
  opts?: { mediaUrl?: string; replyToId?: string; threadId?: string; timeoutMs?: number },
) => Promise<{ messageId: string; roomId: string }>;

export type OutboundSendDeps = {
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  sendDiscord?: typeof sendMessageDiscord;
  sendSlack?: typeof sendMessageSlack;
  sendSignal?: typeof sendMessageSignal;
  sendIMessage?: typeof sendMessageIMessage;
  sendMatrix?: SendMatrixMessage;
  sendMSTeams?: (
    to: string,
    text: string,
    opts?: { mediaUrl?: string },
  ) => Promise<{ messageId: string; conversationId: string }>;
};

export type OutboundDeliveryResult = {
  channel: Exclude<OutboundChannel, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};

type Chunker = (text: string, limit: number) => string[];

type ChannelHandler = {
  chunker: Chunker | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  sendPayload?: (payload: ReplyPayload) => Promise<OutboundDeliveryResult>;
  sendText: (text: string) => Promise<OutboundDeliveryResult>;
  sendMedia: (caption: string, mediaUrl: string) => Promise<OutboundDeliveryResult>;
};

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error("Outbound delivery aborted");
  }
}

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: {
  cfg: MoltbotConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
}): Promise<ChannelHandler> {
  const outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound?.sendText || !outbound?.sendMedia) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  const handler = createPluginHandler({
    outbound,
    cfg: params.cfg,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    deps: params.deps,
    gifPlayback: params.gifPlayback,
  });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(params: {
  outbound?: ChannelOutboundAdapter;
  cfg: MoltbotConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
}): ChannelHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText || !outbound?.sendMedia) return null;
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  const chunkerMode = outbound.chunkerMode;
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound.textChunkLimit,
    sendPayload: outbound.sendPayload
      ? async (payload) =>
          outbound.sendPayload!({
            cfg: params.cfg,
            to: params.to,
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            accountId: params.accountId,
            replyToId: params.replyToId,
            threadId: params.threadId,
            gifPlayback: params.gifPlayback,
            deps: params.deps,
            payload,
          })
      : undefined,
    sendText: async (text) =>
      sendText({
        cfg: params.cfg,
        to: params.to,
        text,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
      }),
    sendMedia: async (caption, mediaUrl) =>
      sendMedia({
        cfg: params.cfg,
        to: params.to,
        text: caption,
        mediaUrl,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        deps: params.deps,
      }),
  };
}

export async function deliverOutboundPayloads(params: {
  cfg: MoltbotConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
}): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
  const results: OutboundDeliveryResult[] = [];
  const hookSessionKey = params.sessionKey ?? params.mirror?.sessionKey ?? "";
  const includeSensitiveHookContext = Boolean(cfg.hooks?.internal?.includeSensitiveHookContext);
  const buildPayloadContext = (payload: NormalizedOutboundPayload, includeSensitive: boolean) =>
    buildInternalHookContext(includeSensitive, payload, {
      ...summarizeText(payload.text),
      ...summarizeMediaUrls(payload.mediaUrls),
      hasChannelData: Boolean(payload.channelData),
    });
  const buildResultContext = (result: OutboundDeliveryResult, includeSensitive: boolean) =>
    buildInternalHookContext(includeSensitive, result, {
      channel: result.channel,
      timestamp: result.timestamp,
    });
  const buildDetailContext = (
    details: { text?: string; mediaUrl?: string } | undefined,
    includeSensitive: boolean,
  ) => {
    const detailText = details?.text;
    const detailMediaUrl = details?.mediaUrl;
    return buildInternalHookContext(
      includeSensitive,
      detailText || detailMediaUrl ? { text: detailText, mediaUrl: detailMediaUrl } : {},
      {
        ...summarizeText(detailText),
        ...summarizeMediaUrls(detailMediaUrl ? [detailMediaUrl] : []),
      },
    );
  };
  const emitMessageSent = async (
    payload: NormalizedOutboundPayload,
    result: OutboundDeliveryResult,
    details?: { text?: string; mediaUrl?: string },
  ) => {
    const hookEvent = createInternalHookEvent("message", "sent", hookSessionKey, {
      ...buildInternalHookContext(
        includeSensitiveHookContext,
        {
          channel,
          to,
          accountId,
          replyToId: params.replyToId ?? null,
          threadId: params.threadId ?? null,
          payload: buildPayloadContext(payload, true),
          ...buildDetailContext(details, true),
          result: buildResultContext(result, true),
        },
        {
          channel,
          payload: buildPayloadContext(payload, false),
          ...buildDetailContext(details, false),
          result: buildResultContext(result, false),
        },
      ),
    });
    void triggerInternalHook(hookEvent);
  };
  const pushResult = async (
    payload: NormalizedOutboundPayload,
    result: OutboundDeliveryResult,
    details?: { text?: string; mediaUrl?: string },
  ) => {
    results.push(result);
    await emitMessageSent(payload, result, details);
  };
  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
  });
  const textLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
  const isSignalChannel = channel === "signal";
  const signalTableMode = isSignalChannel
    ? resolveMarkdownTableMode({ cfg, channel: "signal", accountId })
    : "code";
  const signalMaxBytes = isSignalChannel
    ? resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      })
    : undefined;

  const sendTextChunks = async (text: string, payload: NormalizedOutboundPayload) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      await pushResult(payload, await handler.sendText(text), { text });
      return;
    }
    if (chunkMode === "newline") {
      const mode = handler.chunkerMode ?? "text";
      const blockChunks =
        mode === "markdown"
          ? chunkMarkdownTextWithMode(text, textLimit, "newline")
          : chunkByParagraph(text, textLimit);

      if (!blockChunks.length && text) blockChunks.push(text);
      for (const blockChunk of blockChunks) {
        const chunks = handler.chunker(blockChunk, textLimit);
        if (!chunks.length && blockChunk) chunks.push(blockChunk);
        for (const chunk of chunks) {
          throwIfAborted(abortSignal);
          await pushResult(payload, await handler.sendText(chunk), { text: chunk });
        }
      }
      return;
    }
    const chunks = handler.chunker(text, textLimit);
    for (const chunk of chunks) {
      throwIfAborted(abortSignal);
      await pushResult(payload, await handler.sendText(chunk), { text: chunk });
    }
  };

  const sendSignalText = async (
    text: string,
    styles: SignalTextStyleRange[],
    payload: NormalizedOutboundPayload,
  ) => {
    throwIfAborted(abortSignal);
    const result = {
      channel: "signal" as const,
      ...(await sendSignal(to, text, {
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: styles,
      })),
    };
    await pushResult(payload, result, { text });
    return result;
  };

  const sendSignalTextChunks = async (text: string, payload: NormalizedOutboundPayload) => {
    throwIfAborted(abortSignal);
    let signalChunks =
      textLimit === undefined
        ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
            tableMode: signalTableMode,
          })
        : markdownToSignalTextChunks(text, textLimit, { tableMode: signalTableMode });
    if (signalChunks.length === 0 && text) {
      signalChunks = [{ text, styles: [] }];
    }
    for (const chunk of signalChunks) {
      throwIfAborted(abortSignal);
      await sendSignalText(chunk.text, chunk.styles, payload);
    }
  };

  const sendSignalMedia = async (
    caption: string,
    mediaUrl: string,
    payload: NormalizedOutboundPayload,
  ) => {
    throwIfAborted(abortSignal);
    const formatted = markdownToSignalTextChunks(caption, Number.POSITIVE_INFINITY, {
      tableMode: signalTableMode,
    })[0] ?? {
      text: caption,
      styles: [],
    };
    const result = {
      channel: "signal" as const,
      ...(await sendSignal(to, formatted.text, {
        mediaUrl,
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: formatted.styles,
      })),
    };
    await pushResult(payload, result, { text: caption, mediaUrl });
    return result;
  };
  const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads);
  for (const payload of normalizedPayloads) {
    const payloadSummary: NormalizedOutboundPayload = {
      text: payload.text ?? "",
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
      channelData: payload.channelData,
    };
    try {
      throwIfAborted(abortSignal);
      params.onPayload?.(payloadSummary);
      if (handler.sendPayload && payload.channelData) {
        await pushResult(payloadSummary, await handler.sendPayload(payload), {
          text: payloadSummary.text,
          mediaUrl: payloadSummary.mediaUrls?.[0],
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        if (isSignalChannel) {
          await sendSignalTextChunks(payloadSummary.text, payloadSummary);
        } else {
          await sendTextChunks(payloadSummary.text, payloadSummary);
        }
        continue;
      }

      let first = true;
      for (const url of payloadSummary.mediaUrls) {
        throwIfAborted(abortSignal);
        const caption = first ? payloadSummary.text : "";
        first = false;
        if (isSignalChannel) {
          await sendSignalMedia(caption, url, payloadSummary);
        } else {
          await pushResult(payloadSummary, await handler.sendMedia(caption, url), {
            text: caption,
            mediaUrl: url,
          });
        }
      }
    } catch (err) {
      if (!params.bestEffort) throw err;
      params.onError?.(err, payloadSummary);
    }
  }
  if (params.mirror && results.length > 0) {
    const mirrorText = resolveMirroredTranscriptText({
      text: params.mirror.text,
      mediaUrls: params.mirror.mediaUrls,
    });
    if (mirrorText) {
      await appendAssistantMessageToSessionTranscript({
        agentId: params.mirror.agentId,
        sessionKey: params.mirror.sessionKey,
        text: mirrorText,
      });
    }
  }
  return results;
}
