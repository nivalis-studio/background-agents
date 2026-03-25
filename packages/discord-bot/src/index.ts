import { Hono } from "hono";
import type {
  Env,
  RepoConfig,
  CallbackContext,
  ThreadSession,
  UserPreferences,
  DiscordInteraction,
  PendingSelection,
} from "./types";
import {
  verifyDiscordSignature,
  getChannelInfo,
  getChannelMessages,
  createMessage,
  createThreadFromMessage,
  addReaction,
  editOriginalInteractionResponse,
  isThreadChannel,
} from "./utils/discord-client";
import { createClassifier } from "./classifier";
import { getAvailableRepos, getRepoByFullName, getRepoById } from "./classifier/repos";
import { callbacksRouter } from "./callbacks";
import { generateInternalToken } from "./utils/internal";
import { createLogger } from "./logger";
import { getDiscordConfig } from "./utils/integration-config";
import {
  MODEL_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_ENABLED_MODELS,
  getValidModelOrDefault,
  getReasoningConfig,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
} from "@open-inspect/shared";

const app = new Hono<{ Bindings: Env }>();
const log = createLogger("handler");
const THINKING_EMOJI = "⏳";
const PENDING_SELECTION_TTL_SECONDS = 15 * 60;
const THREAD_SESSION_TTL_SECONDS = 24 * 60 * 60;
const PROMPT_PREVIEW_LIMIT = 1500;

function getThreadSessionKey(channelId: string): string {
  return `thread:${channelId}`;
}

function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

function getPendingSelectionKey(id: string): string {
  return `pending:${id}`;
}

function formatPromptPreview(prompt: string): string {
  const normalized = prompt.trim();
  if (normalized.length <= PROMPT_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, PROMPT_PREVIEW_LIMIT - 28)}\n\n...[full prompt in session]`;
}

function buildInspectResponseContent(options: {
  prompt: string;
  repoFullName?: string;
  targetChannelId?: string;
  continued?: boolean;
  failure?: boolean;
}): string {
  const lines: string[] = [];

  if (options.failure) {
    lines.push(
      options.repoFullName
        ? `I couldn't start a session for **${options.repoFullName}**.`
        : "I couldn't process that inspect request."
    );
  } else if (options.continued) {
    lines.push(
      options.repoFullName
        ? `Continuing **${options.repoFullName}** in <#${options.targetChannelId}>.`
        : `Continuing the existing session in <#${options.targetChannelId}>.`
    );
  } else {
    lines.push(
      options.repoFullName && options.targetChannelId
        ? `Started Open-Inspect for **${options.repoFullName}** in <#${options.targetChannelId}>.`
        : "Started Open-Inspect."
    );
  }

  lines.push("", "**Prompt**", formatPromptPreview(options.prompt));
  return lines.join("\n");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers.Authorization = `Bearer ${authToken}`;
  }

  if (traceId) {
    headers["x-trace-id"] = traceId;
  }

  return headers;
}

async function createSession(
  env: Env,
  repo: RepoConfig,
  title: string | undefined,
  model: string,
  reasoningEffort: string | undefined,
  traceId?: string
): Promise<{ sessionId: string; status: string } | null> {
  const headers = await getAuthHeaders(env, traceId);
  const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner: repo.owner,
      repoName: repo.name,
      title: title || `Discord: ${repo.name}`,
      model,
      reasoningEffort,
    }),
  });

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<{ sessionId: string; status: string }>;
}

async function sendPrompt(
  env: Env,
  sessionId: string,
  content: string,
  authorId: string,
  callbackContext?: CallbackContext,
  traceId?: string
): Promise<{ messageId: string } | null> {
  const headers = await getAuthHeaders(env, traceId);
  const response = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content,
      authorId,
      source: "discord",
      callbackContext,
    }),
  });

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<{ messageId: string }>;
}

async function getAvailableModels(env: Env, traceId?: string): Promise<string[]> {
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/model-preferences", {
      method: "GET",
      headers,
    });
    if (response.ok) {
      const data = (await response.json()) as { enabledModels: string[] };
      if (data.enabledModels.length > 0) {
        return data.enabledModels;
      }
    }
  } catch {
    // Fall through to defaults
  }

  return DEFAULT_ENABLED_MODELS;
}

function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.userId === "string" &&
    typeof obj.model === "string" &&
    typeof obj.updatedAt === "number"
  );
}

async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  const data = await env.DISCORD_KV.get(getUserPreferencesKey(userId), "json");
  return isValidUserPreferences(data) ? data : null;
}

