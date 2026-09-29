import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  GscConnectionFeedback,
  GscCredentialManagementCard,
  GscCredentialsDialog,
  gscCredentialNoticeTranslationKey,
  gscOauthErrorTranslationKey,
} from "./SeoAnalytics";

const translations: Record<string, string> = {
  "seoAnalytics.searchConsole.credentialsTitle": "Google Search Console credentials",
  "seoAnalytics.searchConsole.credentialSource.workspace": "Workspace override",
  "seoAnalytics.searchConsole.credentialSource.environment": "Server configuration",
  "seoAnalytics.searchConsole.credentialSource.none": "Not configured",
  "seoAnalytics.searchConsole.errors.credential_storage_unavailable": "Credential storage is not ready yet.",
  "seoAnalytics.searchConsole.credentialsDialog.title": "Enter Google OAuth Credentials",
  "seoAnalytics.searchConsole.credentialsDialog.addButton": "Add credentials",
  "seoAnalytics.searchConsole.credentialsDialog.changeButton": "Change credentials",
  "seoAnalytics.searchConsole.credentialsDialog.clientIdLabel": "Client ID",
  "seoAnalytics.searchConsole.credentialsDialog.clientSecretLabel": "Client Secret",
  "seoAnalytics.searchConsole.credentialsDialog.clientIdPlaceholder": "Client ID",
  "seoAnalytics.searchConsole.credentialsDialog.secretPlaceholder": "Paste your Client Secret",
  "seoAnalytics.searchConsole.credentialsDialog.save": "Save credentials",
  "seoAnalytics.searchConsole.credentialsDialog.cancel": "Cancel",
  "seoAnalytics.searchConsole.credentialsDialog.clear": "Clear credentials",
  "seoAnalytics.searchConsole.credentialsDialog.requiredError": "Both fields are required.",
  "seoAnalytics.searchConsole.setupBody": "Setup body",
  "seoAnalytics.searchConsole.setupSteps": "Setup steps",
  "seoAnalytics.searchConsole.step1": "Step one",
  "seoAnalytics.searchConsole.step2": "Step two",
  "seoAnalytics.searchConsole.step3": "Step three",
  "seoAnalytics.searchConsole.step4": "Step four",
  "seoAnalytics.searchConsole.openConsole": "Open Google Cloud Console",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { clientId?: string }) => {
      if (key === "seoAnalytics.searchConsole.maskedClientId") {
        return `Client ID: ${options?.clientId ?? ""}`;
      }
      return translations[key] ?? key;
    },
  }),
}));

describe("Search Console credential management UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an environment source and lets the owner open the change dialog", () => {
    const onManage = vi.fn();

    render(
      <GscCredentialManagementCard
        status={{
          connected: false,
          enabled: true,
          siteUrl: null,
          syncStatus: null,
          lastSyncAt: null,
          lastError: null,
          credentialsSaved: false,
          credentialsFromEnv: true,
          credentialSource: "environment",
          clientId: "server…t.com",
        }}
        onManage={onManage}
      />,
    );

    expect(screen.getByText("Server configuration")).toBeInTheDocument();
    expect(screen.getByText("Client ID: server…t.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /change credentials/i }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("shows a safe recovery message when credential storage is still initializing", () => {
    render(
      <GscCredentialManagementCard
        status={{
          connected: false,
          enabled: false,
          siteUrl: null,
          syncStatus: null,
          lastSyncAt: null,
          lastError: null,
          credentialsSaved: false,
          credentialsFromEnv: true,
          credentialSource: "none",
          clientId: null,
          credentialErrorCode: "credential_storage_unavailable",
        }}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("Credential storage is not ready yet.")).toBeInTheDocument();
  });

  it("keeps both credential fields blank whenever the dialog opens", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    const onOpenChange = vi.fn();
    const props = {
      onOpenChange,
      existingClientId: "worksp…t.com",
      hasWorkspaceOverride: true,
      credentialSource: "workspace" as const,
      onSave,
      onClear: vi.fn().mockResolvedValue(null),
      saving: false,
      clearing: false,
    };

    const { rerender } = render(<GscCredentialsDialog {...props} open />);

    const clientIdInput = screen.getByLabelText("Client ID");
    const secretInput = screen.getByLabelText("Client Secret");
    expect(clientIdInput).toHaveValue("");
    expect(secretInput).toHaveValue("");
    expect(screen.getByRole("button", { name: /clear credentials/i })).toBeInTheDocument();

    fireEvent.change(clientIdInput, { target: { value: "replacement-client" } });
    fireEvent.change(secretInput, { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /save credentials/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("replacement-client", "replacement-secret");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    rerender(<GscCredentialsDialog {...props} open={false} />);
    rerender(<GscCredentialsDialog {...props} open />);

    expect(screen.getByLabelText("Client ID")).toHaveValue("");
    expect(screen.getByLabelText("Client Secret")).toHaveValue("");
    expect(screen.queryByDisplayValue("replacement-secret")).not.toBeInTheDocument();
  });

  it("does not offer clear for server credentials and keeps recoverable save errors visible", async () => {
    const onSave = vi.fn().mockResolvedValue("Localized save failure");

    render(
      <GscCredentialsDialog
        open
        onOpenChange={vi.fn()}
        existingClientId="server…t.com"
        hasWorkspaceOverride={false}
        credentialSource="environment"
        onSave={onSave}
        onClear={vi.fn().mockResolvedValue(null)}
        saving={false}
        clearing={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /clear credentials/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "replacement-client" },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "replacement-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save credentials/i }));

    expect(await screen.findByText("Localized save failure")).toBeInTheDocument();
    expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
  });

  it("maps callback failures to stable localized error keys and renders them accessibly", () => {
    expect(gscOauthErrorTranslationKey("state_mismatch")).toBe(
      "seoAnalytics.searchConsole.oauthErrors.state_mismatch",
    );
    expect(gscOauthErrorTranslationKey("unexpected_error")).toBe(
      "seoAnalytics.searchConsole.oauthErrors.callback_failed",
    );

    render(
      <GscConnectionFeedback
        error="طلب تفويض Google غير صالح أو منتهي الصلاحية."
        notice={null}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "طلب تفويض Google غير صالح أو منتهي الصلاحية.",
    );
  });

  it("explains that a credential change requires reconnecting", () => {
    expect(gscCredentialNoticeTranslationKey(true, "saved")).toBe(
      "seoAnalytics.searchConsole.reauthorizationRequired",
    );
    expect(gscCredentialNoticeTranslationKey(false, "saved")).toBe(
      "seoAnalytics.searchConsole.credentialsSaved",
    );

    render(
      <GscConnectionFeedback
        error={null}
        notice="The OAuth client changed. Connect Google Search Console again."
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Connect Google Search Console again.",
    );
  });
});