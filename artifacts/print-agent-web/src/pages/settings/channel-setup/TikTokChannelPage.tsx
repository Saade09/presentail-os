import { useSearch } from "wouter";
import ChannelSetupLayout from "./ChannelSetupLayout";
import type { CredentialField, PermissionItem, SetupInstruction } from "./ChannelSetupLayout";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { AlertCircle, Info } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    key: "access_token",
    label: "Access Token",
    placeholder: "act.xxxxxxxx…",
    helpText: "OAuth access token obtained from TikTok for Business API authorization flow.",
  },
  {
    key: "refresh_token",
    label: "Refresh Token",
    placeholder: "rft.xxxxxxxx…",
    helpText: "Long-lived refresh token for obtaining new access tokens when they expire.",
  },
  {
    key: "external_account_id",
    label: "Business Account ID",
    placeholder: "7000000000000000000",
    helpText: "Your TikTok Business Account ID from the TikTok for Business dashboard.",
  },
];

const PERMISSIONS: PermissionItem[] = [
  { label: "Direct Message — read and send DMs via TikTok Business Messaging API", required: true },
  { label: "Comment Management — read and respond to comments on TikTok videos", required: false },
  { label: "Business Account Management — access account info", required: true },
];

const SETUP_INSTRUCTIONS: SetupInstruction[] = [
  {
    title: "Step 1 — TikTok for Business API Access",
    steps: [
      "⚠️ TikTok Business Messaging API requires separate approval from TikTok. Standard developer access does NOT include messaging.",
      "Apply for TikTok for Business API access at business.tiktok.com → Developer → API Access.",
      "Submit a use-case description explaining how you will use the messaging API. Approval can take 2-4 weeks.",
      "While waiting for approval, you can test with Mock Mode enabled (see the toggle below).",
    ],
  },
  {
    title: "Step 2 — Create a TikTok App",
    steps: [
      "Once approved, go to developers.tiktok.com and create a new app.",
      "Select 'Business' as the app category.",
      "Under Products, add 'Business Messaging API' (only available after API access approval).",
      "Note your App ID and App Secret from the app settings.",
    ],
  },
  {
    title: "Step 3 — Authorize and Get Tokens",
    steps: [
      "Use the TikTok OAuth flow to obtain an access token for your Business Account.",
      "The authorization URL is: https://business-api.tiktok.com/portal/auth?app_id=YOUR_APP_ID&redirect_uri=YOUR_URI",
      "After authorization, exchange the code for access_token and refresh_token.",
      "Copy both tokens and paste them in the fields above.",
    ],
  },
  {
    title: "Step 4 — Configure the Webhook",
    steps: [
      "In your TikTok app dashboard, go to 'Webhooks' and add the Webhook URL from above.",
      "TikTok does not use a verify token — authentication is handled via HMAC signature on each event.",
      "Subscribe to: direct_message.received, direct_message.status events.",
      "Note: TikTok webhook events are limited to Business Accounts and require active API access approval.",
    ],
  },
];

function TikTokStatusNote() {
  const [mockMode, setMockMode] = useState(
    () => localStorage.getItem("tiktok_mock_mode") === "true",
  );

  const toggle = () => {
    const next = !mockMode;
    setMockMode(next);
    localStorage.setItem("tiktok_mock_mode", String(next));
  };

  return (
    <div className="space-y-3 mt-2">
      <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm">
        <Info size={15} className="text-yellow-700 mt-0.5 shrink-0" />
        <div className="text-yellow-800">
          <p className="font-medium">TikTok API access requires separate approval</p>
          <p className="text-xs mt-0.5">
            The TikTok Business Messaging API is not publicly available. You must apply for access through TikTok for Business before this channel can receive real messages.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Mock Mode</p>
          <p className="text-xs text-muted-foreground">Simulates TikTok events for development and testing.</p>
        </div>
        <button
          type="button"
          onClick={toggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            mockMode ? "bg-primary" : "bg-muted-foreground/30"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              mockMode ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {mockMode && (
        <Badge className="bg-blue-100 text-blue-800 border-blue-200">Mock Mode Active — TikTok events are simulated</Badge>
      )}
    </div>
  );
}

export default function TikTokChannelPage() {
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
      provider="tiktok"
      providerLabel="TikTok Business"
      providerIcon="🎵"
      webhookPath="/api/omnichannel/webhooks/tiktok"
      credentialFields={CREDENTIAL_FIELDS}
      permissions={PERMISSIONS}
      setupInstructions={SETUP_INSTRUCTIONS}
      extraStatusNote={<TikTokStatusNote />}
    />
  );
}
