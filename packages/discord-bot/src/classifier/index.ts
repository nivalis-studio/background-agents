import Anthropic from "@anthropic-ai/sdk";
import type { Env, ThreadContext, ClassificationResult } from "../types";
import { getAvailableRepos, buildRepoDescriptions, getReposByChannel } from "./repos";

const CLASSIFY_REPO_TOOL_NAME = "classify_repository";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];

const CLASSIFY_REPO_TOOL: Anthropic.Messages.Tool = {
  name: CLASSIFY_REPO_TOOL_NAME,
  description:
    "Classify which repository a Discord request refers to. Use repoId as null when uncertain.",
  input_schema: {
    type: "object",
    properties: {
      repoId: {
        type: ["string", "null"],
        description: "Repository ID/fullName if confident enough to choose one, otherwise null.",
      },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
      },
      reasoning: {
        type: "string",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["repoId", "confidence", "reasoning", "alternatives"],
    additionalProperties: false,
  },
};

async function buildClassificationPrompt(
  env: Env,
  message: string,
  context?: ThreadContext,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

  let contextSection = "";
  if (context) {
    contextSection = `
## Context

**Channel**: ${context.channelName ? `#${context.channelName}` : context.channelId}
${context.channelDescription ? `**Channel Description**: ${context.channelDescription}` : ""}
${context.isThread ? "**In Thread**: Yes" : "**In Thread**: No"}
${
  context.previousMessages?.length
    ? `**Previous Messages in Thread**:\n${context.previousMessages.map((m) => `- ${m}`).join("\n")}`
    : ""
}`;
  }

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Discord request refers to.

## Available Repositories
${repoDescriptions}

${contextSection}

## User Request
${message}

Analyze the request and context to determine which repository the user is referring to.
Consider explicit repository mentions, technical keywords, file paths, channel associations, and thread history.

Return your decision by calling the ${CLASSIFY_REPO_TOOL_NAME} tool.`;
}

interface LLMResponse {
  repoId: string | null;
  confidence: ClassificationResult["confidence"];
  reasoning: string;
  alternatives: string[];
}

function normalizeModelResponse(raw: unknown): LLMResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LLM response was not an object");
  }

  const input = raw as Record<string, unknown>;
  const rawRepoId = input.repoId;
  const repoId =
    rawRepoId === null
      ? null
      : typeof rawRepoId === "string" && rawRepoId.trim().length > 0
        ? rawRepoId.trim()
        : null;

  const rawConfidence = typeof input.confidence === "string" ? input.confidence.trim() : "";
  const confidence = rawConfidence.toLowerCase();
  if (!CONFIDENCE_LEVELS.includes(confidence as ClassificationResult["confidence"])) {
    throw new Error(`Invalid confidence value: ${rawConfidence || String(input.confidence)}`);
  }

  if (typeof input.reasoning !== "string" || input.reasoning.trim().length === 0) {
    throw new Error("Missing reasoning in LLM response");
  }

  if (!Array.isArray(input.alternatives)) {
    throw new Error("Alternatives must be an array");
  }

  const alternatives = input.alternatives
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    repoId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
  };
}

function extractStructuredResponse(response: Anthropic.Messages.Message): LLMResponse {
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === CLASSIFY_REPO_TOOL_NAME
  );

  if (!toolUseBlock) {
    throw new Error("No structured tool_use classification in LLM response");
  }

  return normalizeModelResponse(toolUseBlock.input);
}

export class RepoClassifier {
  private readonly client: Anthropic;

  constructor(private readonly env: Env) {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    const repos = await getAvailableRepos(this.env, traceId);

    if (repos.length === 0) {
      return {
        repo: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    if (repos.length === 1) {
      return {
        repo: repos[0],
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    if (context?.channelId) {
      const channelRepos = await getReposByChannel(this.env, context.channelId, traceId);
      if (channelRepos.length === 1) {
        return {
          repo: channelRepos[0],
          confidence: "high",
          reasoning: `Channel is associated with repository ${channelRepos[0].fullName}`,
          needsClarification: false,
        };
      }
    }

    try {
      const prompt = await buildClassificationPrompt(this.env, message, context, traceId);
      const response = await this.client.messages.create({
        model: this.env.CLASSIFICATION_MODEL || "claude-haiku-4-5",
        max_tokens: 500,
        temperature: 0,
        tools: [CLASSIFY_REPO_TOOL],
        messages: [{ role: "user", content: prompt }],
      });

      const structured = extractStructuredResponse(response);
      const repo = structured.repoId
        ? repos.find(
            (candidate) =>
              candidate.id === structured.repoId || candidate.fullName === structured.repoId
          ) || null
        : null;

      return {
        repo,
        confidence: structured.confidence,
        reasoning: structured.reasoning,
        alternatives: repos.filter((candidate) =>
          structured.alternatives.some(
            (alternative) => alternative === candidate.id || alternative === candidate.fullName
          )
        ),
        needsClarification: !repo || structured.confidence !== "high",
      };
    } catch {
      return {
        repo: null,
        confidence: "low",
        reasoning: "Unable to classify repository automatically.",
        needsClarification: true,
      };
    }
  }
}

export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}
