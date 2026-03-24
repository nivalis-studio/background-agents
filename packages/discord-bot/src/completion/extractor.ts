import type {
  Env,
  EventResponse,
  ListEventsResponse,
  ListArtifactsResponse,
  AgentResponse,
  ToolCallSummary,
  ArtifactInfo,
} from "../types";
import type { ArtifactType } from "@open-inspect/shared";
import { generateInternalToken } from "../utils/internal";

export const SUMMARY_TOOL_NAMES = ["Edit", "Write", "Bash", "Grep", "Read"] as const;

const EVENTS_PAGE_LIMIT = 200;

export async function extractAgentResponse(
  env: Env,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (traceId) {
    headers["x-trace-id"] = traceId;
  }

  const allEvents: EventResponse[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`https://internal/sessions/${sessionId}/events`);
    url.searchParams.set("message_id", messageId);
    url.searchParams.set("limit", String(EVENTS_PAGE_LIMIT));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await env.CONTROL_PLANE.fetch(url.toString(), { headers });
    if (!response.ok) {
      return { textContent: "", toolCalls: [], artifacts: [], success: false };
    }

    const data = (await response.json()) as ListEventsResponse;
    allEvents.push(...data.events);
    cursor = data.hasMore ? data.cursor : undefined;
  } while (cursor);

  const tokenEvents = allEvents
    .filter((e): e is EventResponse & { type: "token" } => e.type === "token")
    .sort((a, b) => {
      const timeDiff = (a.createdAt as number) - (b.createdAt as number);
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });
  const lastToken = tokenEvents[tokenEvents.length - 1];
  const textContent = lastToken ? String(lastToken.data.content ?? "") : "";

  const toolCalls: ToolCallSummary[] = allEvents
    .filter((e) => e.type === "tool_call")
    .map((e) => summarizeToolCall(e.data));

  const eventArtifacts: ArtifactInfo[] = allEvents
    .filter((e) => e.type === "artifact")
    .map((e) => toEventArtifactInfo(e.data))
    .filter((artifact: ArtifactInfo | null): artifact is ArtifactInfo => artifact !== null);

  const response = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${sessionId}/artifacts`,
    {
      headers,
    }
  );
  const artifacts = response.ok
    ? ((await response.json()) as ListArtifactsResponse).artifacts.map((artifact) => ({
        type: artifact.type,
        url: artifact.url ? String(artifact.url) : "",
        label: getArtifactLabelFromArtifact(artifact.type, artifact.metadata),
        metadata: artifact.metadata ?? null,
      }))
    : [];

  const completionEvent = allEvents.find((e) => e.type === "execution_complete");

  return {
    textContent,
    toolCalls,
    artifacts: artifacts.length > 0 ? artifacts : eventArtifacts,
    success: Boolean(completionEvent?.data.success),
  };
}

function summarizeToolCall(data: Record<string, unknown>): ToolCallSummary {
  const tool = String(data.tool ?? "Unknown");
  const args = (data.args ?? {}) as Record<string, unknown>;

  switch (tool) {
    case "Read":
      return { tool, summary: `Read ${args.file_path ?? "file"}` };
    case "Edit":
      return { tool, summary: `Edited ${args.file_path ?? "file"}` };
    case "Write":
      return { tool, summary: `Created ${args.file_path ?? "file"}` };
    case "Bash": {
      const cmd = String(args.command ?? "").slice(0, 40);
      return { tool, summary: `Ran: ${cmd}${cmd.length >= 40 ? "..." : ""}` };
    }
    case "Grep":
      return { tool, summary: `Searched for "${args.pattern ?? ""}"` };
    default:
      return { tool, summary: `Used ${tool}` };
  }
}

function getArtifactLabel(data: Record<string, unknown>): string {
  const type = String(data.artifactType ?? "artifact");
  if (type === "pr") {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    const prNum = metadata?.number;
    return prNum ? `PR #${prNum}` : "Pull Request";
  }
  if (type === "branch") {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    return `Branch: ${metadata?.name ?? "branch"}`;
  }
  return type;
}

function toEventArtifactInfo(data: Record<string, unknown>): ArtifactInfo | null {
  if (typeof data.url !== "string" || data.url.length === 0) {
    return null;
  }

  return {
    type: String(data.artifactType ?? "artifact") as ArtifactType,
    url: data.url,
    label: getArtifactLabel(data),
    metadata: (data.metadata as Record<string, unknown> | null) ?? null,
  };
}

function getArtifactLabelFromArtifact(
  type: string,
  metadata: Record<string, unknown> | null | undefined
): string {
  return getArtifactLabel({ artifactType: type, metadata: metadata ?? undefined });
}
