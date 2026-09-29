/**
 * Controlled Respond.io template smoke check (developer-only).
 *
 * Audit the configured WhatsApp channel without sending:
 *   pnpm exec tsx scripts/respondio-smoke.ts
 *
 * Send each approved order/payment template to an explicitly designated
 * sandbox contact only:
 *   RESPONDIO_SMOKE_SANDBOX_CONTACT_ID=<sandbox-id> RESPONDIO_SMOKE_SEND=1 \
 *     pnpm exec tsx scripts/respondio-smoke.ts
 *
 * Never point RESPONDIO_SMOKE_SANDBOX_CONTACT_ID at a customer. A successful
 * send means Respond.io accepted the request; inspect the sandbox conversation
 * in Respond.io for rendering, then use delivery-status events for delivery.
 */
import {
  isRespondIoEnabled,
  sendWhatsAppTemplateToContact,
  type RespondIoTemplateContract,
} from "../src/lib/respondio";
import {
  buildOrderPaymentTemplateSendOptions,
  RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS,
  selectedRespondIoWhatsAppChannelId,
  type RespondIoOrderPaymentTemplateName,
} from "../src/lib/respondioOrderTemplates";

const RESPONDIO_BASE_URL = "https://api.respond.io/v2";

type ProviderTemplate = {
  name?: string;
  languageCode?: string;
  status?: string;
  channelId?: number;
  components?: Array<{
    type?: string;
    format?: string;
    text?: string;
    buttons?: Array<{ type?: string; text?: string }>;
  }>;
};

const SMOKE_VALUES: Record<RespondIoOrderPaymentTemplateName, string[]> = {
  new_order_received: ["Smoke", "TEST-1", "20 August 2026", "4:00 PM–7:00 PM"],
  order_ready: ["Smoke", "TEST-1"],
  order_delivered: [],
  whishpayment: ["Smoke Test", "USD", "90.00"],
};

