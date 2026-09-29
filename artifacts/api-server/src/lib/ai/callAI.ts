import type OpenAI from "openai";
import { anthropic } from "@workspace/integrations-anthropic-ai-server";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  anthropicUsage,
  openAiUsage,
  openAiResponsesUsage,
  trackAiUsage,
} from "../aiUsageRecorder.js";

export type AIProvider = "openai" | "anthropic";
export type AICredentialSource =
  | "modelfarm"
  | "provider_direct"
  | "workspace_key";

interface CommonCallAIArgs {
  actionKey: string;
  surface: string;
  model: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  orderId?: string | null;
  sessionId?: string | null;
  country?: string | null;
  wasFallback?: boolean;
  imageSize?: string | null;
  imageQuality?: string | null;
  /** True only when the client credential was loaded from workspace database storage. */
  credentialResolvedFromDatabase?: boolean;
  requestOptions?: { timeout?: number; signal?: AbortSignal };
}

type OpenAIRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type OpenAIClient = {
  baseURL?: string;
  chat: {
    completions: {
      create(
        request: OpenAIRequest,
        options?: { timeout?: number; signal?: AbortSignal },
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
  responses?: {
    create(request: OpenAI.Responses.ResponseCreateParamsNonStreaming): Promise<OpenAI.Responses.Response>;
  };
};
type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;
  system?: string | Array<Record<string, unknown>>;
  temperature?: number;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  stream?: false;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  top_k?: number;
  top_p?: number;
};
type AnthropicResponse = {
  id: string;
  content: Array<Record<string, unknown>>;
  model?: string;
  role?: "assistant";
  stop_reason?: string | null;
  stop_sequence?: string | null;
  type?: "message";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};
type OpenAIChatCallArgs = CommonCallAIArgs &
  Omit<OpenAIRequest, "model" | "messages" | "temperature" | "max_completion_tokens"> & {
    provider: "openai";
    api?: "chat";
    messages: OpenAIRequest["messages"];
    client?: OpenAIClient;
  };
type OpenAIResponsesCallArgs = CommonCallAIArgs &
  Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, "model"> & {
    provider: "openai";
    api: "responses";
    client?: OpenAIClient;
  };
type OpenAIImageCallArgs<T> = CommonCallAIArgs & {
  provider: "openai";
  api: "image";
  call: (requestOptions?: { timeout?: number; signal?: AbortSignal }) => Promise<T>;
  client?: OpenAIClient;
};
type OpenAICallArgs =
  | OpenAIChatCallArgs
  | OpenAIResponsesCallArgs
  | OpenAIImageCallArgs<unknown>;

type AnthropicClient = {
  baseURL?: string;
  messages: { create(request: AnthropicRequest): Promise<AnthropicResponse> };
};
type AnthropicCallArgs = CommonCallAIArgs &
  Omit<AnthropicRequest, "model" | "messages" | "system" | "temperature" | "max_tokens"> & {
    provider: "anthropic";
    messages: AnthropicRequest["messages"];
    client?: AnthropicClient;
  };

export type CallAIArgs = OpenAICallArgs | AnthropicCallArgs;

function classifyCredential(
  provider: AIProvider,
  client: OpenAIClient | AnthropicClient,
  credentialResolvedFromDatabase: boolean,
): AICredentialSource {
  const baseURL = client.baseURL?.toLowerCase() ?? "";
  const isModelfarm =
    baseURL.includes("modelfarm") ||
    baseURL.includes("ai-integrations.replit.com");
  if (isModelfarm) return "modelfarm";
  if (credentialResolvedFromDatabase) return "workspace_key";
  if (
    (provider === "openai" && baseURL.includes("api.openai.com")) ||
    (provider === "anthropic" && baseURL.includes("api.anthropic.com"))
  ) {
    return "provider_direct";
  }
  // Replit's local integration proxy may not expose a descriptive hostname.
  return "modelfarm";
}

export async function callAI(args: OpenAIChatCallArgs): Promise<OpenAI.Chat.Completions.ChatCompletion>;
export async function callAI(args: OpenAIResponsesCallArgs): Promise<OpenAI.Responses.Response>;
export async function callAI<T>(args: OpenAIImageCallArgs<T>): Promise<T>;
export async function callAI(args: AnthropicCallArgs): Promise<AnthropicResponse>;
export async function callAI(args: CallAIArgs): Promise<unknown> {
  if (args.provider === "openai" && args.api === "image") {
    const {
      actionKey,
      surface,
      provider,
      model,
      orderId,
      sessionId,
      country,
      wasFallback,
      imageSize,
      imageQuality,
      credentialResolvedFromDatabase = false,
      client,
      call,
      requestOptions,
    } = args;
    const resolvedClient = client ?? (openai as unknown as OpenAIClient);
    return trackAiUsage({
      actionKey,
      surface,
      provider,
      modelId: model,
      keySource: classifyCredential(provider, resolvedClient, credentialResolvedFromDatabase),
      wasFallback,
      orderId,
      sessionId,
      country,
      imageSize,
      imageQuality,
      call: () => call(requestOptions),
    });
  }
  if (args.provider === "openai" && args.api === "responses") {
    const {
      actionKey,
      surface,
      provider,
      model,
      orderId,
      sessionId,
      country,
      wasFallback,
      credentialResolvedFromDatabase = false,
      client,
      api: _api,
      ...request
    } = args;
    const resolvedClient = client ?? (openai as unknown as OpenAIClient);
    if (!resolvedClient.responses) {
      throw new Error("The configured OpenAI client does not support the Responses API");
    }
    return trackAiUsage({
      actionKey,
      surface,
      provider,
      modelId: model,
      keySource: classifyCredential(provider, resolvedClient, credentialResolvedFromDatabase),
      wasFallback,
      orderId,
      sessionId,
      country,
      tokens: openAiResponsesUsage,
      call: () => resolvedClient.responses!.create({ ...request, model }),
    });
  }
  const {
    actionKey,
    surface,
    provider,
    model,
    messages,
    system,
    maxTokens,
    temperature,
    orderId,
    sessionId,
    country,
    wasFallback,
    credentialResolvedFromDatabase = false,
    requestOptions,
    client,
    ...providerOptions
  } = args;
  const resolvedClient =
    client ??
    (provider === "anthropic"
      ? (anthropic as unknown as AnthropicClient)
      : (openai as unknown as OpenAIClient));
  const keySource = classifyCredential(
    provider,
    resolvedClient,
    credentialResolvedFromDatabase,
  );

  return trackAiUsage({
    actionKey,
    surface,
    provider,
    modelId: model,
    keySource,
    wasFallback,
    orderId,
    sessionId,
    country,
    tokens: provider === "anthropic" ? anthropicUsage : openAiUsage,
    call: async () => {
      if (provider === "anthropic") {
        const request = {
          ...providerOptions,
          model,
          messages,
          max_tokens: maxTokens ?? 8192,
          ...(system === undefined ? {} : { system }),
          ...(temperature === undefined ? {} : { temperature }),
        } as unknown as AnthropicRequest;
        return (resolvedClient as AnthropicClient).messages.create(request);
      }
      const request = {
          ...providerOptions,
          model,
          messages,
          ...(system === undefined
            ? {}
            : { messages: [{ role: "system" as const, content: system }, ...messages] }),
          ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
          ...(temperature === undefined ? {} : { temperature }),
        } as unknown as OpenAIRequest;
        const completions = (resolvedClient as OpenAIClient).chat.completions;
        return requestOptions === undefined
          ? completions.create(request)
          : completions.create(request, requestOptions);
    },
  });
}