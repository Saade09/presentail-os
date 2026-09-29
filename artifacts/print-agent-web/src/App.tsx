import { useEffect, useRef, useState, lazy, Suspense, useCallback, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import {
  ClerkProvider,
  Show,
  useClerk,
  useUser,
  useAuth,
  HandleSSOCallback,
} from "@clerk/react";

import CustomSignIn from "@/pages/SignIn";
import { shadcn } from "@clerk/themes";
import {
  Switch,
  Route,
  Redirect,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import { QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
import { queryClient, apiFetch } from "@/lib/queryClient";
import {
  dashboardStartupRetryDelay,
  retryDashboardStartup,
} from "@/lib/dashboardBootstrapRetry";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useTypeAssignment } from "@/hooks/use-type-assignment";
import { AuthLoadingRecovery } from "@/components/AuthLoadingRecovery";
import { getDashboardLanding } from "@/post-login-routes";
import { hasChannelsAccess, hasCmcPosDashboardAccess, hasCmcPosNewOrderAccess, hasCmcPosSubAccess, hasFloristOrdersAccess } from "@/pages/dashboard/nav";
import { hasBrandsAccess } from "@/lib/pageAccess";
import { SimulatedRoleProvider } from "@/contexts/simulated-role-context";
import { PageTitleProvider } from "@/hooks/use-page-title";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner";
import { Loader2 } from "lucide-react";
import { useTranslation as useI18nTranslation } from "react-i18next";

function PageLoader() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center">
      <Spinner className="size-8 text-primary" />
    </div>
  );
}

function LoadingRecovery({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center"
      role="alert"
      data-testid="dashboard-loading-recovery"
    >
      <div className="max-w-md space-y-2">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button type="button" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </div>
  );
}

const NotFound = lazy(() => import("@/pages/not-found"));
const UnauthorizedPage = lazy(() => import("@/pages/Unauthorized"));
const Home = lazy(() => import("@/pages/Home"));
const ConnectPage = lazy(() => import("@/pages/Connect"));
const DashboardLayout = lazy(() => import("@/pages/dashboard/Layout"));
const DevicesPage = lazy(() => import("@/pages/dashboard/Devices"));
const ApiKeysPage = lazy(() => import("@/pages/dashboard/ApiKeys"));
const DownloadsPage = lazy(() => import("@/pages/dashboard/Downloads"));
const PrintHistoryPage = lazy(() => import("@/pages/dashboard/PrintHistory"));
const StickersPage = lazy(() => import("@/pages/dashboard/Stickers"));
const BrandStickerSheetsPage = lazy(() => import("@/pages/dashboard/BrandStickerSheets"));
const UsersPage = lazy(() => import("@/pages/dashboard/Users"));
const ApiDocsPage = lazy(() => import("@/pages/dashboard/ApiDocs"));
const PublishPage = lazy(() => import("@/pages/dashboard/Publish"));
const AnalyticsPage = lazy(() => import("@/pages/dashboard/Analytics"));
const StoreAnalyticsPage = lazy(() => import("@/pages/dashboard/StoreAnalytics"));
const CartCheckoutAnalyticsPage = lazy(() => import("@/pages/dashboard/CartCheckoutAnalytics"));
const OperationsAnalyticsPage = lazy(() => import("@/pages/dashboard/OperationsAnalytics"));
const CustomerAnalyticsPage = lazy(() => import("@/pages/dashboard/CustomerAnalytics"));
const MarketingAnalyticsPage = lazy(() => import("@/pages/dashboard/MarketingAnalytics"));
const SeoAnalyticsPage = lazy(() => import("@/pages/dashboard/SeoAnalytics"));
const DeliveryAnalyticsPage = lazy(() => import("@/pages/dashboard/DeliveryAnalytics"));
const SearchDiscoveryAnalyticsPage = lazy(() => import("@/pages/dashboard/SearchDiscoveryAnalytics"));
const InventoryCogsAnalyticsPage = lazy(() => import("@/pages/dashboard/InventoryCogsAnalytics"));
const MarketplaceAnalyticsPage = lazy(() => import("@/pages/dashboard/MarketplaceAnalytics"));
const SettingsPage = lazy(() => import("@/pages/dashboard/Settings"));
const LocationsPage = lazy(() => import("@/pages/dashboard/Locations"));
const CitiesPage = lazy(() => import("@/pages/dashboard/Cities"));
const LocationDetailPage = lazy(() => import("@/pages/dashboard/LocationDetail"));
const BrandsPage = lazy(() => import("@/pages/dashboard/Brands"));
const BrandDetailPage = lazy(() => import("@/pages/dashboard/BrandDetail"));
const ProductsPage = lazy(() => import("@/pages/dashboard/Products"));
const ProductDetailPage = lazy(() => import("@/pages/dashboard/ProductDetail"));
const EventsPage = lazy(() => import("@/pages/dashboard/Events"));
const RolesPage = lazy(() => import("@/pages/dashboard/Roles"));
const NoAccessPage = lazy(() => import("@/pages/NoAccess"));
const ProfilePage = lazy(() => import("@/pages/dashboard/Profile"));
const MemberProfilePage = lazy(() => import("@/pages/dashboard/MemberProfile"));
const JoinPage = lazy(() => import("@/pages/Join"));
const PaymentLinksPage = lazy(() => import("@/pages/dashboard/PaymentLinks"));
const CouponsPage = lazy(() => import("@/pages/dashboard/Coupons"));
const ChannelsPage = lazy(() => import("@/pages/dashboard/Channels"));
const ChannelDetailPage = lazy(() => import("@/pages/dashboard/ChannelDetail"));
const PayPage = lazy(() => import("@/pages/Pay"));
const AddressCollectPage = lazy(() => import("@/pages/AddressCollectPage"));
const AddressCollectorPage = lazy(() => import("@/pages/AddressCollectorPage"));
const ProjectManagerDashboardPage = lazy(() => import("@/pages/dashboard/ProjectManagerDashboard"));
const OperationsDashboardPage = lazy(() => import("@/pages/dashboard/OperationsDashboard"));
const BaseItemsPage = lazy(() => import("@/pages/dashboard/BaseItems"));
const BaseItemDetailPage = lazy(() => import("@/pages/dashboard/BaseItemDetail"));
const BaseItemCategoriesPage = lazy(() => import("@/pages/dashboard/BaseItemCategories"));
const CashDrawersPage = lazy(() => import("@/pages/dashboard/CashDrawers"));
const CashSessionsPage = lazy(() => import("@/pages/dashboard/CashSessions"));
const CashTransfersPage = lazy(() => import("@/pages/dashboard/CashTransfers"));
const CashTransferDetailPage = lazy(() =>
  import("@/pages/dashboard/TransferDetailPanel").then((m) => ({ default: m.TransferDetailPage })),
);
const CashSessionOpenPage = lazy(() => import("@/pages/dashboard/CashSessionOpen"));
const CashSessionClosePage = lazy(() => import("@/pages/dashboard/CashSessionClose"));
const CashSessionDetailPage = lazy(() => import("@/pages/dashboard/CashSessionDetail"));
const CashApprovalsPage = lazy(() => import("@/pages/dashboard/CashApprovals"));
const CashBillsPage = lazy(() => import("@/pages/dashboard/CashBills"));
const SuppliersPage = lazy(() => import("@/pages/dashboard/Suppliers"));
const SupplierDetailPage = lazy(() => import("@/pages/dashboard/SupplierDetail"));
const SupplierCatalogItemDetailPage = lazy(() => import("@/pages/dashboard/SupplierCatalogItemDetail"));
const SupplierReorderPage = lazy(() => import("@/pages/dashboard/SupplierReorder"));
const SupplierStatementsPage = lazy(() => import("@/pages/dashboard/SupplierStatements"));
const PurchaseOrdersPage = lazy(() => import("@/pages/dashboard/PurchaseOrders"));
const PurchaseOrderDetailPage = lazy(() => import("@/pages/dashboard/PurchaseOrderDetail"));
const SupplierAcceptPage = lazy(() => import("@/pages/SupplierAccept"));
const TimeOffMyPage = lazy(() => import("@/pages/dashboard/TimeOffMyPage"));
const FleetPage = lazy(() => import("@/pages/dashboard/Fleet"));
const FleetVehicleTypesPage = lazy(() => import("@/pages/dashboard/FleetVehicleTypes"));
const FleetDriverDetailPage = lazy(() => import("@/pages/dashboard/FleetDriverDetail"));
const CustomersPage = lazy(() => import("@/pages/dashboard/Customers"));