async function saveUserPreferences(
  env: Env,
  userId: string,
  model: string,
  reasoningEffort?: string
): Promise<void> {
  const prefs: UserPreferences = {
    userId,
    model,
    reasoningEffort,
    updatedAt: Date.now(),
  };
  await env.DISCORD_KV.put(getUserPreferencesKey(userId), JSON.stringify(prefs));
}

async function lookupThreadSession(env: Env, channelId: string): Promise<ThreadSession | null> {
  const data = await env.DISCORD_KV.get(getThreadSessionKey(channelId), "json");
  return data && typeof data === "object" ? (data as ThreadSession) : null;
}

async function storeThreadSession(
  env: Env,
  channelId: string,
  session: ThreadSession
): Promise<void> {
  await env.DISCORD_KV.put(getThreadSessionKey(channelId), JSON.stringify(session), {
    expirationTtl: THREAD_SESSION_TTL_SECONDS,
  });
}

function buildThreadSession(
  sessionId: string,
  repo: RepoConfig,
  model: string,
  reasoningEffort?: string
): ThreadSession {
  return {
    sessionId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
    createdAt: Date.now(),
  };
}

function buildThreadContextMessages(
  messages: Awaited<ReturnType<typeof getChannelMessages>>
): string[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .reverse()
    .map((message) => {
      const author =
        message.author?.global_name || message.author?.username || message.author?.id || "unknown";
      return `${author}: ${message.content}`;
    });
}

async function gatherContext(
  env: Env,
  channelId: string
): Promise<{
  context: {
    channelId: string;
    channelName?: string;
    channelDescription?: string;
    isThread?: boolean;
    previousMessages?: string[];
  };
  channelInfo: Awaited<ReturnType<typeof getChannelInfo>>;
}> {
  const channelInfo = await getChannelInfo(env.DISCORD_BOT_TOKEN, channelId);
  const isThread = isThreadChannel(channelInfo);
  const previousMessages = isThread
    ? buildThreadContextMessages(await getChannelMessages(env.DISCORD_BOT_TOKEN, channelId, 10))
    : [];

  return {
    channelInfo,
    context: {
      channelId,
      channelName: channelInfo?.name,
      channelDescription: channelInfo?.topic,
      isThread,
      previousMessages,
    },
  };
}

function getInteractionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id || interaction.user?.id || null;
}

function getStringOption(interaction: DiscordInteraction, name: string): string | undefined {
  const option = interaction.data?.options?.find((candidate) => candidate.name === name);
  return typeof option?.value === "string" ? option.value : undefined;
}

function getFocusedOption(interaction: DiscordInteraction): string | undefined {
  const option = interaction.data?.options?.find((candidate) => candidate.focused);
  return typeof option?.value === "string" ? option.value : undefined;
}

function normalizeRequestedRepoInput(env: Env, input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("/")) {
    return trimmed;
  }

  const defaultOwner = env.DISCORD_DEFAULT_REPO_OWNER?.trim().toLowerCase();
  if (!defaultOwner) {
    return trimmed;
  }

  return `${defaultOwner}/${trimmed.toLowerCase()}`;
}

async function resolveRequestedRepoInput(
  env: Env,
  requestedRepo: string,
  traceId?: string
): Promise<RepoConfig | undefined> {
  const normalizedInput = normalizeRequestedRepoInput(env, requestedRepo);
  return (
    (await getRepoByFullName(env, normalizedInput, traceId)) ||
    (await getRepoById(env, normalizedInput, traceId)) ||
    (await getRepoById(env, requestedRepo, traceId))
  );
}

async function buildRepoAutocompleteChoices(
  env: Env,
  focusedValue: string,
  traceId?: string
): Promise<Array<{ name: string; value: string }>> {
  const repos = await getAvailableRepos(env, traceId);
  const query = focusedValue.trim().toLowerCase();
  const defaultOwner = env.DISCORD_DEFAULT_REPO_OWNER?.trim().toLowerCase();

  return repos
    .filter((repo) => {
      if (!query) return true;
      const shortName =
        defaultOwner && repo.owner.toLowerCase() === defaultOwner ? repo.name.toLowerCase() : "";

      return (
        repo.fullName.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query) ||
        shortName.includes(query) ||
        repo.aliases?.some((alias) => alias.toLowerCase().includes(query))
      );
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .slice(0, 25)
    .map((repo) => {
      const useShortValue = defaultOwner && repo.owner.toLowerCase() === defaultOwner;
      const value = useShortValue ? repo.name : repo.fullName;
      const name = useShortValue ? `${repo.name} (${repo.fullName})` : repo.fullName;
      return {
        name: name.slice(0, 100),
        value: value.slice(0, 100),
      };
    });
}

function buildRepoSelectComponents(
  repos: RepoConfig[],
  pendingId: string
): Record<string, unknown>[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `select_repo:${pendingId}`,
          placeholder: "Choose a repository",
          options: repos.slice(0, 25).map((repo) => ({
            label: repo.fullName.slice(0, 100),
            value: repo.id,
            description: (repo.description || repo.fullName).slice(0, 100),
          })),
        },
      ],
    },
  ];
}

