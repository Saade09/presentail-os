// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — AI provider interface
// ---------------------------------------------------------------------------

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
}

export interface KnowledgeBaseSnippet {
  id: number;
  title: string;
  content: string;
  category?: string | null;
}

export interface DraftReplyResult {
  draft: string;
  confidence: number;
  sources: string[];
  escalate: boolean;
}

export interface SummarizeResult {
  summary: string;
  keyPoints: string[];
}

export interface ClassifyIntentResult {
  intent: string;
  confidence: number;
  suggestedTags: string[];
}

export interface SuggestTagsResult {
  tags: string[];
}

export interface SuggestEscalationReasonResult {
  reason: string;
  urgency: "low" | "medium" | "high";
}

export interface IAIProvider {
  draftReply(
    conversationHistory: AIMessage[],
    knowledgeBase: KnowledgeBaseSnippet[],
    context?: string,
  ): Promise<DraftReplyResult>;

  summarize(
    conversationHistory: AIMessage[],
  ): Promise<SummarizeResult>;

  classifyIntent(
    conversationHistory: AIMessage[],
  ): Promise<ClassifyIntentResult>;

  suggestTags(
    conversationHistory: AIMessage[],
  ): Promise<SuggestTagsResult>;

  suggestEscalationReason(
    conversationHistory: AIMessage[],
  ): Promise<SuggestEscalationReasonResult>;
}