const AudiencesPage = lazy(() => import("@/pages/dashboard/audiences/AudiencesPage"));
const CustomerProfilePage = lazy(() => import("@/pages/dashboard/CustomerProfile"));
const CrmContactProfilePage = lazy(() => import("@/pages/dashboard/ContactProfile"));
const HomepageBannersPage = lazy(() => import("@/pages/dashboard/HomepageBanners"));
const TimeOffApprovalsPage = lazy(() => import("@/pages/dashboard/TimeOffApprovalsPage"));
const TimeOffCalendarPage = lazy(() => import("@/pages/dashboard/TimeOffCalendarPage"));
const TimeOffPoliciesPage = lazy(() => import("@/pages/dashboard/admin/TimeOffPoliciesPage"));
const PublicHolidaysPage = lazy(() => import("@/pages/dashboard/admin/PublicHolidaysPage"));
const TeamMembersPage = lazy(() => import("@/pages/dashboard/people/TeamMembersPage"));
const TeamMemberDetailPage = lazy(() => import("@/pages/dashboard/people/TeamMemberDetailPage"));
const PeopleDirectoryPage = lazy(() => import("@/pages/dashboard/people/PeopleDirectoryPage"));
const PersonProfilePage = lazy(() => import("@/pages/dashboard/people/PersonProfilePage"));
const InvitesAccessPage = lazy(() => import("@/pages/dashboard/people/InvitesAccessPage"));
const AttendancePage = lazy(() => import("@/pages/dashboard/people/AttendancePage"));
const AttendanceMyPage = lazy(() => import("@/pages/dashboard/AttendanceMyPage"));
const AttendanceManagerPage = lazy(() => import("@/pages/dashboard/AttendanceManagerPage"));
const AttendanceCorrectionRequestsPage = lazy(() => import("@/pages/dashboard/AttendanceCorrectionRequestsPage"));
const WorkSchedulesPage = lazy(() => import("@/pages/dashboard/people/WorkSchedulesPage"));
const AttendanceSettingsPage = lazy(() => import("@/pages/dashboard/people/AttendanceSettingsPage"));
const BlackoutDatesPage = lazy(() => import("@/pages/dashboard/admin/BlackoutDatesPage"));
const BudgetPlannerPage = lazy(() => import("@/pages/dashboard/BudgetPlanner"));
const MarketingBudgetPlannerPage = lazy(() => import("@/pages/dashboard/MarketingBudgetPlannerPage"));
const MarketingBudgetDetailPage = lazy(() => import("@/pages/dashboard/MarketingBudgetDetailPage"));
const OccasionCampaignCalendarPage = lazy(() => import("@/pages/dashboard/OccasionCampaignCalendarPage"));
const OccasionDetailPage = lazy(() => import("@/pages/dashboard/OccasionDetailPage"));
const OccasionCampaignCreateEditPage = lazy(() => import("@/pages/dashboard/OccasionCampaignCreateEditPage"));
const OccasionCampaignPlanDetailPage = lazy(() => import("@/pages/dashboard/OccasionCampaignPlanDetailPage"));
const AiInvoiceImportPage = lazy(() => import("@/pages/dashboard/AiInvoiceImport"));
const AiInvoiceReviewPage = lazy(() => import("@/pages/dashboard/AiInvoiceReview"));
const OccasionsPage = lazy(() => import("@/pages/dashboard/catalogAttributes/OccasionsPage"));
const CatalogCategoriesPage = lazy(() => import("@/pages/dashboard/catalogAttributes/CatalogCategoriesPage"));
const UpsellPage = lazy(() => import("@/pages/dashboard/Upsell"));
const CatalogBrandsPage = lazy(() => import("@/pages/dashboard/catalogAttributes/CatalogBrandsPage"));
const RecipientsPage = lazy(() => import("@/pages/dashboard/catalogAttributes/RecipientsPage"));
const WebhookEndpointsPage = lazy(() => import("@/pages/dashboard/WebhookEndpoints"));
const TaxRulesPage = lazy(() => import("@/pages/dashboard/TaxRules"));
const SmokeTestRunsPage = lazy(() => import("@/pages/dashboard/SmokeTestRuns"));
const OrdersPage = lazy(() => import("@/pages/dashboard/Orders"));
const FloristOrdersPage = lazy(() => import("@/pages/dashboard/FloristOrders"));
const OrderDetailPage = lazy(() => import("@/pages/dashboard/OrderDetail"));
const InboxPage = lazy(() => import("@/pages/omnichannel/InboxPage"));
const OmnichannelIndexRedirect = lazy(() =>
  import("@/pages/omnichannel/InboxPage").then((m) => ({
    default: m.OmnichannelIndexRedirect,
  })),
);
const AutomationsPage = lazy(() => import("@/pages/omnichannel/AutomationsPage"));
const FlowBuilderPage = lazy(() => import("@/pages/omnichannel/FlowBuilderPage"));
const TemplatesPage = lazy(() => import("@/pages/omnichannel/TemplatesPage"));
const OmnichannelAnalyticsPage = lazy(() => import("@/pages/omnichannel/OmnichannelAnalyticsPage"));
const ContactsPage = lazy(() => import("@/pages/omnichannel/ContactsPage"));
const ContactProfilePage = lazy(() => import("@/pages/omnichannel/ContactProfilePage"));
const AuditLogPage = lazy(() => import("@/pages/omnichannel/AuditLogPage"));
const ChannelsSettingsPage = lazy(() => import("@/pages/settings/ChannelsPage"));
const InvoiceScannersPage = lazy(() => import("@/pages/settings/InvoiceScanners"));
const WhatsAppChannelPage = lazy(() => import("@/pages/settings/channel-setup/WhatsAppChannelPage"));
const MessengerChannelPage = lazy(() => import("@/pages/settings/channel-setup/MessengerChannelPage"));
const InstagramChannelPage = lazy(() => import("@/pages/settings/channel-setup/InstagramChannelPage"));
const TikTokChannelPage = lazy(() => import("@/pages/settings/channel-setup/TikTokChannelPage"));
const PublishingChannelsPage = lazy(() => import("@/pages/dashboard/PublishingChannels"));
const PublishingChannelDetailPage = lazy(() => import("@/pages/dashboard/PublishingChannelDetail"));
const DeveloperPage = lazy(() => import("@/pages/dashboard/Developer"));
const GoogleProductPostPage = lazy(() => import("@/pages/dashboard/GoogleProductPost"));
const CardMessageFormPage = lazy(() => import("@/pages/dashboard/CardMessageForm"));
const InvoicesPage = lazy(() => import("@/pages/dashboard/Invoices"));
const CmcPosPage = lazy(() => import("@/pages/dashboard/CmcPos"));
const CmcPosSalePage = lazy(() => import("@/pages/dashboard/CmcPosSale"));
const CmcPosRequestPage = lazy(() => import("@/pages/dashboard/CmcPosRequest"));
const CmcPosDeliveryPage = lazy(() => import("@/pages/dashboard/CmcPosDelivery"));
const CmcPosLocationRequestsPage = lazy(() => import("@/pages/dashboard/CmcPosLocationRequests"));
const CmcPosRequestDetailPage = lazy(() => import("@/pages/dashboard/CmcPosRequestDetail"));
const CmcPosSalesHistoryPage = lazy(() => import("@/pages/dashboard/CmcPosSalesHistory"));
const CmcPosAuditPage = lazy(() => import("@/pages/dashboard/CmcPosAudit"));
const CmcPosSalesPage = lazy(() => import("@/pages/dashboard/CmcPosSalesPage"));
const CmcPosMonthlySalesPage = lazy(() => import("@/pages/dashboard/CmcPosMonthlySales"));
const CmcPosReturnsPage = lazy(() => import("@/pages/dashboard/CmcPosReturns"));
const CmcPosReturnsHistoryPage = lazy(() => import("@/pages/dashboard/CmcPosReturnsHistory"));

const CmcPosNewOrderPage = lazy(() => import("@/pages/dashboard/CmcPosNewOrderPage"));

