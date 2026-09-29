// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — OpenAI AI provider
// Uses the @workspace/integrations-openai-ai-server client.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import { z } from "zod/v4";
import { callAI } from "../../../lib/ai/callAI";
import { logger } from "../../../lib/logger";
import type {
  IAIProvider,
  AIMessage,
  KnowledgeBaseSnippet,
  DraftReplyResult,
  SummarizeResult,
  ClassifyIntentResult,
  SuggestTagsResult,
  SuggestEscalationReasonResult,
} from "./IAIProvider";

const AI_MODEL = "gpt-5-mini";
const MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Guardrails system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = `You are a helpful customer support assistant. Follow these rules strictly:

GUARDRAILS:
1. NEVER promise specific refund amounts, discount values, or delivery dates unless the knowledge base explicitly states them.
2. NEVER provide legal, medical, or financial advice.
3. NEVER reveal your reasoning, confidence score, or internal deliberation to the customer.
4. ONLY use information from the conversation history and the knowledge base snippets provided.
5. If you are uncertain or the topic is outside the knowledge base, recommend escalation to a human agent.
6. Be empathetic, professional, and concise.

RESPONSE FORMAT:
Always respond with a valid JSON object with these fields:
- "draft": string — the customer-facing reply text (plain text, no markdown)
- "confidence": number between 0 and 1 — your confidence that this draft is correct and helpful
- "sources": string[] — list of knowledge base article titles you referenced (empty array if none)
- "escalate": boolean — true if a human agent should review before sending

OUTPUT ONLY THE JSON OBJECT, no other text.`;

function buildKbContext(knowledgeBase: KnowledgeBaseSnippet[]): string {
  if (knowledgeBase.length === 0) return "";
  const snippets = knowledgeBase
    .map((kb) => `[${kb.title}]${kb.category ? ` (${kb.category})` : ""}: ${kb.content}`)
    .join("\n\n");
  return `\n\nKNOWLEDGE BASE:\n${snippets}`;
}

function buildHistoryMessages(history: AIMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Zod schema for AI JSON output
// ---------------------------------------------------------------------------

const DraftReplyOutputSchema = z.object({
  draft: z.string(),
  confidence: z.number().min(0).max(1),
  sources: z.array(z.string()),
  escalate: z.boolean(),
});

const SummarizeOutputSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
});

const ClassifyOutputSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  suggestedTags: z.array(z.string()),
});

const SuggestTagsOutputSchema = z.object({
  tags: z.array(z.string()),
});

const EscalationOutputSchema = z.object({
  reason: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
});

// ---------------------------------------------------------------------------
// Helper: parse JSON from model output safely
// ---------------------------------------------------------------------------

function parseJSON(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    return JSON.parse(fenceMatch ? fenceMatch[1] : trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Could not parse JSON from model output");
  }
}

export class OpenAIProvider implements IAIProvider {
  private readonly customApiKey: string | null;
  private readonly usageSessionId: string | null;

  constructor(customApiKey?: string, usageSessionId?: string | null) {
    this.customApiKey = customApiKey ?? null;
    this.usageSessionId = usageSessionId ?? null;
  }

  private async getClient(): Promise<OpenAI> {
    if (this.customApiKey) {
      return new OpenAI({ apiKey: this.customApiKey });
    }
    const { openai } = await import("@workspace/integrations-openai-ai-server");
    return openai as unknown as OpenAI;
  }

  private complete(
    actionKey: string,
    client: OpenAI,
    request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { model, messages, max_completion_tokens: maxTokens } = request;
    return callAI({
      actionKey,
      surface: "omnichannel",
      provider: "openai",
      model,
      messages,
      maxTokens: maxTokens ?? undefined,
      sessionId: this.usageSessionId,
      credentialResolvedFromDatabase: Boolean(this.customApiKey),
      client,
    });
  }

  async draftReply(
    conversationHistory: AIMessage[],
    knowledgeBase: KnowledgeBaseSnippet[],
    context?: string,
  ): Promise<DraftReplyResult> {
    const client = await this.getClient();
    const kbContext = buildKbContext(knowledgeBase);
    const systemPrompt = SYSTEM_PROMPT_BASE + kbContext;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      ...buildHistoryMessages(conversationHistory),
    ];

    if (context) {
      messages.push({ role: "user", content: `Additional context from agent: ${context}` });
    }

