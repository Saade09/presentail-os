// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — AI provider factory
// ---------------------------------------------------------------------------

import { MockAIProvider } from "./MockAIProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import type { IAIProvider } from "./IAIProvider";

export { MockAIProvider } from "./MockAIProvider";
export { OpenAIProvider } from "./OpenAIProvider";
export type { IAIProvider } from "./IAIProvider";
export type {
  AIMessage,
  KnowledgeBaseSnippet,
  DraftReplyResult,
  SummarizeResult,
  ClassifyIntentResult,
  SuggestTagsResult,
  SuggestEscalationReasonResult,
} from "./IAIProvider";

/**
 * Returns the appropriate AI provider.
 * Priority: workspaceApiKey (DB-stored per workspace) > Replit AI integration > OPENAI_API_KEY env > Mock
 */
export function getAIProvider(
  workspaceApiKey?: string | null,
  usageSessionId?: string | null,
): IAIProvider {
  if (workspaceApiKey) {
    return new OpenAIProvider(workspaceApiKey, usageSessionId);
  }

  const hasIntegration =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    process.env.OPENAI_API_KEY;

  if (hasIntegration) {
    return new OpenAIProvider(undefined, usageSessionId);
  }
  return new MockAIProvider();
}

export const AI_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.AI_CONFIDENCE_THRESHOLD ?? "0.75",
);

export const ENABLE_AI_AUTO_REPLY =
  process.env.ENABLE_AI_AUTO_REPLY === "true";