const CmcPosCashDrawerPage = lazy(() => import("@/pages/dashboard/CmcPosCashDrawerPage"));
const MonthlySalesPage = lazy(() => import("@/pages/dashboard/MonthlySales"));

const CashActivityPage = lazy(() => import("@/pages/dashboard/CashActivity"));
const SupplierReconciliationWorkspacePage = lazy(() => import("@/pages/dashboard/SupplierReconciliationWorkspace"));
const JournalEntriesPage = lazy(() => import("@/pages/dashboard/JournalEntries"));
const AccountingReconciliationPage = lazy(() => import("@/pages/dashboard/AccountingReconciliation"));
const ReviewBankStatementPage = lazy(() => import("@/pages/dashboard/ReviewBankStatement"));
const ChartOfAccountsPage = lazy(() => import("@/pages/dashboard/ChartOfAccounts"));
const AccountingReportsPage = lazy(() => import("@/pages/dashboard/AccountingReports"));
const AddressBookPage = lazy(() => import("@/pages/dashboard/AddressBook"));

const PlaceDetailPage = lazy(() => import("@/pages/dashboard/AddressBook/PlaceDetailPage"));
const BacklinkEngineOverviewPage = lazy(() => import("@/pages/dashboard/BacklinkEngineOverview"));
const BacklinkEngineOpportunitiesPage = lazy(() => import("@/pages/dashboard/BacklinkEngineOpportunities"));
const BacklinkEngineCompetitorsPage = lazy(() => import("@/pages/dashboard/BacklinkEngineCompetitors"));
const BacklinkEngineCampaignsPage = lazy(() => import("@/pages/dashboard/BacklinkEngineCampaigns"));
const BacklinkEngineMonitorPage = lazy(() => import("@/pages/dashboard/BacklinkEngineMonitor"));
const BacklinkEngineReportsPage = lazy(() => import("@/pages/dashboard/BacklinkEngineReports"));
const BacklinkEngineSettingsPage = lazy(() => import("@/pages/dashboard/BacklinkEngineSettings"));

const ReviewRewardsPage = lazy(() => import("@/pages/dashboard/ReviewRewards"));
const RecipeReviewPage = lazy(() => import("@/pages/dashboard/RecipeReview"));
const RecipeBenchmarksPage = lazy(() => import("@/pages/dashboard/RecipeBenchmarks"));
const BloomprintDashboard = lazy(() => import("@/pages/bloomprint/BloomprintDashboard"));
const BloomprintDraftDetail = lazy(() => import("@/pages/bloomprint/BloomprintDraftDetail"));

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!clerkPublishableKey) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is required",
  );
}

// Proxy mode is DISABLED (vite.config defines this as undefined in every
// environment). Clerk talks directly to the FAPI encoded in the publishable key:
// clerk.presentail.com in prod, the .clerk.accounts.dev domain in dev. The Clerk
// instance rejects proxy-mode requests, so do not reintroduce a proxy URL here.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const INVITE_TOKEN_KEY = "presentail_invite_token";

function JoinSSOCallback() {
  const token = sessionStorage.getItem(INVITE_TOKEN_KEY);
  const afterUrl = token
    ? `${basePath}/join?token=${encodeURIComponent(token)}`
    : `${basePath}/sign-in`;
  return (
    <HandleSSOCallback
      navigateToApp={() => {
        window.location.href = afterUrl;
      }}
      navigateToSignIn={() => {
        window.location.href = `${basePath}/sign-in`;
      }}
      navigateToSignUp={() => {
        window.location.href = `${basePath}/join`;
      }}
    />
  );
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl:
      typeof window !== "undefined"
        ? `${window.location.origin}${basePath}/logo.svg`
        : "/logo.svg",
  },
  variables: {
    colorPrimary: "hsl(210, 100%, 45%)",
    colorForeground: "hsl(220, 40%, 10%)",
    colorMutedForeground: "hsl(220, 20%, 40%)",
    colorDanger: "hsl(0, 84%, 60%)",
    colorBackground: "hsl(0, 0%, 100%)",
    colorInput: "hsl(0, 0%, 100%)",
    colorInputForeground: "hsl(220, 40%, 10%)",
    colorNeutral: "hsl(220, 15%, 90%)",
    fontFamily: "Inter, system-ui, sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox:
      "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-2xl font-bold text-foreground",
    headerSubtitle: "text-sm text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground font-medium",
    formFieldLabel: "text-foreground font-medium text-sm",
    footerActionLink: "text-primary font-medium hover:underline",
    footerActionText: "text-muted-foreground text-sm",
    dividerText: "text-muted-foreground text-xs",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-foreground text-sm",
    alertText: "text-foreground text-sm",
    logoBox: "flex justify-center mb-2",
    logoImage: "h-12 w-12",
    socialButtonsBlockButton: "border border-border hover:bg-secondary",
    formButtonPrimary:
      "bg-primary hover:bg-primary/90 text-primary-foreground font-medium",
    formFieldInput: "border border-border bg-white text-foreground",
    footerAction: "pt-2",
    dividerLine: "bg-border",
    alert: "bg-secondary border border-border",
    otpCodeFieldInput: "border border-border bg-white text-foreground",
    formFieldRow: "space-y-1.5",
    main: "gap-4",
  },
};

function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  if (isLoaded && isSignedIn) {
    setLocation("/");
    return null;
  }

  return <CustomSignIn />;
}

function PublicApiDocsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground flex flex-col">
      <header className="w-full border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex justify-between items-center">
          <a href={basePath || "/"} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <img
              src={`${basePath}/presentail-logo.png`}
              aria-hidden="true"
              className="w-8 h-8 rounded-md object-cover"
            />
            <span className="font-bold text-base tracking-tight">Presentail OS</span>
          </a>
          <div className="flex items-center gap-2">
            <a
              href={`${basePath}/sign-in`}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
            >
              Sign in
            </a>
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10">
        <Suspense fallback={<PageLoader />}>
          {children}
        </Suspense>
      </main>
    </div>
  );
}

function HomeRedirect() {
  const { isLoaded } = useAuth();
  const { allowedPages, loaded: roleLoaded } = useWorkspaceRole();
  if (!isLoaded) return <AuthLoadingRecovery />;
  return (
    <>
      <Show when="signed-in">
        {!roleLoaded ? (
          <PageLoader />
        ) : (
          <Redirect to={getDashboardLanding(allowedPages)} />
        )}
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

/**
 * Checks workspace access by calling /api/users.
 * - 403 "no_access" → renders NoAccessPage
 * - loading → renders PageLoader spinner
 * - success → renders children
 */
function AccessGuard({ children }: { children: React.ReactNode }) {
  const { status, error } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users", { timeoutMs: 15_000 }),
    retry: retryDashboardStartup,
    retryDelay: dashboardStartupRetryDelay,
  });

  if (status === "pending") return <PageLoader />;
  if (status === "error" && (error as Error).message === "no_access") {
    return <NoAccessPage />;
  }
  if (status === "error") {
    return (
      <LoadingRecovery
        title="We couldn't load your workspace"
        description="Reload the page to reconnect to the dashboard."
      />
    );
  }
  return <>{children}</>;
}

/**
 * Shown once to invited users who signed in for the first time and
 * have not yet provided their name. Blocks the dashboard until saved.
 * Type assignment is handled upstream by TypeAssignmentGate — this gate
 * only collects the user's display name.
 */
const onboardingDismissedKey = (userId: string) => `onboardingNameDismissed:${userId}`;

function isOnboardingDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(onboardingDismissedKey(userId)) === "1";
  } catch {
    return false;
  }
}

