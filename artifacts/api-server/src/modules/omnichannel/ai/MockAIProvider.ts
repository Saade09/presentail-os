// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — Mock AI provider (deterministic, no external calls)
// Active when no OpenAI credentials are configured.
// ---------------------------------------------------------------------------

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

export class MockAIProvider implements IAIProvider {
  async draftReply(
    conversationHistory: AIMessage[],
    knowledgeBase: KnowledgeBaseSnippet[],
    _context?: string,
  ): Promise<DraftReplyResult> {
    const lastMessage = [...conversationHistory].reverse().find((m: AIMessage) => m.role === "user");
    const hasKb = knowledgeBase.length > 0;
    const sources = hasKb ? [knowledgeBase[0].title] : [];

    return {
      draft: `Thank you for reaching out. ${lastMessage ? `I understand you mentioned: "${lastMessage.content.slice(0, 80)}". ` : ""}A member of our team will assist you shortly.`,
      confidence: 0.72,
      sources,
      escalate: false,
    };
  }

  async summarize(
    conversationHistory: AIMessage[],
  ): Promise<SummarizeResult> {
    const userMessages = conversationHistory.filter((m) => m.role === "user");
    const count = userMessages.length;

    return {
      summary: `Customer sent ${count} message${count !== 1 ? "s" : ""}. The conversation appears to be a general inquiry.`,
      keyPoints: [
        count > 0 ? `First message: "${userMessages[0].content.slice(0, 60)}"` : "No user messages yet.",
      ],
    };
  }

  async classifyIntent(
    conversationHistory: AIMessage[],
  ): Promise<ClassifyIntentResult> {
    const text = conversationHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();

    let intent = "general_inquiry";
    let suggestedTags: string[] = ["inquiry"];

    if (text.includes("order") || text.includes("delivery") || text.includes("ship")) {
      intent = "order_status";
      suggestedTags = ["order", "delivery"];
    } else if (text.includes("refund") || text.includes("return") || text.includes("cancel")) {
      intent = "refund_request";
      suggestedTags = ["refund", "returns"];
    } else if (text.includes("price") || text.includes("cost") || text.includes("discount")) {
      intent = "pricing_inquiry";
      suggestedTags = ["pricing"];
    } else if (text.includes("complaint") || text.includes("issue") || text.includes("problem")) {
      intent = "complaint";
      suggestedTags = ["complaint", "support"];
    } else if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
      intent = "greeting";
      suggestedTags = ["new_contact"];
    }

    return {
      intent,
      confidence: 0.68,
      suggestedTags,
    };
  }

  async suggestTags(
    _conversationHistory: AIMessage[],
  ): Promise<SuggestTagsResult> {
    return {
      tags: ["inquiry", "needs_review"],
    };
  }

  async suggestEscalationReason(
    conversationHistory: AIMessage[],
  ): Promise<SuggestEscalationReasonResult> {
    const text = conversationHistory
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();

    const isUrgent = text.includes("urgent") || text.includes("asap") || text.includes("immediately");

    return {
      reason: isUrgent
        ? "Customer indicated urgency — requires immediate attention."
        : "Customer requires human support beyond automated responses.",
      urgency: isUrgent ? "high" : "medium",
    };
  }
}
