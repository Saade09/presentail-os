import { useSearch } from "wouter";
import ChannelSetupLayout from "./ChannelSetupLayout";
import type { CredentialField, PermissionItem, SetupInstruction } from "./ChannelSetupLayout";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    key: "access_token",
    label: "Access Token",
    placeholder: "EAAxxxxxxx…",
    helpText: "Permanent or long-lived system user token from Meta Business Manager.",
  },
  {
    key: "external_account_id",
    label: "Phone Number ID",
    placeholder: "1234567890",
    helpText: "The numeric Phone Number ID from your WhatsApp Business Account, not the display phone number.",
  },
];

const PERMISSIONS: PermissionItem[] = [
  { label: "whatsapp_business_messaging — send and receive messages", required: true },
  { label: "whatsapp_business_management — manage phone numbers and templates", required: true },
  { label: "pages_messaging — required if using a shared inbox with Messenger", required: false },
];

const SETUP_INSTRUCTIONS: SetupInstruction[] = [
  {
    title: "Step 1 — Create a Meta Business App",
    steps: [
      "Go to developers.facebook.com and click 'My Apps' → 'Create App'.",
      "Choose 'Business' as the app type.",
      "Add the 'WhatsApp' product to your app.",
      "Under WhatsApp → Getting Started, your test number will be shown. For production, add a real number.",
    ],
  },
  {
    title: "Step 2 — Get your Phone Number ID and Access Token",
    steps: [
      "In your app dashboard, go to WhatsApp → API Setup.",
      "Copy the Phone Number ID (the numeric ID, not the display number). Paste it in the 'Phone Number ID' field above.",
      "Under 'Temporary access token', click 'Generate token' or create a long-lived system user token via Business Manager → Users → System Users.",
      "Paste the token in the 'Access Token' field above.",
    ],
  },
  {
    title: "Step 3 — Configure the Webhook",
    steps: [
      "In your app dashboard, go to WhatsApp → Configuration.",
      "Click 'Edit' next to Webhook, then paste the Webhook URL from above.",
      "Set the Verify Token to the value shown in the Webhook URL card above.",
      "Click 'Verify and Save'. The green checkmark confirms the webhook is active.",
      "Under 'Webhook fields', subscribe to: messages, message_deliveries, message_reads.",
    ],
  },
  {
    title: "Step 4 — App Review & Production Checklist",
    steps: [
      "Before going live, submit your app for Meta App Review. Required permissions are whatsapp_business_messaging and whatsapp_business_management.",
      "Set up a System User in Business Manager with admin permissions to generate a non-expiring token.",
      "Test with the sandbox number first — you can send to up to 5 verified test numbers without app review.",
      "For templates (outbound messages outside the 24-hour window), pre-register them in WhatsApp Manager and await approval.",
    ],
  },
];

export default function WhatsAppChannelPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const channelId = Number(params.get("id"));
  const { realIsOwner, loaded } = useWorkspaceRole();

  if (loaded && !realIsOwner) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle size={16} />
        Only workspace owners can manage channel connections.
      </div>
    );
  }

  if (!channelId) {
    return (
      <div className="text-sm text-muted-foreground">
        No channel selected. <Link href="/settings/channels" className="underline">Go back</Link>
      </div>
    );
  }

  return (
    <ChannelSetupLayout
      channelId={channelId}
      provider="whatsapp"
      providerLabel="WhatsApp Business"
      providerIcon="💬"
      webhookPath="/api/omnichannel/webhooks/whatsapp"
      credentialFields={CREDENTIAL_FIELDS}
      permissions={PERMISSIONS}
      setupInstructions={SETUP_INSTRUCTIONS}
    />
  );
}