function rememberOnboardingDismissed(userId: string) {
  try {
    localStorage.setItem(onboardingDismissedKey(userId), "1");
  } catch {
    // localStorage unavailable — fall back to in-memory dismissal only
  }
}

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  const { t } = useI18nTranslation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  if (!isLoaded || !user) return <>{children}</>;
  if (user.firstName || skipped || isOnboardingDismissed(user.id)) return <>{children}</>;

  const dismiss = () => {
    rememberOnboardingDismissed(user.id);
    setSkipped(true);
  };

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await user.update({ firstName: firstName.trim(), lastName: lastName.trim() });
      rememberOnboardingDismissed(user.id);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : typeof err === "string" ? err : null;
      if (msg && (msg.includes("not a valid parameter") || msg.includes("first_name") || msg.includes("last_name"))) {
        dismiss();
        return;
      }
      setError(msg ?? t("home.errorSaving"));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-md p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("home.welcomeTitle")}</h1>
          <p className="text-muted-foreground text-sm mt-1.5">
            {t("home.onboardingPrompt")}
          </p>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="onboard-first">{t("home.firstName")}</Label>
            <Input
              id="onboard-first"
              placeholder={t("home.firstNamePlaceholder")}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onboard-last">{t("home.lastName")}</Label>
            <Input
              id="onboard-last"
              placeholder={t("home.lastNamePlaceholder")}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          {error && (
            <div className="space-y-1">
              <p className="text-sm text-destructive">{error}</p>
              <p className="text-xs text-muted-foreground">
                If this keeps happening,{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={() => user.reload()}
                >
                  reload your session
                </button>
                {" "}or{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={dismiss}
                >
                  skip for now
                </button>
                {" "}and set your name from the Profile page later.
              </p>
            </div>
          )}
        </div>
        <Button
          className="w-full"
          onClick={handleSave}
          disabled={!firstName.trim() || !lastName.trim() || saving}
        >
          {saving ? t("home.savingName") : t("home.continue")}
        </Button>
        <button
          type="button"
          className="block w-full text-center text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
          onClick={dismiss}
        >
          {t("home.skipForNow")}
        </button>
      </div>
    </div>
  );
}

/**
 * Silently assigns publicMetadata.userType for users who have none yet by
 * calling POST /api/auth/set-user-type, then reloading the Clerk session.
 * This runs BEFORE UserTypeGuard so that freshly invited users get their type
 * assigned transparently before the guard evaluates.
 *
 * Only users who arrive at Presentail OS without an existing type are
 * eligible — the server reads APP_USER_TYPE from its own environment (never
 * from the request body) and refuses assignment if a type is already set.
 *
 * NOTE: publicMetadata.userType is for coarse app-level routing only. Sensitive
 * permissions and business logic must still be verified against the application database.
 */
function TypeAssignmentGate({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  const typeAssignment = useTypeAssignment({
    isLoaded,
    userId: user?.id ?? null,
    userType:
      typeof user?.publicMetadata?.userType === "string"
        ? user.publicMetadata.userType
        : null,
    reload: user ? () => user.reload() : null,
  });

  if (typeAssignment.status === "auth-loading") return <AuthLoadingRecovery />;
  if (typeAssignment.status === "assigning") return <PageLoader />;
  if (typeAssignment.status === "error") {
    return (
      <LoadingRecovery
        title="We couldn't verify your account"
        description={
          typeAssignment.error ??
          "Reload the page to reconnect to your account."
        }
      />
    );
  }

  return <>{children}</>;
}

/**
 * Guards all authenticated routes so only users with publicMetadata.userType === "team"
 * can access Presentail OS. Any signed-in user whose type is not exactly "team" —
 * including users with no type set — is redirected to /unauthorized.
 *
 * TypeAssignmentGate runs before this component and assigns "team" to freshly
 * invited users who arrive without a type, so that by the time this guard
 * evaluates, invited users already have the correct type.
 *
 * NOTE: publicMetadata.userType is for coarse app-level routing only. Sensitive
 * permissions and business logic must still be verified against the application database.
 */
function UserTypeGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  const { realIsOwner, loaded: roleLoaded } = useWorkspaceRole();

  if (!isLoaded) return <AuthLoadingRecovery />;
  if (!user) return <>{children}</>;
  if (!roleLoaded) return <PageLoader />;
  if (realIsOwner) return <>{children}</>;

  const userType = user.publicMetadata?.userType;
  if (userType !== "team") {
    return <Redirect to="/unauthorized" />;
  }

  return <>{children}</>;
}

