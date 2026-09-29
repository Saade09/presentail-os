import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client backed by Replit AI Integrations (no user API key needed;
 * usage is billed to Replit credits).
 *
 * Resolution order:
 * 1. AI_INTEGRATIONS_ANTHROPIC_BASE_URL / AI_INTEGRATIONS_ANTHROPIC_API_KEY when
 *    the Anthropic integration has been provisioned directly.
 * 2. Derived from the already-provisioned OpenAI integration: the Replit AI
 *    proxy routes providers by path segment and shares the same credential,
 *    so swapping "openai" → "anthropic" in the base URL yields the Anthropic
 *    endpoint (verified against the live proxy).
 */
function resolveConfig(): { apiKey: string; baseURL: string } {
  const baseURL =
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ??
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.replace(/openai/g, "anthropic");
  const apiKey =
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ??
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error(
      "Anthropic AI integration is not configured: set AI_INTEGRATIONS_ANTHROPIC_BASE_URL " +
        "and AI_INTEGRATIONS_ANTHROPIC_API_KEY, or provision the Replit OpenAI AI integration " +
        "(AI_INTEGRATIONS_OPENAI_*) from which the Anthropic endpoint is derived.",
    );
  }

  return { apiKey, baseURL };
}

export const anthropic = new Anthropic(resolveConfig());