function placeholderIndexes(text: string | undefined): number[] {
  return [...(text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
}

function normalizedProviderValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function contractMismatch(
  providerTemplate: ProviderTemplate | undefined,
  contract: RespondIoTemplateContract,
  channelId: number,
): string | null {
  if (!providerTemplate) return "template is not listed on the configured WhatsApp channel";
  if (providerTemplate.status?.toLowerCase() !== "approved") return "template is not approved";
  if (providerTemplate.channelId !== channelId) return "template belongs to a different channel";
  if (providerTemplate.languageCode !== contract.languageCode) return "approved language differs";

  const components = providerTemplate.components ?? [];
  if (
    components.length !== contract.providerComponentOrder.length ||
    components.some(
      (component, index) =>
        normalizedProviderValue(component.type) !== contract.providerComponentOrder[index],
    )
  ) {
    return `component sequence differs (expected ${contract.providerComponentOrder.join(" → ")})`;
  }
  const header = components.find((component) => normalizedProviderValue(component.type) === "header");
  if (contract.requiresImageHeader && normalizedProviderValue(header?.format) !== "image") {
    return "required image header differs";
  }
  if (!contract.requiresImageHeader && header) return "unexpected provider header";

  const body = components.find((component) => normalizedProviderValue(component.type) === "body");
  if (!body) return "required body component is missing";
  if (contract.staticBodyText != null && body.text !== contract.staticBodyText) {
    return "approved static body text differs";
  }
  const placeholders = placeholderIndexes(body.text);
  const expectedIndexes = Array.from({ length: contract.bodyParameterCount }, (_, index) => index + 1);
  if (
    placeholders.length !== expectedIndexes.length ||
    placeholders.some((placeholder, index) => placeholder !== expectedIndexes[index])
  ) {
    return `body placeholders differ (expected ${contract.bodyParameterCount} positional values)`;
  }
  if (contract.staticFooterText != null) {
    const footer = components.find((component) => normalizedProviderValue(component.type) === "footer");
    if (footer?.text !== contract.staticFooterText) return "approved footer text differs";
  }
  if (contract.staticButtons != null) {
    const providerButtons = components.find(
      (component) => normalizedProviderValue(component.type) === "buttons",
    )?.buttons ?? [];
    if (
      providerButtons.length !== contract.staticButtons.length ||
      providerButtons.some(
        (button, index) =>
          normalizedProviderValue(button.type) !== contract.staticButtons?.[index]?.type ||
          button.text !== contract.staticButtons?.[index]?.text,
      )
    ) {
      return "approved review button differs";
    }
  }
  return null;
}

async function listChannelTemplates(channelId: number): Promise<ProviderTemplate[] | null> {
  const token = process.env.RESPONDIO_API_TOKEN;
  if (!token) return null;
  const response = await fetch(
    `${RESPONDIO_BASE_URL}/space/channel/${encodeURIComponent(String(channelId))}/template?limit=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    console.error(`Template audit failed: Respond.io returned HTTP ${response.status}.`);
    return null;
  }
  const json = (await response.json().catch(() => null)) as { items?: ProviderTemplate[] } | null;
  return Array.isArray(json?.items) ? json.items : null;
}

async function hasSandboxTag(contactId: string, requiredTag: string): Promise<boolean> {
  const token = process.env.RESPONDIO_API_TOKEN;
  if (!token) return false;
  const response = await fetch(
    `${RESPONDIO_BASE_URL}/contact/${encodeURIComponent(`id:${contactId}`)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) return false;
  const json = (await response.json().catch(() => null)) as
    | { tags?: unknown; data?: { tags?: unknown }; contact?: { tags?: unknown } }
    | null;
  const tags = Array.isArray(json?.tags)
    ? json.tags
    : Array.isArray(json?.data?.tags)
      ? json.data.tags
      : Array.isArray(json?.contact?.tags)
        ? json.contact.tags
      : [];
  return tags.some((tag) => {
    const tagName =
      typeof tag === "string"
        ? tag
        : tag && typeof tag === "object" && "name" in tag && typeof tag.name === "string"
          ? tag.name
          : null;
    return tagName?.trim().toLowerCase() === requiredTag.trim().toLowerCase();
  });
}

async function main() {
  if (!isRespondIoEnabled()) {
    console.error("Smoke check blocked: RESPONDIO_API_TOKEN is not configured.");
    process.exitCode = 1;
    return;
  }
  const channelId = selectedRespondIoWhatsAppChannelId();
  if (!channelId) {
    console.error("Smoke check blocked: RESPONDIO_CHANNEL_ID must be the selected WhatsApp channel ID.");
    process.exitCode = 1;
    return;
  }

  const providerTemplates = await listChannelTemplates(channelId);
  if (!providerTemplates) {
    process.exitCode = 1;
    return;
  }

  let contractFailed = false;
  for (const [templateName, contract] of Object.entries(RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS) as [
    RespondIoOrderPaymentTemplateName,
    RespondIoTemplateContract,
  ][]) {
    const mismatch = contractMismatch(
      providerTemplates.find((providerTemplate) => providerTemplate.name === templateName),
      contract,
      channelId,
    );
    if (mismatch) {
      contractFailed = true;
      console.error(`Contract check failed for ${templateName}: ${mismatch}.`);
    } else {
      console.log(`Contract check passed for ${templateName}.`);
    }
  }
  if (contractFailed) {
    console.error("No messages were sent because the provider template audit did not pass.");
    process.exitCode = 1;
    return;
  }

  if (process.env.RESPONDIO_SMOKE_SEND !== "1") {
    console.log("Audit complete. Set RESPONDIO_SMOKE_SEND=1 with a sandbox contact ID to send.");
    return;
  }
  const sandboxContactId = process.env.RESPONDIO_SMOKE_SANDBOX_CONTACT_ID?.trim();
  const sandboxTag = process.env.RESPONDIO_SMOKE_SANDBOX_TAG?.trim();
  if (!sandboxContactId || !sandboxTag) {
    console.error(
      "Smoke send blocked: RESPONDIO_SMOKE_SANDBOX_CONTACT_ID and RESPONDIO_SMOKE_SANDBOX_TAG are required.",
    );
    process.exitCode = 1;
    return;
  }
  if (!(await hasSandboxTag(sandboxContactId, sandboxTag))) {
    console.error("Smoke send blocked: configured contact is not marked as the designated sandbox.");
    process.exitCode = 1;
    return;
  }

  let sendFailed = false;
  for (const templateName of Object.keys(
    RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS,
  ) as RespondIoOrderPaymentTemplateName[]) {
    const result = await sendWhatsAppTemplateToContact(
      sandboxContactId,
      buildOrderPaymentTemplateSendOptions(templateName, SMOKE_VALUES[templateName]),
    );
    if (result.ok) {
      console.log(`Respond.io accepted ${templateName}.`);
    } else {
      sendFailed = true;
      console.error(`Respond.io rejected ${templateName}: ${result.errorCode} (${result.errorMessage}).`);
    }
  }
  if (sendFailed) process.exitCode = 1;
}

main().catch(() => {
  console.error("Smoke check failed unexpectedly.");
  process.exitCode = 1;
});