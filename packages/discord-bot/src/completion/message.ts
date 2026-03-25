import type { AgentResponse, DiscordCallbackContext } from "../types";
import type { ManualPullRequestArtifactMetadata } from "@open-inspect/shared";

const CONTENT_LIMIT = 1800;

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export function buildCompletionMessage(
  sessionId: string,
  response: AgentResponse,
  context: DiscordCallbackContext,
  webAppUrl: string
): Record<string, unknown> {
  const embeds: Array<Record<string, unknown>> = [];

  embeds.push({
    title: response.success ? "Run complete" : "Run completed with issues",
    description: truncate(response.textContent) || "Agent completed.",
    color: response.success ? 0x2f855a : 0xdd6b20,
    fields: buildFields(response, context),
  });

  const buttons: Array<Record<string, unknown>> = [
    {
      type: 2,
      style: 5,
      label: "View Session",
      url: `${webAppUrl}/session/${sessionId}`,
    },
  ];

  const manualCreatePrUrl = getManualCreatePrUrl(response.artifacts);
  const hasPrArtifact = response.artifacts.some((artifact) => artifact.type === "pr");
  if (!hasPrArtifact && manualCreatePrUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: "Create PR",
      url: manualCreatePrUrl,
    });
  }

  return {
    embeds,
    components: [{ type: 1, components: buttons }],
  };
}

function buildFields(
  response: AgentResponse,
  context: DiscordCallbackContext
): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [
    {
      name: "Repository",
      value: context.repoFullName,
      inline: true,
    },
    {
      name: "Model",
      value: context.reasoningEffort
        ? `${context.model} (${context.reasoningEffort})`
        : context.model,
      inline: true,
    },
  ];

  if (response.artifacts.length > 0) {
    fields.push({
      name: "Artifacts",
      value: response.artifacts
        .map((artifact) => `[${artifact.label}](${artifact.url})`)
        .join("\n")
        .slice(0, 1024),
    });
  }

  const keyTools = response.toolCalls.filter((tool) =>
    ["Edit", "Write", "Bash"].includes(tool.tool)
  );
  if (keyTools.length > 0) {
    fields.push({
      name: "Key Actions",
      value: keyTools
        .slice(0, 5)
        .map((tool) => tool.summary)
        .join("\n")
        .slice(0, 1024),
    });
  }

  return fields;
}

function truncate(text: string): string {
  if (text.length <= CONTENT_LIMIT) return text;
  return `${text.slice(0, CONTENT_LIMIT - 16)}\n\n...truncated_`;
}

function getManualCreatePrUrl(artifacts: AgentResponse["artifacts"]): string | null {
  const manualBranchArtifact = artifacts.find((artifact) => {
    if (artifact.type !== "branch") {
      return false;
    }
    if (!artifact.metadata || typeof artifact.metadata !== "object") {
      return false;
    }
    const metadata = artifact.metadata as Partial<ManualPullRequestArtifactMetadata> &
      Record<string, unknown>;
    if (metadata.mode === "manual_pr") {
      return true;
    }
    return metadata.mode == null && typeof metadata.createPrUrl === "string";
  });

  if (!manualBranchArtifact) {
    return null;
  }

  const metadataUrl = manualBranchArtifact.metadata?.createPrUrl;
  if (typeof metadataUrl === "string" && metadataUrl.length > 0) {
    return metadataUrl;
  }

  return manualBranchArtifact.url || null;
}