const MODEL_LABELS = new Map<string, string>(
  MODEL_OPTIONS.flatMap((group) => group.models.map((model) => [model.id, model.name]))
);

async function buildSettingsMessage(
  env: Env,
  userId: string,
  traceId?: string
): Promise<Record<string, unknown>> {
  const prefs = await getUserPreferences(env, userId);
  const enabledModels = await getAvailableModels(env, traceId);
  const currentModel = getValidModelOrDefault(prefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL);
  const reasoningConfig = getReasoningConfig(currentModel);
  const currentEffort =
    prefs?.reasoningEffort && isValidReasoningEffort(currentModel, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : getDefaultReasoningEffort(currentModel);

  const components: Record<string, unknown>[] = [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "settings:model",
          placeholder: "Select a model",
          options: enabledModels.slice(0, 25).map((modelId) => ({
            label: (MODEL_LABELS.get(modelId) || modelId).slice(0, 100),
            value: modelId,
            default: modelId === currentModel,
          })),
        },
      ],
    },
  ];

  if (reasoningConfig) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "settings:reasoning",
          placeholder: "Select reasoning effort",
          options: reasoningConfig.efforts.map((effort) => ({
            label: effort,
            value: effort,
            default: effort === currentEffort,
          })),
        },
      ],
    });
  }

  return {
    content: `Current model: **${MODEL_LABELS.get(currentModel) || currentModel}**${currentEffort ? `\nReasoning effort: **${currentEffort}**` : ""}`,
    components,
  };
}

