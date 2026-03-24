import type { Fetcher, KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  DISCORD_KV: KVNamespace;
  CONTROL_PLANE: Fetcher;

  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;
  DISCORD_APPLICATION_ID: string;

  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  ANTHROPIC_API_KEY: string;
  INTERNAL_CALLBACK_SECRET?: string;
  LOG_LEVEL?: string;
}

export type {
  RepoConfig,
  RepoMetadata,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
  ClassificationResult,
  ConfidenceLevel,
  EventResponse,
  ListEventsResponse,
  ArtifactResponse,
  ListArtifactsResponse,
  ToolCallSummary,
  ArtifactInfo,
  AgentResponse,
  UserPreferences,
} from "@open-inspect/shared";

export interface DiscordCallbackContext {
  source: "discord";
  channelId: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  statusMessageId?: string;
}

export type CallbackContext = DiscordCallbackContext;

export interface ThreadContext {
  channelId: string;
  channelName?: string;
  channelDescription?: string;
  isThread?: boolean;
  previousMessages?: string[];
}

export interface ThreadSession {
  sessionId: string;
  repoId: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  createdAt: number;
}

export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
  timestamp: number;
  signature: string;
  context: DiscordCallbackContext;
}

export interface PendingSelection {
  prompt: string;
  userId: string;
  channelId: string;
  channelName?: string;
  channelDescription?: string;
  previousMessages?: string[];
  model: string;
  reasoningEffort?: string;
  createdAt: number;
}

export interface DiscordChannelInfo {
  id: string;
  name?: string;
  topic?: string;
  parent_id?: string;
  type?: number;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author?: {
    id: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  guild_id?: string;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: Array<{
      name: string;
      type: number;
      value?: string | number | boolean;
    }>;
    values?: string[];
  };
  member?: {
    user?: {
      id: string;
      username?: string;
      global_name?: string | null;
    };
  };
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
  };
}
