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
    helpText: "Long-lived Page Access Token from the Facebook Page connected to your Instagram Business Account.",
  },
  {
    key: "external_account_id",
    label: "Instagram Business Account ID",
    placeholder: "17841400000000000",
    helpText: "The numeric ID of your Instagram Business or Creator Account (not your username).",
  },
];

const PERMISSIONS: PermissionItem[] = [
  { label: "instagram_basic — read Instagram profile and media", required: true },
  { label: "instagram_manage_messages — read and send DMs", required: true },
  { label: "pages_show_list — access Facebook Pages linked to Instagram", required: true },
  { label: "pages_messaging — send messages via Page API", required: true },
  { label: "instagram_manage_comments — respond to comment threads", required: false },
];

const SETUP_INSTRUCTIONS: SetupInstruction[] = [
  {
    title: "Step 1 — Prerequisites",
    steps: [
      "Your Instagram account must be a Business or Creator account (not Personal). Convert in Instagram settings → Account → Switch to Professional Account.",
      "The Instagram account must be connected to a Facebook Page. Go to Instagram Settings → Account → Linked Accounts.",
      "Create a Meta Developer app at developers.facebook.com, add the 'Instagram' product.",
    ],
  },
  {
    title: "Step 2 — Get your Access Token and Account ID",
    steps: [
      "In your app dashboard, go to Instagram → Settings → Access Tokens.",
      "Select the Facebook Page connected to your Instagram account and generate a token.",
      "For the Instagram Business Account ID, call: GET https://graph.facebook.com/v18.0/me/accounts and find the Instagram Business Account ID for your page.",
      "Alternatively, find it in Meta Business Suite → Settings → Instagram Accounts → the account ID shown there.",
    ],
  },
  {
    title: "Step 3 — Configure the Webhook",
    steps: [
      "In your app dashboard, go to Instagram → Settings → Webhooks.",
      "Paste the Webhook URL from above and set the Verify Token.",
      "Subscribe to: messages, messaging_seen, messaging_referrals, mentions.",
      "In the app Subscriptions panel, also subscribe your Page to instagram events.",
    ],
  },
  {
    title: "Step 4 — App Review & Limitations",
    steps: [
      "Request Advanced Access for: instagram_basic, instagram_manage_messages, pages_messaging.",
      "Instagram DMs are subject to a 24-hour messaging window — you can only reply to messages initiated by the user in the past 24 hours.",
      "Human Agent Tag allows 7-day reply window for human-handled conversations. Available after App Review.",
      "Test in Developer Mode first (only accessible to app admins and testers).",
    ],
  },
];

export default function InstagramChannelPage() {
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
      provider="instagram"
      providerLabel="Instagram Direct"
      providerIcon="📷"
      webhookPath="/api/omnichannel/webhooks/instagram"
      credentialFields={CREDENTIAL_FIELDS}
      permissions={PERMISSIONS}
      setupInstructions={SETUP_INSTRUCTIONS}
    />
  );
}