async function ensureTargetChannel(
  env: Env,
  channelId: string,
  prompt: string,
  createThread: boolean,
  traceId?: string
): Promise<{ targetChannelId: string; parentStatusMessageId?: string }> {
  const channelInfo = await getChannelInfo(env.DISCORD_BOT_TOKEN, channelId);
  if (isThreadChannel(channelInfo)) {
    return { targetChannelId: channelId };
  }

  if (!createThread) {
    return { targetChannelId: channelId };
  }

  const starter = await createMessage(env.DISCORD_BOT_TOKEN, channelId, {
    content: `Starting Open-Inspect session: ${prompt.slice(0, 120)}`,
  });

  try {
    const thread = await createThreadFromMessage(
      env.DISCORD_BOT_TOKEN,
      channelId,
      starter.id,
      prompt.slice(0, 80) || "Open-Inspect Session"
    );
    return { targetChannelId: thread.id, parentStatusMessageId: starter.id };
  } catch (error) {
    log.warn("discord.thread.create", {
      trace_id: traceId,
      channel_id: channelId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { targetChannelId: channelId, parentStatusMessageId: starter.id };
  }
}

async function postSessionStartedMessage(
  env: Env,
  channelId: string,
  repo: RepoConfig,
  sessionId: string,
  reasoning: string,
  traceId?: string
): Promise<string | undefined> {
  try {
    const message = await createMessage(env.DISCORD_BOT_TOKEN, channelId, {
      content: `Working on **${repo.fullName}**...\n_${reasoning}_`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "View Session",
              url: `${env.WEB_APP_URL}/session/${sessionId}`,
            },
          ],
        },
      ],
    });
    await addReaction(env.DISCORD_BOT_TOKEN, channelId, message.id, THINKING_EMOJI);
    return message.id;
  } catch (error) {
    log.warn("discord.session_started", {
      trace_id: traceId,
      channel_id: channelId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return undefined;
  }
}

async function startSessionAndSendPrompt(
  env: Env,
  repo: RepoConfig,
  sourceChannelId: string,
  prompt: string,
  userId: string,
  context: { channelName?: string; channelDescription?: string; previousMessages?: string[] },
  model: string,
  reasoningEffort: string | undefined,
  sessionInstructions: string | null,
  createThreadsOnNewSession: boolean,
  traceId?: string
): Promise<{ sessionId: string; targetChannelId: string } | null> {
  const { targetChannelId } = await ensureTargetChannel(
    env,
    sourceChannelId,
    prompt,
    createThreadsOnNewSession,
    traceId
  );

  const session = await createSession(env, repo, undefined, model, reasoningEffort, traceId);
  if (!session) {
    return null;
  }

  const statusMessageId = await postSessionStartedMessage(
    env,
    targetChannelId,
    repo,
    session.sessionId,
    `Repo selected: ${repo.fullName}`,
    traceId
  );

  const callbackContext: CallbackContext = {
    source: "discord",
    channelId: targetChannelId,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
    statusMessageId,
  };

  const promptParts = [prompt.trim()];
  if (context.channelName || context.channelDescription || context.previousMessages?.length) {
    promptParts.push("\nDiscord context:");
    if (context.channelName) {
      promptParts.push(`- Channel: #${context.channelName}`);
    }
    if (context.channelDescription) {
      promptParts.push(`- Channel topic: ${context.channelDescription}`);
    }
    if (context.previousMessages?.length) {
      promptParts.push("- Previous thread messages:");
      promptParts.push(...context.previousMessages.map((message) => `  - ${message}`));
    }
  }

  if (sessionInstructions) {
    promptParts.push(`\n## Additional Instructions\n\n${sessionInstructions}`);
  }

  const promptResult = await sendPrompt(
    env,
    session.sessionId,
    promptParts.join("\n"),
    userId,
    callbackContext,
    traceId
  );

  if (!promptResult) {
    return null;
  }

  await storeThreadSession(
    env,
    targetChannelId,
    buildThreadSession(session.sessionId, repo, model, reasoningEffort)
  );

  return { sessionId: session.sessionId, targetChannelId };
}

async function continueSessionInThread(
  env: Env,
  threadSession: ThreadSession,
  channelId: string,
  prompt: string,
  userId: string,
  traceId?: string
): Promise<boolean> {
  const statusMessageId = await postSessionStartedMessage(
    env,
    channelId,
    {
      id: threadSession.repoId,
      owner: threadSession.repoFullName.split("/")[0] || "",
      name: threadSession.repoFullName.split("/")[1] || "",
      fullName: threadSession.repoFullName,
      displayName: threadSession.repoFullName,
      description: threadSession.repoFullName,
      defaultBranch: "main",
      private: true,
    },
    threadSession.sessionId,
    "Using existing thread session",
    traceId
  );

  const callbackContext: CallbackContext = {
    source: "discord",
    channelId,
    repoFullName: threadSession.repoFullName,
    model: threadSession.model,
    reasoningEffort: threadSession.reasoningEffort,
    statusMessageId,
  };

  const result = await sendPrompt(
    env,
    threadSession.sessionId,
    prompt,
    userId,
    callbackContext,
    traceId
  );

  return result !== null;
}

async function handleInspectCommand(
  interaction: DiscordInteraction,
  env: Env,
  traceId: string
): Promise<void> {
  const userId = getInteractionUserId(interaction);
  const channelId = interaction.channel_id;
  const interactionToken = interaction.token;
  if (!userId || !channelId) {
    return;
  }

  const prompt = getStringOption(interaction, "prompt")?.trim();
  const requestedRepo = getStringOption(interaction, "repo")?.trim();
  if (!prompt) {
    await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
      content: "Prompt is required.",
      components: [],
    });
    return;
  }

  const { channelInfo, context } = await gatherContext(env, channelId);
  const prefs = await getUserPreferences(env, userId);
  const fallbackModel = getValidModelOrDefault(prefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL);
  const fallbackReasoningEffort =
    prefs?.reasoningEffort && isValidReasoningEffort(fallbackModel, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : getDefaultReasoningEffort(fallbackModel);

  if (context.isThread) {
    const existingSession = await lookupThreadSession(env, channelId);
    if (existingSession) {
      const continued = await continueSessionInThread(
        env,
        existingSession,
        channelId,
        prompt,
        userId,
        traceId
      );
      await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
        content: continued
          ? buildInspectResponseContent({
              prompt,
              repoFullName: existingSession.repoFullName,
              targetChannelId: channelId,
              continued: true,
            })
          : buildInspectResponseContent({
              prompt,
              repoFullName: existingSession.repoFullName,
              targetChannelId: channelId,
              failure: true,
            }),
        components: [],
      });
      return;
    }
  }

  let repo: RepoConfig | undefined;
  if (requestedRepo) {
    repo = await resolveRequestedRepoInput(env, requestedRepo, traceId);
    if (!repo) {
      await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
        content: `Repository \`${requestedRepo}\` is not available to the GitHub App installation.`,
        components: [],
      });
      return;
    }
  }

  if (!repo) {
    const classifier = createClassifier(env);
    const classification = await classifier.classify(prompt, context, traceId);
    if (classification.repo && !classification.needsClarification) {
      repo = classification.repo;
    } else {
      const repos = classification.alternatives?.length
        ? classification.alternatives
        : await getAvailableRepos(env, traceId);
      const pendingId = crypto.randomUUID();
      const pending: PendingSelection = {
        prompt,
        userId,
        channelId,
        channelName: context.channelName,
        channelDescription: context.channelDescription,
        previousMessages: context.previousMessages,
        model: fallbackModel,
        reasoningEffort: fallbackReasoningEffort,
        createdAt: Date.now(),
      };
      await env.DISCORD_KV.put(getPendingSelectionKey(pendingId), JSON.stringify(pending), {
        expirationTtl: PENDING_SELECTION_TTL_SECONDS,
      });
      await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
        content: classification.reasoning || "I need you to choose which repository to use.",
        components: buildRepoSelectComponents(repos, pendingId),
      });
      return;
    }
  }

  const discordConfig = await getDiscordConfig(env, repo.fullName);
  if (
    discordConfig.enabledRepos &&
    !discordConfig.enabledRepos.includes(repo.fullName.toLowerCase())
  ) {
    await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
      content: `The Discord bot is not enabled for **${repo.fullName}**.`,
      components: [],
    });
    return;
  }

  const configuredModel = discordConfig.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL;
  const preferenceModel = discordConfig.allowUserPreferenceOverride ? prefs?.model : undefined;
  const model = getValidModelOrDefault(preferenceModel ?? configuredModel);
  const reasoningEffort =
    discordConfig.allowUserPreferenceOverride &&
    prefs?.reasoningEffort &&
    isValidReasoningEffort(model, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : discordConfig.reasoningEffort &&
          isValidReasoningEffort(model, discordConfig.reasoningEffort)
        ? discordConfig.reasoningEffort
        : getDefaultReasoningEffort(model);

  const started = await startSessionAndSendPrompt(
    env,
    repo,
    channelId,
    prompt,
    userId,
    {
      channelName: channelInfo?.name,
      channelDescription: channelInfo?.topic,
      previousMessages: context.previousMessages,
    },
    model,
    reasoningEffort,
    discordConfig.sessionInstructions,
    discordConfig.createThreadsOnNewSession,
    traceId
  );

  await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interactionToken, {
    content: started
      ? buildInspectResponseContent({
          prompt,
          repoFullName: repo.fullName,
          targetChannelId: started.targetChannelId,
        })
      : buildInspectResponseContent({ prompt, repoFullName: repo.fullName, failure: true }),
    components: started
      ? [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "View Session",
                url: `${env.WEB_APP_URL}/session/${started.sessionId}`,
              },
            ],
          },
        ]
      : [],
  });
}