    messages.push({
      role: "user",
      content: "Please draft a reply to the last customer message following the required JSON format.",
    });

    try {
      const response = await this.complete("omnichannel.draft_reply", client, {
        model: AI_MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages,
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = DraftReplyOutputSchema.parse(parseJSON(raw));
      return parsed;
    } catch (err) {
      logger.error({ err }, "omnichannel ai: draftReply failed");
      return {
        draft: "I understand your concern. A member of our team will be in touch shortly.",
        confidence: 0.3,
        sources: [],
        escalate: true,
      };
    }
  }

  async summarize(
    conversationHistory: AIMessage[],
  ): Promise<SummarizeResult> {
    const client = await this.getClient();
    const systemPrompt = `Summarize the customer support conversation below. Return a JSON object with:
- "summary": string — a 1-2 sentence summary
- "keyPoints": string[] — 2-4 key points from the conversation

OUTPUT ONLY THE JSON OBJECT.`;

    try {
      const response = await this.complete("omnichannel.summarize", client, {
        model: AI_MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          ...buildHistoryMessages(conversationHistory),
          { role: "user", content: "Summarize this conversation." },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = SummarizeOutputSchema.parse(parseJSON(raw));
      return parsed;
    } catch (err) {
      logger.error({ err }, "omnichannel ai: summarize failed");
      return { summary: "Conversation summary unavailable.", keyPoints: [] };
    }
  }

  async classifyIntent(
    conversationHistory: AIMessage[],
  ): Promise<ClassifyIntentResult> {
    const client = await this.getClient();
    const systemPrompt = `Classify the intent of the customer in this support conversation. Return a JSON object with:
- "intent": string — one of: greeting, order_status, refund_request, pricing_inquiry, complaint, technical_support, general_inquiry, other
- "confidence": number 0-1
- "suggestedTags": string[] — 1-3 relevant tags

OUTPUT ONLY THE JSON OBJECT.`;

    try {
      const response = await this.complete("omnichannel.classify_intent", client, {
        model: AI_MODEL,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt },
          ...buildHistoryMessages(conversationHistory),
          { role: "user", content: "Classify the customer intent." },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = ClassifyOutputSchema.parse(parseJSON(raw));
      return parsed;
    } catch (err) {
      logger.error({ err }, "omnichannel ai: classifyIntent failed");
      return { intent: "general_inquiry", confidence: 0.5, suggestedTags: [] };
    }
  }

  async suggestTags(
    conversationHistory: AIMessage[],
  ): Promise<SuggestTagsResult> {
    const client = await this.getClient();
    const systemPrompt = `Suggest 1-4 relevant tags for this support conversation. Return a JSON object with:
- "tags": string[] — short lowercase tag names

OUTPUT ONLY THE JSON OBJECT.`;

    try {
      const response = await this.complete("omnichannel.suggest_tags", client, {
        model: AI_MODEL,
        max_completion_tokens: 256,
        messages: [
          { role: "system", content: systemPrompt },
          ...buildHistoryMessages(conversationHistory),
          { role: "user", content: "Suggest tags." },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = SuggestTagsOutputSchema.parse(parseJSON(raw));
      return parsed;
    } catch (err) {
      logger.error({ err }, "omnichannel ai: suggestTags failed");
      return { tags: [] };
    }
  }

  async suggestEscalationReason(
    conversationHistory: AIMessage[],
  ): Promise<SuggestEscalationReasonResult> {
    const client = await this.getClient();
    const systemPrompt = `Analyze why this customer conversation should be escalated to a human agent. Return a JSON object with:
- "reason": string — a brief escalation reason
- "urgency": "low" | "medium" | "high"

OUTPUT ONLY THE JSON OBJECT.`;

    try {
      const response = await this.complete("omnichannel.suggest_escalation", client, {
        model: AI_MODEL,
        max_completion_tokens: 256,
        messages: [
          { role: "system", content: systemPrompt },
          ...buildHistoryMessages(conversationHistory),
          { role: "user", content: "Suggest an escalation reason." },
        ],
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = EscalationOutputSchema.parse(parseJSON(raw));
      return parsed;
    } catch (err) {
      logger.error({ err }, "omnichannel ai: suggestEscalationReason failed");
      return { reason: "Customer requires human support.", urgency: "medium" };
    }
  }
}