function ProtectedDashboard({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useAuth();
  if (!isLoaded) return <AuthLoadingRecovery />;
  return (
    <>
      <Show when="signed-in">
        <TypeAssignmentGate>
          <UserTypeGuard>
            <AccessGuard>
              <OnboardingGate>
                <Suspense fallback={<PageLoader />}>
                  <PageTitleProvider>
                    <DashboardLayout>{children}</DashboardLayout>
                  </PageTitleProvider>
                </Suspense>
              </OnboardingGate>
            </AccessGuard>
          </UserTypeGuard>
        </TypeAssignmentGate>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

const DASHBOARD_PREFETCH_QUERIES = [
  { queryKey: ["users"], url: "/api/users" },
  { queryKey: ["devices"], url: "/api/devices" },
  { queryKey: ["api-keys"], url: "/api/api-keys" },
  { queryKey: ["print-jobs"], url: "/api/print-jobs" },
  { queryKey: ["stickers"], url: "/api/stickers" },
  { queryKey: ["downloads-versions"], url: "/api/downloads/versions" },
  { queryKey: ["locations"], url: "/api/locations" },
] as const;

function isSlowOrMeteredConnection(): boolean {
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return true;
  return false;
}

function prefetchDashboardQueries() {
  if (isSlowOrMeteredConnection()) return;
  for (const { queryKey, url } of DASHBOARD_PREFETCH_QUERIES) {
    queryClient.prefetchQuery({
      queryKey,
      queryFn: () => apiFetch(url),
    });
  }
}

function DashboardPrefetcher() {
  const { isSignedIn } = useUser();
  const prefetchedRef = useRef(false);

  useEffect(() => {
    if (!isSignedIn) {
      prefetchedRef.current = false;
      return;
    }

    if (!prefetchedRef.current) {
      prefetchedRef.current = true;

      import("@/pages/dashboard/Layout");
      import("@/pages/dashboard/Devices");
      import("@/pages/dashboard/ApiKeys");
      import("@/pages/dashboard/Downloads");
      import("@/pages/dashboard/PrintHistory");
      import("@/pages/dashboard/Stickers");
      import("@/pages/dashboard/Users");
      import("@/pages/dashboard/ApiDocs");
      import("@/pages/dashboard/Analytics");
      import("@/pages/dashboard/Settings");
      import("@/pages/dashboard/Locations");
      import("@/pages/dashboard/Cities");
      import("@/pages/dashboard/LocationDetail");
      import("@/pages/dashboard/Roles");
      import("@/pages/dashboard/Channels");
      import("@/pages/NoAccess");
      import("@/pages/dashboard/Profile");
    }

    prefetchDashboardQueries();

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        prefetchDashboardQueries();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isSignedIn]);

  return null;
}

/**
 * Redirects non-owners to /devices when they attempt to access
 * an owner-only page directly.
 */
function OwnerGuard({ children }: { children: React.ReactNode }) {
  const { realIsOwner, loaded } = useWorkspaceRole();
  if (!loaded) return null;
  if (!realIsOwner) return <Redirect to="/devices" />;
  return <>{children}</>;
}

/**
 * Redirects users to /devices when they try to access a page
 * that is not in their allowedPages.
 * Owners (allowedPages === null) always pass through.
 */
function PageGuard({ page, matchFn, children }: { page: string; matchFn?: (pages: string[]) => boolean; children: React.ReactNode }) {
  const { allowedPages, loaded } = useWorkspaceRole();
  if (!loaded) return null;
  if (allowedPages === null) return <>{children}</>;
  const hasAccess = matchFn ? matchFn(allowedPages) : allowedPages.includes(page);
  if (!hasAccess) {
    const fallback = getDashboardLanding(allowedPages);
    return <Redirect to={fallback} />;
  }
  return <>{children}</>;
}

export { PageGuard };

/**
 * Lightweight redirect gate for the bare /dashboard route.
 * Reads allowedPages from the workspace role and redirects directly to
 * the correct landing page without rendering DashboardLayout.
 * This avoids a redirect-chain timing issue where the intermediate
 * Redirect rendered inside DashboardLayout's children slot would not
 * propagate in certain test (and some production) scenarios.
 */
function DashboardHomeGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const { allowedPages, loaded: roleLoaded } = useWorkspaceRole();

  if (!isLoaded) return <AuthLoadingRecovery />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  if (!roleLoaded) return <PageLoader />;

  return <Redirect to={getDashboardLanding(allowedPages)} />;
}

/**
 * Registers Clerk's getToken as the bearer-token getter for all customFetch
 * calls (Orval-generated API hooks). Required because os.presentail.com and
 * clerk.presentail.com are different hostnames — the __session cookie set by
 * Clerk FAPI is scoped to clerk.presentail.com and is NOT automatically sent
 * to os.presentail.com/api/... requests. Sending the JWT as an Authorization
 * header is the correct solution.
 */
function ClerkTokenSync() {
  const { getToken } = useAuth();
  useEffect(() => {
    if (!getToken) return;
    setAuthTokenGetter((options) => getToken(options));
    return () => setAuthTokenGetter(null);
  }, [getToken]);
  return null;
}

function ClerkQueryClientCacheInvalidator() {
  useClerk();
  const qc = useQueryClient();

  return null;
}

/**
 * sessionStorage key that tracks how many times we have automatically
 * reloaded the page after a failed_to_load_clerk_js error. Cleared once
 * Clerk loads successfully. Capped at MAX_CLERK_AUTO_RETRIES so we don't
 * reload endlessly when the FAPI is genuinely unreachable.
 */
const CLERK_RETRY_KEY = "clerk_load_retry_count";
const CLERK_LOAD_MAX_AUTO_RETRIES = 2;
const CLERK_LOAD_AUTO_RETRY_DELAY_MS = 3000;

/**
 * Detects clerk-js failing to load (e.g. failed_to_load_clerk_js when the FAPI
 * host is unreachable) and swaps the infinite spinner for a clear error screen.
 * The failure surfaces as an unhandled promise rejection / window error from
 * @clerk/clerk-react, so we listen globally.
 *
 * On the first two failures the hook schedules an automatic page reload so
 * transient network blips (common on mobile) are handled without user action.
 * After MAX_CLERK_AUTO_RETRIES exhausted attempts the user is shown the manual
 * retry screen.
 */
function useClerkLoadFailure(): { failed: boolean; autoRetrying: boolean } {
  const [state, setState] = useState({ failed: false, autoRetrying: false });
  useEffect(() => {
    // If Clerk loads without error within 12 s, consider this page load a
    // success and clear the retry counter so future visits start fresh.
    const successTimer = setTimeout(() => {
      sessionStorage.removeItem(CLERK_RETRY_KEY);
    }, 12000);

    let handled = false;

    const isClerkLoadError = (value: unknown): boolean => {
      const message =
        value instanceof Error
          ? value.message
          : typeof value === "string"
            ? value
            : "";
      const code =
        typeof value === "object" && value !== null && "code" in value
          ? String((value as { code?: unknown }).code)
          : "";
      // Use an exact match for the message check to avoid false positives from
      // unrelated errors whose text happens to contain a Clerk-sounding phrase.
      return (
        code === "failed_to_load_clerk_js" ||
        message.includes("failed_to_load_clerk_js") ||
        message === "Failed to load Clerk"
      );
    };

    const handleClerkError = () => {
      if (handled) return; // deduplicate — only act on the first matching event
      handled = true;
      clearTimeout(successTimer);

      const currentCount = parseInt(
        sessionStorage.getItem(CLERK_RETRY_KEY) ?? "0",
        10,
      );
      if (currentCount < CLERK_LOAD_MAX_AUTO_RETRIES) {
        // Auto-retry: increment counter, show a brief reconnecting screen,
        // then reload. Most transient failures resolve on the first retry.
        sessionStorage.setItem(CLERK_RETRY_KEY, String(currentCount + 1));
        setState({ failed: true, autoRetrying: true });
        setTimeout(() => window.location.reload(), CLERK_LOAD_AUTO_RETRY_DELAY_MS);
      } else {
        // Exhausted automatic retries — clear the counter so a future manual
        // retry starts the auto-retry sequence again.
        sessionStorage.removeItem(CLERK_RETRY_KEY);
        setState({ failed: true, autoRetrying: false });
      }
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      if (isClerkLoadError(event.reason)) handleClerkError();
    };
    const onError = (event: ErrorEvent) => {
      if (isClerkLoadError(event.error ?? event.message)) handleClerkError();
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      clearTimeout(successTimer);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  return state;
}

function ClerkLoadFailureScreen({ autoRetrying }: { autoRetrying: boolean }) {
  if (autoRetrying) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Reconnecting to sign-in service…
        </p>
      </div>
    );
  }
  return (
    <div
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="clerk-load-error"
      role="alert"
    >
      <h1 className="text-xl font-semibold">Authentication failed to load</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        We couldn't reach the sign-in service. This is usually a temporary
        network issue — please try again.
      </p>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        onClick={() => {
          sessionStorage.removeItem(CLERK_RETRY_KEY);
          window.location.reload();
        }}
      >
        Retry
      </button>
    </div>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const { failed: clerkLoadFailed, autoRetrying } = useClerkLoadFailure();

  if (clerkLoadFailed) {
    return <ClerkLoadFailureScreen autoRetrying={autoRetrying} />;
  }

  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      {...(clerkProxyUrl ? { proxyUrl: clerkProxyUrl } : {})}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <SimulatedRoleProvider>
        <QueryClientProvider client={queryClient}>
          <ClerkTokenSync />
          <ClerkQueryClientCacheInvalidator />
          <DashboardPrefetcher />
          <SessionExpiredBanner />
          <TooltipProvider>
            <Suspense fallback={<PageLoader />}>
              <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/sso-callback">
              <HandleSSOCallback
                navigateToApp={() => {
                  window.location.href = `${basePath}/`;
                }}
                navigateToSignIn={() => {
                  window.location.href = `${basePath}/sign-in`;
                }}
                navigateToSignUp={() => {
                  window.location.href = `${basePath}/sign-in`;
                }}
              />
            </Route>
            <Route path="/sign-in/*?" component={SignInPage} />
            {/* Public account creation is disabled. Keep old links deterministic. */}
            <Route path="/sign-up/*?">
              <Redirect to="/sign-in" />
            </Route>
            <Route path="/join/sso-callback">
              <JoinSSOCallback />
            </Route>
            <Route path="/join/*?">
              <Suspense fallback={<PageLoader />}>
                <JoinPage />
              </Suspense>
            </Route>
            <Route path="/unauthorized">
              <Suspense fallback={<PageLoader />}>
                <UnauthorizedPage />
              </Suspense>
            </Route>
            <Route path="/connect" component={ConnectPage} />
            <Route path="/pay/:token">
              <Suspense fallback={<PageLoader />}>
                <PayPage />
              </Suspense>
            </Route>
            <Route path="/address/:token">
              <Suspense fallback={<PageLoader />}>
                <AddressCollectPage />
              </Suspense>
            </Route>
            <Route path="/po-accept/:token">
              <Suspense fallback={<PageLoader />}>
                <SupplierAcceptPage />
              </Suspense>
            </Route>
            <Route path="/dashboard">
              <DashboardHomeGate />
            </Route>
            <Route path="/dashboard/:rest*">
              {(params) => <Redirect to={`/${params["rest*"] ?? ""}${window.location.search}`} />}
            </Route>
            <Route path="/project-manager-dashboard">
              <ProtectedDashboard>
                <PageGuard page="project-manager-dashboard">
                  <ProjectManagerDashboardPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/ops-dashboard">
              <ProtectedDashboard>
                <PageGuard page="ops-dashboard">
                  <OperationsDashboardPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/review-rewards">
              <ProtectedDashboard>
                <PageGuard page="review-rewards">
                  <ReviewRewardsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/recipe-review">
              <ProtectedDashboard>
                <PageGuard page="products" matchFn={(pages) => pages.includes("products.manage")}>
                  <RecipeReviewPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/recipe-benchmarks">
              <ProtectedDashboard>
                <PageGuard page="products" matchFn={(pages) => pages.includes("products") || pages.includes("products.manage")}>
                  <RecipeBenchmarksPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/devices">
              <ProtectedDashboard>
                <PageGuard page="devices">
                  <DevicesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/api-keys">
              <ProtectedDashboard>
                <PageGuard page="api-keys">
                  <ApiKeysPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/downloads">
              <ProtectedDashboard>
                <PageGuard page="downloads">
                  <DownloadsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/stickers">
              <ProtectedDashboard>
                <PageGuard page="stickers">
                  <BrandStickerSheetsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/print-history">
              <ProtectedDashboard>
                <PageGuard page="print-history">
                  <PrintHistoryPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/users">
              <Redirect to="/people/access" />
            </Route>
            <Route path="/api-docs">
              <PublicApiDocsShell>
                <ApiDocsPage />
              </PublicApiDocsShell>
            </Route>
            <Route path="/analytics">
              <ProtectedDashboard>
                <PageGuard page="analytics">
                  <AnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/store-analytics">
              <ProtectedDashboard>
                <PageGuard page="store-analytics">
                  <StoreAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cart-checkout-analytics">
              <ProtectedDashboard>
                <PageGuard page="cart-checkout-analytics">
                  <CartCheckoutAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/operations-analytics">
              <ProtectedDashboard>
                <PageGuard page="operations-analytics">
                  <OperationsAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/customer-analytics">
              <ProtectedDashboard>
                <PageGuard page="customer-analytics">
                  <CustomerAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/upsell">
              <ProtectedDashboard>
                <PageGuard page="upsell">
                  <UpsellPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/marketing-analytics">
              <ProtectedDashboard>
                <PageGuard page="marketing-analytics">
                  <MarketingAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/seo-analytics">
              <ProtectedDashboard>
                <PageGuard page="seo-analytics">
                  <SeoAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/delivery-analytics">
              <ProtectedDashboard>
                <PageGuard page="delivery-analytics">
                  <DeliveryAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/search-discovery-analytics">
              <ProtectedDashboard>
                <PageGuard page="search-discovery-analytics">
                  <SearchDiscoveryAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/inventory-cogs-analytics">
              <ProtectedDashboard>
                <PageGuard page="inventory-cogs-analytics">
                  <InventoryCogsAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/marketplace-analytics">
              <ProtectedDashboard>
                <PageGuard page="marketplace-analytics">
                  <MarketplaceAnalyticsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/roles">
              <ProtectedDashboard>
                <PageGuard page="roles">
                  <RolesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/channels/:channelId">
              <ProtectedDashboard>
                <PageGuard page="channels" matchFn={hasChannelsAccess}>
                  <ChannelDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/channels">
              <ProtectedDashboard>
                <PageGuard page="channels" matchFn={hasChannelsAccess}>
                  <ChannelsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/payment-links">
              <ProtectedDashboard>
                <PageGuard page="payment-links">
                  <PaymentLinksPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/coupons">
              <ProtectedDashboard>
                <PageGuard page="coupons">
                  <CouponsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/locations/:id">
              <ProtectedDashboard>
                <PageGuard page="locations">
                  <LocationDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cities">
              <ProtectedDashboard>
                <PageGuard page="cities">
                  <CitiesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/locations">
              <ProtectedDashboard>
                <PageGuard page="locations">
                  <LocationsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings">
              <ProtectedDashboard>
                <PageGuard page="settings">
                  <SettingsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/brand-aliases">
              <ProtectedDashboard>
                <OwnerGuard>
                  <Redirect to="/brands?tab=statement-aliases" />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/brands">
              <ProtectedDashboard>
                <PageGuard page="brands" matchFn={hasBrandsAccess}>
                  <BrandsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/brands/:brandId">
              <ProtectedDashboard>
                <PageGuard page="brands" matchFn={hasBrandsAccess}>
                  <BrandDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/products/:id">
              <ProtectedDashboard>
                <PageGuard page="products" matchFn={(pages) => pages.includes("products") || pages.includes("products.manage")}>
                  <ProductDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/products">
              <ProtectedDashboard>
                <PageGuard page="products" matchFn={(pages) => pages.includes("products") || pages.includes("products.manage")}>
                  <ProductsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/events">
              <ProtectedDashboard>
                <PageGuard page="events">
                  <EventsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/base-items/:baseItemId">
              <ProtectedDashboard>
                <PageGuard page="base-items">
                  <BaseItemDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/base-items">
              <ProtectedDashboard>
                <PageGuard page="base-items">
                  <BaseItemsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/base-item-categories">
              <ProtectedDashboard>
                <PageGuard page="base-item-categories">
                  <BaseItemCategoriesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-drawers">
              <ProtectedDashboard>
                <PageGuard page="cash-drawers">
                  <CashDrawersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-sessions/new">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashSessionOpenPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-sessions/:id/close">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashSessionClosePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-sessions/:id">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashSessionDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-bills">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashBillsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-sessions">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashSessionsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            {/* No PageGuard: approval access is authorized server-side (Business
                Development role or owner), independent of page entitlements. The
                page renders its own no-access state on a 403. */}
            <Route path="/cash-approvals">
              <ProtectedDashboard>
                <CashApprovalsPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-transfers/:id">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashTransferDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cash-transfers">
              <ProtectedDashboard>
                <PageGuard page="cash-sessions">
                  <CashTransfersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/purchase-orders/:id">
              <ProtectedDashboard>
                <PageGuard page="purchase-orders">
                  <PurchaseOrderDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/supplier-statements">
              <ProtectedDashboard>
                <PageGuard page="supplier-statements">
                  <SupplierStatementsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/purchase-orders">
              <ProtectedDashboard>
                <PageGuard page="purchase-orders">
                  <PurchaseOrdersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/suppliers/reorder">
              <ProtectedDashboard>
                <PageGuard page="suppliers">
                  <SupplierReorderPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/suppliers/:supplierId/catalog/:itemId">
              <ProtectedDashboard>
                <PageGuard page="suppliers">
                  <SupplierCatalogItemDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/suppliers/:supplierId">
              <ProtectedDashboard>
                <PageGuard page="suppliers">
                  <SupplierDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/suppliers">
              <ProtectedDashboard>
                <PageGuard page="suppliers">
                  <SuppliersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/time-off/my">
              <ProtectedDashboard>
                <PageGuard page="time-off">
                  <TimeOffMyPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/time-off/calendar">
              <ProtectedDashboard>
                <PageGuard page="time-off">
                  <TimeOffCalendarPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/time-off/approvals">
              <ProtectedDashboard>
                <PageGuard page="time-off.manage">
                  <TimeOffApprovalsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/time-off/policies">
              <ProtectedDashboard>
                <PageGuard page="time-off.manage">
                  <TimeOffPoliciesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/public-holidays">
              <ProtectedDashboard>
                <PageGuard page="time-off.manage">
                  <PublicHolidaysPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/time-off/blackout-dates">
              <ProtectedDashboard>
                <PageGuard page="time-off.manage">
                  <BlackoutDatesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            {/* ORDERING CONSTRAINT: /people/access must come before /people/:id.
                Wouter uses first-match semantics inside <Switch>; swapping the
                order would silently route the Invites & Access page through the
                dynamic person-profile handler instead. The route-ordering test
                (app-route-ordering.test.ts) enforces this automatically. */}
            <Route path="/people/access">
              <ProtectedDashboard>
                <PageGuard page="people.invites">
                  <InvitesAccessPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/people/:id">
              <ProtectedDashboard>
                <PageGuard page="people.directory">
                  <PersonProfilePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/people">
              <ProtectedDashboard>
                <PageGuard page="people.directory">
                  <PeopleDirectoryPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/invites">
              <Redirect to="/people/access" />
            </Route>
            <Route path="/admin/people/team-members/:id">
              <ProtectedDashboard>
                <PageGuard page="people.directory">
                  <TeamMemberDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/people/team-members">
              <ProtectedDashboard>
                <PageGuard page="people.directory">
                  <TeamMembersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/people/attendance">
              <ProtectedDashboard>
                <PageGuard page="people.attendance">
                  <AttendancePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/attendance/my">
              <ProtectedDashboard>
                <PageGuard page="people.attendance">
                  <AttendanceMyPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/attendance/requests">
              <ProtectedDashboard>
                <PageGuard page="people.attendance">
                  <AttendanceCorrectionRequestsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/attendance">
              <ProtectedDashboard>
                <PageGuard page="people.attendance">
                  <AttendanceManagerPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/people/work-schedules">
              <ProtectedDashboard>
                <PageGuard page="people.work-schedules">
                  <WorkSchedulesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/people/attendance-settings">
              <ProtectedDashboard>
                <PageGuard page="people.work-schedules">
                  <AttendanceSettingsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/address-book">
              <ProtectedDashboard>
                <PageGuard page="address-book">
                  <AddressBookPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/address-collector">
              <ProtectedDashboard>
                <PageGuard page="address-collector">
                  <AddressCollectorPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/fleet">
              <ProtectedDashboard>
                <PageGuard page="fleet">
                  <FleetPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/fleet/vehicle-types">
              <ProtectedDashboard>
                <PageGuard page="fleet">
                  <FleetVehicleTypesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/fleet/drivers/:id">
              <ProtectedDashboard>
                <PageGuard page="fleet">
                  <FleetDriverDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/orders/:id">
              <ProtectedDashboard>
                <PageGuard page="orders">
                  <OrderDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/orders">
              <ProtectedDashboard>
                <PageGuard page="orders">
                  <OrdersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/florist-orders">
              <ProtectedDashboard>
                <PageGuard page="florist_orders" matchFn={hasFloristOrdersAccess}>
                  <FloristOrdersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/address-book/:id">
              <ProtectedDashboard>
                <PageGuard page="address-book">
                  <PlaceDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/customers">
              <ProtectedDashboard>
                <PageGuard page="customers">
                  <CustomersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/audiences">
              <ProtectedDashboard>
                <PageGuard page="customers">
                  <AudiencesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/audiences/:id">
              <ProtectedDashboard>
                <PageGuard page="customers">
                  <AudienceDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/customers/:id">
              <ProtectedDashboard>
                <PageGuard page="customers">
                  <CustomerProfilePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/contacts/:id">
              <ProtectedDashboard>
                <PageGuard page="customers">
                  <CrmContactProfilePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/admin/homepage-banners">
              <ProtectedDashboard>
                <PageGuard page="homepage_banners.manage">
                  <HomepageBannersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/budget">
              <Redirect to="/marketing-budget-planner" />
            </Route>
            <Route path="/marketing-budget-planner/:budgetId">
              <ProtectedDashboard>
                <PageGuard page="marketing-budget-planner">
                  <MarketingBudgetDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/marketing-budget-planner">
              <ProtectedDashboard>
                <PageGuard page="marketing-budget-planner">
                  <MarketingBudgetPlannerPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/occasion-campaigns/occasions/new">
              <ProtectedDashboard>
                <PageGuard page="occasion-campaigns">
                  <OccasionCampaignCreateEditPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/occasion-campaigns/occasions/:id/edit">
              <ProtectedDashboard>
                <PageGuard page="occasion-campaigns">
                  <OccasionCampaignCreateEditPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/occasion-campaigns/occasions/:id">
              <ProtectedDashboard>
                <PageGuard page="occasion-campaigns">
                  <OccasionDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/occasion-campaigns/plans/:id">
              <ProtectedDashboard>
                <PageGuard page="occasion-campaigns">
                  <OccasionCampaignPlanDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/occasion-campaigns">
              <ProtectedDashboard>
                <PageGuard page="occasion-campaigns">
                  <OccasionCampaignCalendarPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/bloomprint">
              <ProtectedDashboard>
                <PageGuard page="products">
                  <BloomprintDashboard />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/bloomprint/:id">
              <ProtectedDashboard>
                <PageGuard page="products">
                  <BloomprintDraftDetail />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/ai-invoice-import">
              <ProtectedDashboard>
                <PageGuard page="ai-invoice-import">
                  <AiInvoiceImportPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/ai-invoice-import/:id/review">
              <ProtectedDashboard>
                <PageGuard page="ai-invoice-import">
                  <AiInvoiceReviewPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/catalog-attributes/occasions">
              <ProtectedDashboard>
                <PageGuard page="catalog-occasions">
                  <OccasionsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/catalog-attributes/categories">
              <ProtectedDashboard>
                <PageGuard page="catalog-categories-attr">
                  <CatalogCategoriesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/catalog-attributes/brands">
              <ProtectedDashboard>
                <PageGuard page="catalog-brands-attr">
                  <CatalogBrandsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/catalog-attributes/recipients">
              <ProtectedDashboard>
                <PageGuard page="catalog-recipients">
                  <RecipientsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/webhook-endpoints">
              <ProtectedDashboard>
                <OwnerGuard>
                  <WebhookEndpointsPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/publish">
              <ProtectedDashboard>
                <PublishPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/tax-rules">
              <ProtectedDashboard>
                <OwnerGuard>
                  <TaxRulesPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/smoke-tests">
              <ProtectedDashboard>
                <OwnerGuard>
                  <SmokeTestRunsPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/publishing-channels/:id">
              <ProtectedDashboard>
                <PageGuard page="publishing-channels">
                  <PublishingChannelDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/publishing-channels">
              <ProtectedDashboard>
                <PageGuard page="publishing-channels">
                  <PublishingChannelsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/developer">
              <ProtectedDashboard>
                <PageGuard page="publishing-channels">
                  <DeveloperPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/google-product-post">
              <ProtectedDashboard>
                <OwnerGuard>
                  <GoogleProductPostPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/card-message">
              <ProtectedDashboard>
                <PageGuard page="card-message">
                  <CardMessageFormPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/invoices">
              <ProtectedDashboard>
                <PageGuard page="invoices">
                  <InvoicesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/cash-drawer">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.cash_drawer" matchFn={hasCmcPosSubAccess("cmc_pos.cash_drawer")}>
                  <CmcPosCashDrawerPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/returns/history">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.returns" matchFn={hasCmcPosSubAccess("cmc_pos.returns")}>
                  <CmcPosReturnsHistoryPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/returns">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.returns" matchFn={hasCmcPosSubAccess("cmc_pos.returns")}>
                  <CmcPosReturnsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/monthly-sales">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.monthly_sales" matchFn={hasCmcPosSubAccess("cmc_pos.monthly_sales")}>
                  <CmcPosMonthlySalesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/audit">
              <Redirect to="/cmc-pos/sales" />
            </Route>
            <Route path="/cmc-pos/location-requests">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.view_location_requests" matchFn={hasCmcPosSubAccess("cmc_pos.view_location_requests")}>
                  <CmcPosLocationRequestsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/sales/transactions">
              <Redirect to="/cmc-pos/sales" />
            </Route>
            <Route path="/cmc-pos/sales/reconciliation">
              <Redirect to="/cmc-pos/sales" />
            </Route>
            <Route path="/cmc-pos/sales">
              <ProtectedDashboard>
                <PageGuard page="cmc_pos.audit" matchFn={hasCmcPosSubAccess("cmc_pos.audit")}>
                  <CmcPosSalesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/new-order">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos-new-order" matchFn={hasCmcPosNewOrderAccess}>
                  <CmcPosNewOrderPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/sale">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos">
                  <CmcPosSalePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/request/:id">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos">
                  <CmcPosRequestDetailPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/request">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos">
                  <CmcPosRequestPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos/delivery">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos">
                  <CmcPosDeliveryPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/cmc-pos">
              <ProtectedDashboard>
                <PageGuard page="cmc-pos-dashboard" matchFn={hasCmcPosDashboardAccess}>
                  <CmcPosPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/opportunities">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineOpportunitiesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/competitors">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineCompetitorsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/campaigns">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineCampaignsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/monitor">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineMonitorPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/reports">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineReportsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine/settings">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineSettingsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/backlink-engine">
              <ProtectedDashboard>
                <PageGuard page="backlink-engine">
                  <BacklinkEngineOverviewPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/monthly-closing/supplier-recon/:sessionId">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <SupplierReconciliationWorkspacePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/monthly-closing">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <MonthlySalesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/monthly-sales">
              <Redirect to="/finance/accounting/monthly-closing" />
            </Route>
            <Route path="/finance/accounting/cash-activity">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <CashActivityPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/journal-entries">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <JournalEntriesPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/reconciliation/review/:statementId">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <ReviewBankStatementPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/reconciliation">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <AccountingReconciliationPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/chart-of-accounts">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <ChartOfAccountsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/finance/accounting/reports">
              <ProtectedDashboard>
                <PageGuard page="finance_accounting">
                  <AccountingReportsPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/inbox">
              <ProtectedDashboard>
                <InboxPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/automations/:flowId">
              <ProtectedDashboard>
                <FlowBuilderPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/automations">
              <ProtectedDashboard>
                <AutomationsPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/templates">
              <ProtectedDashboard>
                <TemplatesPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/analytics">
              <ProtectedDashboard>
                <OmnichannelAnalyticsPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/contacts/:id">
              <ProtectedDashboard>
                <ContactProfilePage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/contacts">
              <ProtectedDashboard>
                <ContactsPage />
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel/audit-log">
              <ProtectedDashboard>
                <OwnerGuard>
                  <AuditLogPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/omnichannel">
              <OmnichannelIndexRedirect />
            </Route>
            <Route path="/settings/channels/whatsapp">
              <ProtectedDashboard>
                <OwnerGuard>
                  <WhatsAppChannelPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings/channels/messenger">
              <ProtectedDashboard>
                <OwnerGuard>
                  <MessengerChannelPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings/channels/instagram">
              <ProtectedDashboard>
                <OwnerGuard>
                  <InstagramChannelPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings/channels/tiktok">
              <ProtectedDashboard>
                <OwnerGuard>
                  <TikTokChannelPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings/channels">
              <ProtectedDashboard>
                <OwnerGuard>
                  <ChannelsSettingsPage />
                </OwnerGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/settings/devices/scanners">
              <ProtectedDashboard>
                <PageGuard page="invoice-scanners">
                  <InvoiceScannersPage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route path="/profile">
              <ProtectedDashboard>
                <ProfilePage />
              </ProtectedDashboard>
            </Route>
            <Route path="/users/:memberId/profile">
              <ProtectedDashboard>
                <PageGuard page="users">
                  <MemberProfilePage />
                </PageGuard>
              </ProtectedDashboard>
            </Route>
            <Route component={NotFound} />
          </Switch>
          </Suspense>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
      </SimulatedRoleProvider>
    </ClerkProvider>
  );
}

// On a cold app start (e.g. first TestFlight launch in a WebView) the very
// first fetch of the Clerk script can fail on a slow or still-waking network.
// Retry several times with exponential backoff before surfacing the
// "Couldn't connect to sign-in" screen — most transient failures recover
// within the first few attempts.
const MAX_CLERK_AUTO_RETRIES = 8;
const CLERK_RETRY_BASE_DELAY_MS = 2000;
const CLERK_RETRY_MAX_DELAY_MS = 10_000;

// When a new version of the app is deployed, the hashed asset filenames change.
// A browser tab that was opened against the *previous* build still holds the old
// chunk manifest, so navigating to a not-yet-loaded lazy route (e.g. /roles)
// requests an old chunk hash. The server's SPA fallback returns index.html
// (HTTP 200, content-type text/html) for that missing asset, and the browser
// refuses to evaluate HTML as a module — surfacing as one of the messages below.
// React.lazy caches the rejected import promise, so re-rendering re-throws
// immediately; the only reliable recovery is a full reload to fetch the fresh
// index.html (and therefore the new chunk manifest).
function isModuleLoadError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /unable to preload (css|module)/i.test(message) ||
    /dynamically imported module/i.test(message)
  );
}