async function handleRepoSelection(
  interaction: DiscordInteraction,
  env: Env,
  traceId: string
): Promise<void> {
  const pendingId = interaction.data?.custom_id?.split(":")[1];
  const selectedRepoId = interaction.data?.values?.[0];
  if (!pendingId || !selectedRepoId) {
    return;
  }

  const rawPending = await env.DISCORD_KV.get(getPendingSelectionKey(pendingId), "json");
  if (!rawPending || typeof rawPending !== "object") {
    await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: "That request has expired. Please run `/inspect` again.",
      components: [],
    });
    return;
  }

  const pending = rawPending as PendingSelection;
  const repo = await getRepoById(env, selectedRepoId, traceId);
  if (!repo) {
    await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: "That repository is no longer available. Please run `/inspect` again.",
      components: [],
    });
    return;
  }

  const discordConfig = await getDiscordConfig(env, repo.fullName);
  if (
    discordConfig.enabledRepos &&
    !discordConfig.enabledRepos.includes(repo.fullName.toLowerCase())
  ) {
    await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content: `The Discord bot is not enabled for **${repo.fullName}**.`,
      components: [],
    });
    return;
  }

  const started = await startSessionAndSendPrompt(
    env,
    repo,
    pending.channelId,
    pending.prompt,
    pending.userId,
    {
      channelName: pending.channelName,
      channelDescription: pending.channelDescription,
      previousMessages: pending.previousMessages,
    },
    discordConfig.allowUserPreferenceOverride
      ? pending.model
      : getValidModelOrDefault(discordConfig.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL),
    discordConfig.allowUserPreferenceOverride
      ? pending.reasoningEffort
      : (discordConfig.reasoningEffort ??
          getDefaultReasoningEffort(
            getValidModelOrDefault(discordConfig.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL)
          )),
    discordConfig.sessionInstructions,
    discordConfig.createThreadsOnNewSession,
    traceId
  );

  await env.DISCORD_KV.delete(getPendingSelectionKey(pendingId));

  await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
    content: started
      ? buildInspectResponseContent({
          prompt: pending.prompt,
          repoFullName: repo.fullName,
          targetChannelId: started.targetChannelId,
        })
      : buildInspectResponseContent({
          prompt: pending.prompt,
          repoFullName: repo.fullName,
          failure: true,
        }),
    components: [],
  });
}

