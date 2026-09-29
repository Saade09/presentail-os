import { useSearch } from "wouter";
import ChannelSetupLayout from "./ChannelSetupLayout";
import type { CredentialField, PermissionItem, SetupInstruction } from "./ChannelSetupLayout";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    key: "access_token",
    label: "Page Access Token",
    placeholder: "EAAxxxxxxx…",
    helpText: "Long-lived Page Access Token from your Facebook Page connected to your app.",
  },
  {
    key: "external_account_id",
    label: "Page ID",
    placeholder: "123456789",
    helpText: "Numeric ID of the Facebook Page you want to receive Messenger messages from.",
  },
];

const PERMISSIONS: PermissionItem[] = [
  { label: "pages_messaging — send and receive Messenger messages", required: true },
  { label: "pages_read_engagement — read page engagement data", required: true },
  { label: "pages_manage_metadata — subscribe to page webhook events", required: true },
  { label: "pages_show_list — verify page access", required: false },
];

const SETUP_INSTRUCTIONS: SetupInstruction[] = [
  {
    title: "Step 1 — Create a Meta Business App",
    steps: [
      "Go to developers.facebook.com and click 'My Apps' → 'Create App'.",
      "Choose 'Business' as the app type and add the 'Messenger' product.",
      "Under Messenger → Settings, link a Facebook Page to your app.",
    ],
  },
  {
    title: "Step 2 — Get your Page Access Token",
    steps: [
      "In your app dashboard, go to Messenger → Settings → Access Tokens.",
      "Select your page and click 'Generate Token'. Copy this token and paste it above.",
      "For production, generate a long-lived token via the Graph API: GET /oauth/access_token?grant_type=fb_exchange_token",
      "Copy your Page ID from the Page's 'About' section or Facebook Business Manager.",
    ],
  },
  {
    title: "Step 3 — Configure the Webhook",
    steps: [
      "In your app dashboard, go to Messenger → Settings → Webhooks.",
      "Click 'Add Callback URL' and paste the Webhook URL from above.",
      "Set the Verify Token to the value shown in the Webhook URL card above.",
      "Subscribe to these fields: messages, messaging_postbacks, messaging_referrals.",
      "Under Messenger → Settings → Subscriptions, subscribe your page to the webhook.",
    ],
  },
  {
    title: "Step 4 — App Review & Production Checklist",
    steps: [
      "Submit for App Review requesting: pages_messaging, pages_read_engagement, pages_manage_metadata.",
      "For the 24-hour messaging window: only respond to user-initiated messages within 24 hours. Use Message Tags for special cases.",
      "Test with yourself using the Developer mode — no App Review required for testing.",
      "In production, ensure your app privacy policy URL is set in App Settings.",
    ],
  },
];

export default function MessengerChannelPage() {
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
      provider="messenger"
      providerLabel="Facebook Messenger"
      providerIcon="💙"
      webhookPath="/api/omnichannel/webhooks/messenger"
      credentialFields={CREDENTIAL_FIELDS}
      permissions={PERMISSIONS}
      setupInstructions={SETUP_INSTRUCTIONS}
    />
  );
}
