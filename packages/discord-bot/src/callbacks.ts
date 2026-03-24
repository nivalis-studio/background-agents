import { Hono } from "hono";
import type { CompletionCallback, Env } from "./types";
import { extractAgentResponse } from "./completion/extractor";
import { buildCompletionMessage } from "./completion/message";
import { createMessage, removeOwnReaction } from "./utils/discord-client";
import { createLogger } from "./logger";

const log = createLogger("callback");
const THINKING_EMOJI = "⏳";

async function verifyCallbackSignature(
  payload: CompletionCallback,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(data));
  const expectedSig = await crypto.subtle.sign("HMAC", key, signatureData);
  const expectedHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === expectedHex;
}

function isValidPayload(payload: unknown): payload is CompletionCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    typeof p.messageId === "string" &&
    typeof p.success === "boolean" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    p.context !== null &&
    typeof p.context === "object" &&
    typeof (p.context as Record<string, unknown>).channelId === "string"
  );
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const payload = await c.req.json();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();

  if (!isValidPayload(payload)) {
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));
  return c.json({ ok: true });
});

async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const { sessionId, context } = payload;

  try {
    const agentResponse = await extractAgentResponse(env, sessionId, payload.messageId, traceId);
    const message = buildCompletionMessage(sessionId, agentResponse, context, env.WEB_APP_URL);
    await createMessage(env.DISCORD_BOT_TOKEN, context.channelId, message);

    if (context.statusMessageId) {
      try {
        await removeOwnReaction(
          env.DISCORD_BOT_TOKEN,
          context.channelId,
          context.statusMessageId,
          THINKING_EMOJI
        );
      } catch (error) {
        log.warn("discord.reaction.remove", {
          trace_id: traceId,
          channel_id: context.channelId,
          message_id: context.statusMessageId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  } catch (error) {
    log.error("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