async function handleSettingsCommand(
  interaction: DiscordInteraction,
  env: Env,
  traceId: string
): Promise<void> {
  const userId = getInteractionUserId(interaction);
  if (!userId) {
    return;
  }

  const message = await buildSettingsMessage(env, userId, traceId);
  await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, message);
}

async function handleSettingsSelection(
  interaction: DiscordInteraction,
  env: Env,
  traceId: string
): Promise<void> {
  const userId = getInteractionUserId(interaction);
  const customId = interaction.data?.custom_id;
  const selectedValue = interaction.data?.values?.[0];
  if (!userId || !customId || !selectedValue) {
    return;
  }

  const prefs = await getUserPreferences(env, userId);
  const currentModel = getValidModelOrDefault(prefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL);

  if (customId === "settings:model") {
    const selectedModel = getValidModelOrDefault(selectedValue);
    const nextReasoning = getDefaultReasoningEffort(selectedModel);
    await saveUserPreferences(env, userId, selectedModel, nextReasoning);
  }

  if (customId === "settings:reasoning" && isValidReasoningEffort(currentModel, selectedValue)) {
    await saveUserPreferences(env, userId, currentModel, selectedValue);
  }

  const message = await buildSettingsMessage(env, userId, traceId);
  await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, message);
}

async function handleRepoAutocomplete(
  interaction: DiscordInteraction,
  env: Env,
  traceId: string
): Promise<Response> {
  const focusedValue = getFocusedOption(interaction) ?? "";
  const choices = await buildRepoAutocompleteChoices(env, focusedValue, traceId);
  return Response.json({
    type: 8,
    data: {
      choices,
    },
  });
}

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-discord-bot" }));
app.route("/callbacks", callbacksRouter);

app.post("/interactions", async (c) => {
  const body = await c.req.text();
  const isValid = await verifyDiscordSignature(
    c.req.header("X-Signature-Ed25519") ?? null,
    c.req.header("X-Signature-Timestamp") ?? null,
    body,
    c.env.DISCORD_PUBLIC_KEY
  );

  if (!isValid) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const interaction = JSON.parse(body) as DiscordInteraction;
  const traceId = crypto.randomUUID();

  if (interaction.type === 1) {
    return c.json({ type: 1 });
  }

  if (interaction.type === 2 && interaction.data?.name === "inspect") {
    c.executionCtx.waitUntil(handleInspectCommand(interaction, c.env, traceId));
    return c.json({ type: 5 });
  }

  if (interaction.type === 2 && interaction.data?.name === "inspect-settings") {
    c.executionCtx.waitUntil(handleSettingsCommand(interaction, c.env, traceId));
    return c.json({ type: 5, data: { flags: 64 } });
  }

  if (interaction.type === 4 && interaction.data?.name === "inspect") {
    return handleRepoAutocomplete(interaction, c.env, traceId);
  }

  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id || "";
    if (customId.startsWith("select_repo:")) {
      c.executionCtx.waitUntil(handleRepoSelection(interaction, c.env, traceId));
      return c.json({ type: 6 });
    }

    if (customId.startsWith("settings:")) {
      c.executionCtx.waitUntil(handleSettingsSelection(interaction, c.env, traceId));
      return c.json({ type: 6 });
    }
  }

  return c.json({ error: "unsupported interaction" }, 400);
});

export default {
  fetch: app.fetch,
};
