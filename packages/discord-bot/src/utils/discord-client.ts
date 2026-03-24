import type { DiscordChannelInfo, DiscordMessage } from "../types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const normalized = hex.trim();
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }

  const bytes = new Uint8Array(new ArrayBuffer(normalized.length / 2));
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

async function discordApiRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function verifyDiscordSignature(
  signature: string | null,
  timestamp: string | null,
  body: string,
  publicKey: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), "Ed25519", false, [
    "verify",
  ]);

  return crypto.subtle.verify(
    "Ed25519",
    key,
    hexToBytes(signature),
    new TextEncoder().encode(`${timestamp}${body}`)
  );
}

export function isThreadChannel(channel?: DiscordChannelInfo | null): boolean {
  return channel?.type != null && THREAD_CHANNEL_TYPES.has(channel.type);
}

export async function getChannelInfo(
  token: string,
  channelId: string
): Promise<DiscordChannelInfo | null> {
  try {
    return await discordApiRequest<DiscordChannelInfo>(token, `/channels/${channelId}`, {
      method: "GET",
    });
  } catch {
    return null;
  }
}

export async function getChannelMessages(
  token: string,
  channelId: string,
  limit = 10
): Promise<DiscordMessage[]> {
  try {
    return await discordApiRequest<DiscordMessage[]>(
      token,
      `/channels/${channelId}/messages?limit=${limit}`,
      {
        method: "GET",
      }
    );
  } catch {
    return [];
  }
}

export async function createMessage(
  token: string,
  channelId: string,
  payload: Record<string, unknown>
): Promise<{ id: string; channel_id: string }> {
  return discordApiRequest(token, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
  });
}

export async function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await discordApiRequest(token, `/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
  });
}

export async function createThreadFromMessage(
  token: string,
  channelId: string,
  messageId: string,
  name: string
): Promise<DiscordChannelInfo> {
  return discordApiRequest(token, `/channels/${channelId}/messages/${messageId}/threads`, {
    method: "POST",
    body: JSON.stringify({
      name: name.slice(0, 100),
      auto_archive_duration: 1440,
    }),
  });
}

export async function addReaction(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await discordApiRequest(
    token,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    {
      method: "PUT",
    }
  );
}

export async function removeOwnReaction(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await discordApiRequest(
    token,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    {
      method: "DELETE",
    }
  );
}

export async function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord interaction response ${response.status}: ${body}`);
  }
}
