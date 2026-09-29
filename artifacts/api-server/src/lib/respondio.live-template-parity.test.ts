import { describe, expect, it } from "vitest";
import {
  buildRespondIoWhatsAppTemplatePayload,
  type RespondIoTemplateContract,
} from "./respondio";
import { ADDRESS_COLLECTION_TEMPLATE_CONTRACT } from "./addressCollector/config";
import { RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS } from "./respondioOrderTemplates";

const CHANNEL_ID = 543704;
const TEMPLATE_NAMES = [
  "address_collection",
  "order_ready",
  "new_order_received",
  "order_delivered",
  "whishpayment",
] as const;

type TemplateName = (typeof TEMPLATE_NAMES)[number];
type LiveParameter = {
  type: string;
  text?: string;
};
type LiveButton = {
  type: string;
  text: string;
  url?: string;
  examples?: unknown[];
};
type LiveComponent = {
  type: "header" | "body" | "footer" | "buttons";
  format?: string;
  text?: string;
  examples?: LiveParameter[];
  buttons?: LiveButton[];
};
type LiveTemplate = {
  name: string;
  languageCode: string;
  channelId: number;
  status?: string;
  components: LiveComponent[];
};

const CONTRACTS: Record<TemplateName, RespondIoTemplateContract> = {
  address_collection: ADDRESS_COLLECTION_TEMPLATE_CONTRACT,
  order_ready: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
  new_order_received: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.new_order_received,
  order_delivered: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
  whishpayment: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment,
};

function runtimeBodyParameters(template: LiveTemplate): string[] {
  const body = template.components.find((component) => component.type === "body");
  return (body?.examples ?? []).map((example, index) => {
    if (example.type !== "text" || typeof example.text !== "string") {
      throw new Error(`${template.name} body example ${index + 1} is not text`);
    }
    return example.text;
  });
}

function expectedOutboundComponents(
  template: LiveTemplate,
  bodyParameters: string[],
  headerImageUrl: string | null,
) {
  return template.components.map((component) => {
    if (component.type === "header") {
      if (component.format !== "image" || !headerImageUrl) {
        throw new Error(`${template.name} has an unsupported live header definition`);
      }
      return {
        type: "header",
        format: "image",
        parameters: [{ type: "image", image: { link: headerImageUrl } }],
      };
    }
    if (component.type === "body") {
      if (typeof component.text !== "string") {
        throw new Error(`${template.name} live body text is missing`);
      }
      return {
        type: "body",
        text: component.text,
        parameters: bodyParameters.map((text) => ({ type: "text", text })),
      };
    }
    if (component.type === "footer") {
      if (typeof component.text !== "string") {
        throw new Error(`${template.name} live footer text is missing`);
      }
      return { type: "footer", text: component.text };
    }
    return {
      type: "buttons",
      buttons: (component.buttons ?? []).map((button) => ({
        type: button.type,
        text: button.text,
        ...(button.url ? { url: button.url } : {}),
      })),
    };
  });
}

// Run automatically wherever the read-only Developer API token is available.
// CI environments without provider credentials still retain the literal
// payload regressions in respondio.test.ts.
const runLiveParity =
  !!process.env.RESPONDIO_API_TOKEN ||
  process.env.RESPONDIO_LIVE_TEMPLATE_TESTS === "1";

describe.skipIf(!runLiveParity)("Respond.io live approved template parity", () => {
  it("builds all five outbound payloads from the exact approved live definitions", async () => {
    const token = process.env.RESPONDIO_API_TOKEN;
    if (!token) {
      throw new Error("RESPONDIO_API_TOKEN is required for live template parity");
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const [channelsResponse, templatesResponse] = await Promise.all([
      fetch("https://api.respond.io/v2/space/channel?limit=100", {
        headers,
        signal: AbortSignal.timeout(15_000),
      }),
      fetch(`https://api.respond.io/v2/space/channel/${CHANNEL_ID}/template?limit=100`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      }),
    ]);

    expect(channelsResponse.status).toBe(200);
    expect(templatesResponse.status).toBe(200);

    const channelsBody = (await channelsResponse.json()) as {
      items?: Array<{ id: number; source: string }>;
    };
    const templatesBody = (await templatesResponse.json()) as { items?: LiveTemplate[] };
    const channel = channelsBody.items?.find((item) => item.id === CHANNEL_ID);
    expect(channel).toEqual(expect.objectContaining({ source: "whatsapp_business" }));

    const liveTemplates = new Map(
      (templatesBody.items ?? [])
        .filter((template) => TEMPLATE_NAMES.includes(template.name as TemplateName))
        .map((template) => [template.name as TemplateName, template]),
    );
    expect([...liveTemplates.keys()].sort()).toEqual([...TEMPLATE_NAMES].sort());

    for (const templateName of TEMPLATE_NAMES) {
      const live = liveTemplates.get(templateName);
      if (!live) throw new Error(`Approved live template ${templateName} is missing`);

      expect(live.status).toBe("approved");
      expect(live.channelId).toBe(CHANNEL_ID);

      const contract = CONTRACTS[templateName];
      const bodyParameters = runtimeBodyParameters(live);
      const headerImageUrl = live.components.some((component) => component.type === "header")
        ? `https://cdn.example.com/${templateName}.png`
        : null;
      const payload = buildRespondIoWhatsAppTemplatePayload({
        contract,
        bodyParameters,
        channelId: CHANNEL_ID,
        headerImageUrl,
      });

      expect(payload).toEqual({
        channelId: CHANNEL_ID,
        message: {
          type: "whatsapp_template",
          template: {
            name: live.name,
            languageCode: live.languageCode,
            components: expectedOutboundComponents(live, bodyParameters, headerImageUrl),
          },
        },
      });
      expect(contract.bodyParameterCount).toBe(bodyParameters.length);
      expect(contract.providerComponentOrder).toEqual(
        live.components.map((component) => component.type),
      );
      expect(JSON.stringify(payload)).not.toContain('"examples"');
    }
  });
});