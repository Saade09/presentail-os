export class ProviderAuthError extends Error {
  readonly code = "PROVIDER_AUTH_ERROR";
  readonly retryable = false;
  constructor(
    message: string,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends Error {
  readonly code = "PROVIDER_RATE_LIMIT";
  readonly retryable = true;
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderRateLimitError";
  }
}

export class ProviderMessageWindowError extends Error {
  readonly code = "PROVIDER_MESSAGE_WINDOW";
  readonly retryable = false;
  constructor(
    message: string,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderMessageWindowError";
  }
}

export class ProviderUnsupportedMessageTypeError extends Error {
  readonly code = "PROVIDER_UNSUPPORTED_MESSAGE_TYPE";
  readonly retryable = false;
  constructor(
    message: string,
    public readonly messageType?: string,
  ) {
    super(message);
    this.name = "ProviderUnsupportedMessageTypeError";
  }
}

export class ProviderTemporaryError extends Error {
  readonly code = "PROVIDER_TEMPORARY_ERROR";
  readonly retryable = true;
  constructor(
    message: string,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderTemporaryError";
  }
}

export class ProviderPermanentError extends Error {
  readonly code = "PROVIDER_PERMANENT_ERROR";
  readonly retryable = false;
  constructor(
    message: string,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "ProviderPermanentError";
  }
}

export class WebhookVerificationError extends Error {
  readonly code = "WEBHOOK_VERIFICATION_FAILED";
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class AutomationExecutionError extends Error {
  readonly code = "AUTOMATION_EXECUTION_ERROR";
  readonly retryable = false;
  constructor(
    message: string,
    public readonly nodeId?: string,
    public readonly flowId?: number,
  ) {
    super(message);
    this.name = "AutomationExecutionError";
  }
}

export class AIProviderError extends Error {
  readonly code = "AI_PROVIDER_ERROR";
  readonly retryable = true;
  constructor(
    message: string,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