// Reload at most once per short window so that a genuinely-missing chunk (a real
// build/deploy bug, not just a stale tab) does not trap the user in a reload loop.
// The guard is stored redundantly in sessionStorage AND window.name: window.name
// survives a reload within the same tab and needs no storage permissions, so the
// loop guard still holds even when sessionStorage is blocked (private mode, strict
// privacy settings). window.name is appended/cleaned rather than overwritten so we
// don't clobber tokens other libraries (e.g. OAuth popups) may keep there.
const STALE_CHUNK_RELOAD_KEY = "presentail_stale_chunk_reload_at";
const STALE_CHUNK_RELOAD_WINDOW_MS = 15_000;
const WINDOW_NAME_MARKER = /\bpresentail_cr=(\d+)\b/;

function readReloadMarker(): number {
  let latest = 0;
  try {
    const v = Number(
      window.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) ?? "0",
    );
    if (Number.isFinite(v)) latest = Math.max(latest, v);
  } catch {
    // sessionStorage unavailable — fall back to window.name below.
  }
  const match = WINDOW_NAME_MARKER.exec(window.name || "");
  if (match) {
    const v = Number(match[1]);
    if (Number.isFinite(v)) latest = Math.max(latest, v);
  }
  return latest;
}

function writeReloadMarker(timestamp: number): void {
  try {
    window.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(timestamp));
  } catch {
    // ignore — window.name marker below is the storage-independent guard.
  }
  try {
    const cleaned = (window.name || "").replace(WINDOW_NAME_MARKER, "").trim();
    window.name = `${cleaned} presentail_cr=${timestamp}`.trim();
  } catch {
    // ignore
  }
}

