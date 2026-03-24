import type { Env } from "../types";
import { generateInternalToken } from "./internal";

export interface ResolvedDiscordConfig {
  model: string | null;
  reasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  createThreadsOnNewSession: boolean;
  sessionInstructions: string | null;
  enabledRepos: string[] | null;
}

const DEFAULT_CONFIG: ResolvedDiscordConfig = {
  model: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  createThreadsOnNewSession: true,
  sessionInstructions: null,
  enabledRepos: null,
};

export async function getDiscordConfig(env: Env, repo: string): Promise<ResolvedDiscordConfig> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return DEFAULT_CONFIG;
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return DEFAULT_CONFIG;
  }

  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/discord/resolved/${owner}/${name}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    return DEFAULT_CONFIG;
  }

  if (!response.ok) {
    return DEFAULT_CONFIG;
  }

  const data = (await response.json()) as { config: ResolvedDiscordConfig | null };
  if (!data.config) {
    return DEFAULT_CONFIG;
  }

  return data.config;
}