function reloadOnceForStaleChunk(): boolean {
  const last = readReloadMarker();
  const now = Date.now();
  if (last && now - last < STALE_CHUNK_RELOAD_WINDOW_MS) {
    // Already reloaded once recently — a fresh reload would not help, so stop
    // and let the error boundary surface the "new version available" UI.
    return false;
  }
  writeReloadMarker(now);
  window.location.reload();
  return true;
}

// Vite fires `vite:preloadError` on window when a dynamically-imported chunk
// fails to load. Recover by reloading once instead of letting it bubble to the
// error boundary as a misleading "authentication failed" screen. Registration is
// guarded so dev-mode HMR re-evaluation of this module does not stack duplicate
// listeners.
declare global {
  interface Window {
    __presentailPreloadErrorHooked?: boolean;
  }
}
if (typeof window !== "undefined" && !window.__presentailPreloadErrorHooked) {
  window.__presentailPreloadErrorHooked = true;
  window.addEventListener("vite:preloadError", ((event: Event) => {
    event.preventDefault();
    reloadOnceForStaleChunk();
  }) as EventListener);
}

interface ClerkErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
  autoRetrying: boolean;
  isStaleChunk: boolean;
}

class ClerkErrorBoundary extends Component<
  { children: ReactNode },
  ClerkErrorBoundaryState
> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
      autoRetrying: false,
      isStaleChunk: false,
    };
  }

  componentWillUnmount() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ClerkErrorBoundaryState> {
    return { hasError: true, error, isStaleChunk: isModuleLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A stale lazy-route chunk after a deploy is NOT an auth failure. Re-rendering
    // cannot recover it (React.lazy caches the rejected import), so reload once to
    // pick up the fresh chunk manifest. If the loop guard blocks the reload, fall
    // through to the chunk-specific UI below instead of the Clerk auth message.
    if (isModuleLoadError(error)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[ClerkErrorBoundary] Stale/missing module chunk — reloading:",
        error.message,
      );
      reloadOnceForStaleChunk();
      return;
    }

    // eslint-disable-next-line no-console
    console.error("[ClerkErrorBoundary] Clerk initialization error:", error, info);

    if (this.state.retryCount < MAX_CLERK_AUTO_RETRIES) {
      // Automatically retry with exponential backoff (1.5s, 3s, 6s, 10s)
      // before showing error UI.
      const delay = Math.min(
        CLERK_RETRY_BASE_DELAY_MS * 2 ** this.state.retryCount,
        CLERK_RETRY_MAX_DELAY_MS,
      );
      this.setState({ autoRetrying: true });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.setState((s) => ({
          hasError: false,
          error: null,
          autoRetrying: false,
          retryCount: s.retryCount + 1,
        }));
      }, delay);
    }
  }

  handleRetry = () => {
    this.setState((s) => ({
      hasError: false,
      error: null,
      autoRetrying: false,
      retryCount: s.retryCount + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      if (this.state.autoRetrying) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-background">
            <div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin" />
          </div>
        );
      }
      const isStaleChunk = this.state.isStaleChunk;
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8 text-center bg-background">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">
              {isStaleChunk
                ? "A new version is available"
                : "Couldn't connect to sign-in"}
            </h1>
            <p className="text-muted-foreground text-sm max-w-sm">
              {isStaleChunk
                ? "This page was updated since you opened it. Reload to get the latest version."
                : "The authentication service failed to load — this is usually caused by a slow network or a blocked connection. Retrying often fixes it."}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-3">
            {!isStaleChunk && (
              <button
                onClick={this.handleRetry}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Try again
              </button>
            )}
            <button
              onClick={() => window.location.reload()}
              className={
                isStaleChunk
                  ? "px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  : "px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
              }
            >
              Reload page
            </button>
          </div>
          {this.state.error && (
            <details className="text-left max-w-lg w-full">
              <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                Technical details
              </summary>
              <pre className="mt-2 text-xs bg-muted rounded p-3 overflow-auto text-destructive whitespace-pre-wrap break-all">
                {this.state.error.message}
                {"\n\n"}
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ClerkErrorBoundary>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </ClerkErrorBoundary>
  );
}

export default App;

const AudienceDetailPage = lazy(() => import("@/pages/dashboard/audiences/AudienceDetailPage"));
