import { ReactNode, useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { useWorkspaceImageToken } from "@/hooks/use-workspace-image-token";
import {
  LogOut,
  Eye,
  X,
  User,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useRoles } from "@/hooks/use-roles";
import { useSimulatedRole } from "@/contexts/simulated-role-context";
import { DataSaverBanner } from "@/components/DataSaverBanner";
import { NewSessionBanner } from "@/components/NewSessionBanner";
import { NewOrderAlertBanner } from "@/components/NewOrderAlertBanner";
import { useNewOrderAlertQueue } from "@/hooks/use-new-order-alert-queue";
import { NotificationBell } from "@/components/NotificationBell";
import {
  NAV,
  NAV_SECTIONS,
  isNavGroupVisible,
  isNavItemActive,
  isNavVisible,
  type NavGroup,
  type NavItem,
} from "./nav";
import { useTranslation } from "react-i18next";
import { usePendingAccessRequests } from "@/hooks/use-pending-access-requests";
import { useTimeOffNotifications } from "@/hooks/use-time-off-notifications";
import { useAttendanceCorrectionNotifications } from "@/hooks/use-attendance-correction-notifications";
import { usePageTitle } from "@/hooks/use-page-title";
import { useChannelErrorAlert } from "@/hooks/use-channel-error-alert";
import { useOmnichannelSSE } from "@/pages/omnichannel/useOmnichannelSSE";
import { useInboxUnreadCount } from "@/hooks/use-inbox-unread-count";
import { usePendingOrdersCount } from "@/hooks/use-pending-orders-count";
import { useFloristManualReviewCount } from "@/hooks/use-florist-manual-review-count";
import { useReorderCount } from "@/hooks/use-reorder-count";
import { useRecipeAttention } from "@/hooks/use-recipe-attention";
import { OmnichannelSSEContext } from "@/contexts/omnichannel-sse-context";
import { useLowStockSse } from "@/hooks/use-low-stock-sse";
import { useLowStockNotifications } from "@/hooks/use-low-stock-notifications";
import {
  useNewOrderSse,
  useFloristAssignmentSse,
  type NewOrderEvent,
  type FloristAssignmentEvent,
} from "@/hooks/use-new-order-sse";
import { useNewOrderNotifications } from "@/hooks/use-new-order-notifications";
import { useCashSessionAlertSse, type CashSessionAlertEvent } from "@/hooks/use-cash-session-alert-sse";
import { useCashSessionNotifications } from "@/hooks/use-cash-session-notifications";
import { useSalaryApprovalNotifications } from "@/hooks/use-salary-approval-notifications";
import { useNewCmcSaleSse, type CmcSaleEvent } from "@/hooks/use-new-cmc-sale-sse";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function UserAvatar({ user, testId }: { user: { hasImage: boolean; imageUrl: string; firstName?: string | null; primaryEmailAddress?: { emailAddress: string } | null }; testId?: string }) {
  return (
    <div
      {...(testId ? { "data-testid": testId } : {})}
      className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-medium overflow-hidden border border-border cursor-pointer"
    >
      {user.hasImage ? (
        <img src={user.imageUrl} alt="Avatar" className="w-full h-full object-cover" {...(testId ? { "data-testid": `${testId}-img` } : {})} />
      ) : (
        (user.firstName?.[0] || user.primaryEmailAddress?.emailAddress?.[0] || "U").toUpperCase()
      )}
    </div>
  );
}

function UserDropdown({
  user,
  roleLabel,
  profileLabel,
  signOutLabel,
  onSignOut,
  primaryInstance = false,
}: {
  user: { hasImage: boolean; imageUrl: string; firstName?: string | null; primaryEmailAddress?: { emailAddress: string } | null };
  roleLabel: string;
  profileLabel: string;
  signOutLabel: string;
  onSignOut: () => void;
  primaryInstance?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <UserAvatar user={user} testId={primaryInstance ? "sidebar-avatar" : undefined} />
          {/* sr-only span keeps sidebar-role-label in the DOM without opening the dropdown.
              Only the primaryInstance carries the testid to avoid duplicate-element query failures. */}
          <span className="sr-only" {...(primaryInstance ? { "data-testid": "sidebar-role-label" } : {})}>{roleLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm truncate">
              {user.firstName || user.primaryEmailAddress?.emailAddress}
            </span>
            {user.firstName && (
              <span className="text-xs text-muted-foreground truncate">
                {user.primaryEmailAddress?.emailAddress}
              </span>
            )}
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              {roleLabel}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2 cursor-pointer" data-testid="link-profile">
          <Link href="/profile">
            <User size={14} />
            <span>{profileLabel}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onSignOut}
          className="gap-2 cursor-pointer"
          data-testid="button-sign-out"
        >
          <LogOut size={14} />
          <span>{signOutLabel}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavGroupSection({
  group,
  visibleChildren,
  isOpen,
  onToggle,
  currentPath,
  badge,
  badgeClassName,
  childBadges,
  childBadgeClassName,
  childBadgeAriaLabels,
  childBadgeTestIds,
}: {
  group: NavGroup;
  visibleChildren: NavItem[];
  isOpen: boolean;
  onToggle: () => void;
  currentPath: string;
  badge?: number;
  badgeClassName?: string;
  childBadges?: Record<string, number>;
  childBadgeClassName?: string;
  childBadgeAriaLabels?: Record<string, string>;
  childBadgeTestIds?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const GroupIcon = group.icon;
  const anyChildActive = visibleChildren.some((child) => isNavItemActive(child, currentPath));
  const resolvedBadgeClassName = badgeClassName ?? "bg-destructive text-destructive-foreground";
  const resolvedChildBadgeClassName = childBadgeClassName ?? "bg-destructive text-destructive-foreground";
  const collapsedDotClassName = badgeClassName
    ? "absolute -top-1 -end-1 w-2.5 h-2.5 rounded-full bg-amber-500 border-2 border-[#FAFAFA]"
    : "absolute -top-1 -end-1 w-2.5 h-2.5 rounded-full bg-destructive border-2 border-[#FAFAFA]";
  const defaultDestination = group.defaultPath &&
    (visibleChildren.find((child) => child.path === group.defaultPath)?.path ?? visibleChildren[0]?.path);
  const parentDestination = group.parentPath ?? defaultDestination;
  const parentTestId = group.parentPath
    ? `nav-${group.id}`
    : `nav-${group.id}-label`;
  const toggleTestId = group.parentPath
    ? `nav-${group.id}-toggle`
    : parentDestination
      ? `nav-${group.id}`
      : `nav-${group.id}-toggle`;
  return (
    <div>
      <div
        className={cn(
          "w-full flex items-center gap-3 px-3 h-11 rounded-lg text-sm font-medium transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
          anyChildActive || isOpen
            ? "bg-[#E6F4F6] text-[#064E5A]"
            : "text-foreground hover:bg-[#F3F4F6]",
        )}
      >
        {parentDestination ? (
          <Link
            href={parentDestination}
            aria-current={anyChildActive ? "location" : undefined}
            data-testid={parentTestId}
            className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
          >
            <span className="relative shrink-0">
              <GroupIcon size={20} strokeWidth={2} />
              {!isOpen && badge != null && badge > 0 && (
                <span
                  className={collapsedDotClassName}
                  data-testid={`${group.id}-collapsed-dot`}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="flex-1 text-left">{t(group.labelKey)}</span>
            {badge != null && badge > 0 && (
              <span
                className={cn("min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold flex items-center justify-center", resolvedBadgeClassName)}
                data-testid={`${group.id}-badge`}
                aria-label={t("nav.recipeAttention", { count: badge })}
              >
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </Link>
        ) : (
          <button
            onClick={onToggle}
            aria-expanded={isOpen}
            data-testid={`nav-${group.id}`}
            className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
          >
            <span className="relative shrink-0">
              <GroupIcon size={20} strokeWidth={2} />
              {!isOpen && badge != null && badge > 0 && (
                <span
                  className={collapsedDotClassName}
                  data-testid="people-access-collapsed-dot"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="flex-1 text-left">{t(group.labelKey)}</span>
            {badge != null && badge > 0 && (
              <span
                className={cn("min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold flex items-center justify-center", resolvedBadgeClassName)}
                data-testid="users-pending-badge"
              >
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={`nav-group-${group.id}`}
          aria-label={t(isOpen ? "nav.collapseGroup" : "nav.expandGroup", {
            name: t(group.labelKey),
          })}
          data-testid={toggleTestId}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-md hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490]"
        >
          <ChevronDown
            size={18}
            strokeWidth={2}
            className={cn(
              "shrink-0 transition-transform duration-150 ease-in-out",
              isOpen ? "rotate-0" : "-rotate-90",
            )}
          />
        </button>
      </div>
      {isOpen && (
        <div id={`nav-group-${group.id}`} className="mt-1 space-y-0.5">
          {visibleChildren.map((child) => {
            const ChildIcon = child.icon;
            const childActive = isNavItemActive(child, currentPath);
            const childLabel = t(child.labelKey);
            return (
              <Link
                key={child.path}
                href={child.path}
                aria-current={childActive ? "page" : undefined}
                data-testid={`nav-${childLabel.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "relative flex items-center gap-3 pl-[48px] pr-3 h-10 rounded-lg text-sm font-medium transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
                  childActive
                    ? "bg-[#E6F4F6] text-[#064E5A]"
                    : "text-[#1F2937] hover:bg-[#F0FAFB]",
                )}
              >
                {childActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 bg-[#064E5A] rounded-full" aria-hidden="true" />
                )}
                <ChildIcon size={18} strokeWidth={2} />
                <span className="flex-1">{childLabel}</span>
                {childBadges?.[child.path] != null && childBadges[child.path] > 0 && (
                  <span
                    className={cn("ml-auto min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold flex items-center justify-center", resolvedChildBadgeClassName)}
                      data-testid={childBadgeTestIds?.[child.path] ?? "attendance-correction-badge"}
                      aria-label={childBadgeAriaLabels?.[child.path]}
                  >
                    {childBadges[child.path] > 99 ? "99+" : childBadges[child.path]}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MobileNavGroupSection({
  group,
  visibleChildren,
  currentPath,
  isOpen,
  onToggle,
  childBadges,
  childBadgeClassName,
  childBadgeAriaLabels,
}: {
  group: NavGroup;
  visibleChildren: NavItem[];
  currentPath: string;
  isOpen?: boolean;
  onToggle?: () => void;
  childBadges?: Record<string, number>;
  childBadgeClassName?: string;
  childBadgeAriaLabels?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const anyChildActive = visibleChildren.some((child) => isNavItemActive(child, currentPath));
  const defaultDestination = group.defaultPath &&
    (visibleChildren.find((child) => child.path === group.defaultPath)?.path ?? visibleChildren[0]?.path);
  const parentDestination = group.parentPath ?? defaultDestination;
  const isInteractiveGroup = Boolean(onToggle);
  return (
    <>
      {parentDestination ? (
        <div
          className={cn(
            "flex whitespace-nowrap border-b-2",
            anyChildActive
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground",
          )}
        >
          <Link
            href={parentDestination}
            aria-current={anyChildActive ? "location" : undefined}
            data-testid={group.parentPath ? `nav-${group.id}-mobile` : `nav-${group.id}-label-mobile`}
            className="px-4 py-3 text-sm font-medium"
          >
            {t(group.labelKey)}
          </Link>
          {isInteractiveGroup && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={isOpen}
              aria-label={t(isOpen ? "nav.collapseGroup" : "nav.expandGroup", {
                name: t(group.labelKey),
              })}
              data-testid={group.parentPath ? `nav-${group.id}-mobile-toggle` : `nav-${group.id}-mobile`}
              className="px-2 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-inset"
            >
              <ChevronDown
                size={16}
                className={cn("transition-transform duration-150", isOpen ? "rotate-0" : "-rotate-90")}
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      ) : (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`nav-group-${group.id}-mobile`}
        data-testid={`nav-${group.id}-mobile`}
        className={cn(
          "px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2",
          anyChildActive
            ? "border-primary text-primary"
            : "border-transparent text-muted-foreground",
        )}
      >
        {t(group.labelKey)}
      </button>
      )}
      {(!isInteractiveGroup || isOpen) && visibleChildren.map((child) => {
        const childActive = isNavItemActive(child, currentPath);
        return (
          <Link
            key={child.path}
            href={child.path}
            aria-current={childActive ? "page" : undefined}
            className={cn(
              "relative px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2",
              childActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground",
            )}
          >
            <span>{t(child.labelKey)}</span>
            {childBadges?.[child.path] != null && childBadges[child.path] > 0 && (
              <span
                className={cn(
                  "ml-1 inline-flex min-w-[1rem] h-4 px-0.5 rounded-full text-[10px] font-semibold items-center justify-center",
                  childBadgeClassName ?? "bg-destructive text-destructive-foreground",
                )}
                aria-label={childBadgeAriaLabels?.[child.path]}
              >
                {childBadges[child.path] > 99 ? "99+" : childBadges[child.path]}
              </span>
            )}
          </Link>
        );
      })}
    </>
  );
}

function CollapsedNavLink({
  item,
  active,
  label,
  tooltipSide,
  showDot,
  dotClassName,
  dotTestId,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  tooltipSide: "left" | "right";
  showDot?: boolean;
  dotClassName?: string;
  dotTestId?: string;
}) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={item.path}
          aria-current={active ? "page" : undefined}
          aria-label={label}
          data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={cn(
            "relative flex items-center justify-center w-11 h-11 mx-auto rounded-lg transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
            active
              ? "bg-[#E6F4F6] text-[#064E5A]"
              : "text-foreground hover:bg-[#F3F4F6]",
          )}
        >
          <Icon size={20} strokeWidth={2} />
          {showDot && (
            <span
              className={cn(
                "absolute top-1.5 end-1.5 w-2 h-2 rounded-full border-2 border-white",
                dotClassName ?? "bg-destructive",
              )}
              data-testid={dotTestId}
              aria-hidden="true"
            />
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

function CollapsedNavGroup({
  group,
  visibleChildren,
  currentPath,
  tooltipSide,
  badge,
  badgeClassName,
  childBadges,
  childBadgeClassName,
  childBadgeAriaLabels,
  childBadgeTestIds,
}: {
  group: NavGroup;
  visibleChildren: NavItem[];
  currentPath: string;
  tooltipSide: "left" | "right";
  badge?: number;
  badgeClassName?: string;
  childBadges?: Record<string, number>;
  childBadgeClassName?: string;
  childBadgeAriaLabels?: Record<string, string>;
  childBadgeTestIds?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const GroupIcon = group.icon;
  const anyChildActive = visibleChildren.some((child) => isNavItemActive(child, currentPath));
  const groupLabel = t(group.labelKey);
  const resolvedChildBadgeClassName = childBadgeClassName ?? "bg-destructive text-destructive-foreground";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={groupLabel}
              data-testid={`nav-${group.id}`}
              className={cn(
                "relative flex items-center justify-center w-11 h-11 mx-auto rounded-lg transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
                anyChildActive
                  ? "bg-[#E6F4F6] text-[#064E5A]"
                  : "text-foreground hover:bg-[#F3F4F6]",
              )}
            >
              <GroupIcon size={20} strokeWidth={2} />
              {badge != null && badge > 0 && (
                <span
                  className={cn(
                    "absolute top-1.5 end-1.5 w-2 h-2 rounded-full border-2 border-white",
                    badgeClassName ? "bg-amber-500" : "bg-destructive",
                  )}
                  data-testid={`${group.id}-collapsed-dot`}
                  aria-hidden="true"
                />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>{groupLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side={tooltipSide} align="start" className="w-60">
        <DropdownMenuLabel>{groupLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {visibleChildren.map((child) => {
          const ChildIcon = child.icon;
          const childActive = isNavItemActive(child, currentPath);
          const childLabel = t(child.labelKey);
          const childBadge = childBadges?.[child.path];
          return (
            <DropdownMenuItem
              key={child.path}
              asChild
              className={cn(
                "gap-2 cursor-pointer",
                childActive && "bg-[#E6F4F6] text-[#064E5A] focus:bg-[#E6F4F6] focus:text-[#064E5A]",
              )}
              data-testid={`nav-${childLabel.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <Link href={child.path} aria-current={childActive ? "page" : undefined}>
                <ChildIcon size={16} strokeWidth={2} />
                <span className="flex-1">{childLabel}</span>
                {childBadge != null && childBadge > 0 && (
                  <span
                    className={cn(
                      "min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold flex items-center justify-center",
                      resolvedChildBadgeClassName,
                    )}
                    data-testid={childBadgeTestIds?.[child.path]}
                    aria-label={childBadgeAriaLabels?.[child.path]}
                  >
                    {childBadge > 99 ? "99+" : childBadge}
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";
const SIDEBAR_OPEN_GROUPS_KEY = "sidebarOpenGroups";
const SIDEBAR_CLOSED_GROUPS_KEY = "sidebarClosedGroups";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [location] = useLocation();
  usePageTitle();
  const { user } = useUser();
  const { signOut } = useClerk();
  const {
    isOwner,
    realIsOwner,
    allowedPages,
    customRoleId,
    customRoleIds,
    floristLocationId,
  } = useWorkspaceRole();
  const { simulatedRole, setSimulatedRole } = useSimulatedRole();
  // Issue workspace image cookie so browser <img> tags can load tenant images.
  // ready becomes true once the first attempt completes (success or error).
  const { ready: imgTokenReady } = useWorkspaceImageToken();
  const { data: rolesData } = useRoles();
  const customRoles = rolesData?.roles ?? [];

  useEffect(() => {
    const bridge = (
      window as Window & {
        ReactNativeWebView?: { postMessage: (message: string) => void };
      }
    ).ReactNativeWebView;
    bridge?.postMessage(
      JSON.stringify({ type: "presentail.dashboard.ready" }),
    );
  }, []);

  const effectiveCustomRoleIds =
    customRoleIds ?? (customRoleId != null ? [customRoleId] : []);

  const roleLabel = realIsOwner
    ? t("common.owner")
    : effectiveCustomRoleIds.length > 0
      ? (effectiveCustomRoleIds
          .map((id) => customRoles.find((r) => r.id === id)?.name)
          .filter((n): n is string => !!n)
          .join(", ") || t("common.noRole"))
      : t("common.noRole");

  const visibleNav = NAV.filter((item) =>
    isNavVisible(item, isOwner, realIsOwner, allowedPages),
  );

  const ALL_NAV_GROUPS = NAV_SECTIONS;

  const { data: accessRequestsData, isLoading: accessRequestsLoading } = usePendingAccessRequests(realIsOwner);
  const pendingRequests = accessRequestsData?.requests ?? [];
  const pendingRequestCount = pendingRequests.length;

  const {
    notifications: lowStockNotifications,
    seenIds: lowStockSeenIds,
    addNotification: addLowStockNotification,
    markSeen: markLowStockSeen,
    dismiss: dismissLowStockNotification,
    dismissAll: dismissAllLowStockNotifications,
  } = useLowStockNotifications();

  useLowStockSse(
    realIsOwner || (allowedPages?.includes("base_items.manage") ?? false),
    addLowStockNotification,
  );

  const {
    notifications: newOrderNotifications,
    seenIds: newOrderSeenIds,
    addNotification: addNewOrderNotification,
    markSeen: markNewOrderSeen,
    dismiss: dismissNewOrderNotification,
    dismissAll: dismissAllNewOrderNotifications,
  } = useNewOrderNotifications();

  const {
    notifications: cashSessionNotifications,
    seenIds: cashSessionSeenIds,
    addNotification: addCashSessionNotification,
    markSeen: markCashSessionSeen,
    dismiss: dismissCashSessionNotification,
    dismissAll: dismissAllCashSessionNotifications,
  } = useCashSessionNotifications();

  const { salaryDecisions, ackSalaryDecisions } = useSalaryApprovalNotifications(Boolean(user));

  const {
    alerts: newOrderAlerts,
    addAlert: addNewOrderAlert,
    acknowledge: acknowledgeNewOrderAlert,
    acknowledgeAll: acknowledgeAllNewOrderAlerts,
    muted: newOrderSoundMuted,
    setMuted: setNewOrderSoundMuted,
    soundBlocked: newOrderSoundBlocked,
  } = useNewOrderAlertQueue();

  useNewOrderSse(
    realIsOwner || (allowedPages?.includes("orders") ?? false),
    useCallback(
      (event: NewOrderEvent) => {
        addNewOrderNotification(event);
        addNewOrderAlert(event);
      },
      [addNewOrderNotification, addNewOrderAlert],
    ),
  );

  // Florist-assignment alerts: only for users tied to a florist location who
  // can see the florist queue. The hook also filters events by location.
  useFloristAssignmentSse(
    allowedPages?.includes("florist_orders") ?? false,
    floristLocationId,
    useCallback(
      (event: FloristAssignmentEvent) => {
        addNewOrderNotification({
          orderId: event.orderId,
          displayOrderNumber: event.displayOrderNumber,
          customerName: null,
          total: null,
          currency: null,
          kind: "assigned",
          assignedAt: event.assignedAt,
        });
      },
      [addNewOrderNotification],
    ),
  );

  // Cash-session alerts: owners and members with cash_sessions.approve permission
  // see toasts + bell entries when a session is flagged or open too long.
  useCashSessionAlertSse(
    realIsOwner || (allowedPages?.includes("cash_sessions.approve") ?? false),
    useCallback(
      (event: CashSessionAlertEvent) => {
        addCashSessionNotification({
          kind: event.kind,
          sessionId: event.sessionId,
          sessionNumber: event.sessionNumber,
          drawerName: event.drawerName,
          locationName: event.locationName,
        });
      },
      [addCashSessionNotification],
    ),
  );

  // CMC shelf-sale alerts: users with cmc_pos access see the loud-ring banner,
  // a toast, and a bell entry whenever a new shelf sale is recorded.
  useNewCmcSaleSse(
    realIsOwner || (allowedPages?.includes("cmc-pos") ?? false),
    useCallback(
      (event: CmcSaleEvent) => {
        addNewOrderAlert({
          orderId: event.saleId,
          displayOrderNumber: null,
          customerName: null,
          total: event.total,
          currency: null,
        });
        addNewOrderNotification({
          orderId: event.saleId,
          displayOrderNumber: null,
          customerName: null,
          total: event.total,
          currency: null,
        });
      },
      [addNewOrderAlert, addNewOrderNotification],
    ),
  );

  const { hasErrorChannels } = useChannelErrorAlert(realIsOwner);

  const sseState = useOmnichannelSSE();
  const inboxUnreadCount = useInboxUnreadCount();
  const pendingOrdersCount = usePendingOrdersCount();
  const canReviewFloristPhotos =
    isOwner || (allowedPages?.includes("orders") ?? false);
  const floristManualReviewCount = useFloristManualReviewCount(
    canReviewFloristPhotos,
  );
  const reorderCount = useReorderCount();
  const canReviewRecipes =
    realIsOwner || (allowedPages?.includes("products.manage") ?? false);
  const recipeAttention = useRecipeAttention(canReviewRecipes);
  // Deliberately leave this undefined while loading or after an error. A zero
  // badge means a confirmed empty queue, never an unavailable request.
  const recipeAttentionCount =
    recipeAttention.data && !recipeAttention.isError
      ? recipeAttention.data.attention_count
      : undefined;

  const { data: timeOffNotifData, isLoading: timeOffNotifLoading } = useTimeOffNotifications(!realIsOwner);
  const timeOffNotifications = timeOffNotifData?.notifications ?? [];

  const {
    requests: correctionRequests,
    seenIds: correctionSeenIds,
    markSeen: markCorrectionSeen,
    isLoading: correctionLoading,
  } = useAttendanceCorrectionNotifications(
    realIsOwner || allowedPages?.includes("people.attendance") === true,
  );

  const notificationBellLoading = accessRequestsLoading || timeOffNotifLoading || correctionLoading;

  const currentPath = (() => {
    if (location.startsWith("/locations/")) return "/locations";
    return location;
  })();

  const isGroupChild = (group: NavGroup, path: string) =>
    group.children.some((child) => isNavItemActive(child, path));
  const sidebarIdentity = user?.id ?? "anonymous";
  const sidebarStorageKey = (key: string) => `${key}:${sidebarIdentity}`;

  const manuallyClosedGroupsRef = useRef<Set<string>>(new Set());
  const userOpenedGroupsRef = useRef<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(sidebarStorageKey(SIDEBAR_OPEN_GROUPS_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_OPEN_GROUPS_KEY) : null);
      const closed = localStorage.getItem(sidebarStorageKey(SIDEBAR_CLOSED_GROUPS_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_CLOSED_GROUPS_KEY) : null);
      if (closed) manuallyClosedGroupsRef.current = new Set(JSON.parse(closed) as string[]);
      if (raw) {
        const persistedOpenGroups = new Set(JSON.parse(raw) as string[]);
        userOpenedGroupsRef.current = persistedOpenGroups;
        ALL_NAV_GROUPS
          .filter((group) => isGroupChild(group, currentPath))
          .forEach((group) => persistedOpenGroups.add(group.id));
        return persistedOpenGroups;
      }
    } catch {
      // Use route context below when browser storage is unavailable.
    }
    return new Set(ALL_NAV_GROUPS.filter((group) => isGroupChild(group, currentPath)).map((group) => group.id));
  });

  const persistOpenGroups = (groups: Set<string>) => {
    try {
      localStorage.setItem(sidebarStorageKey(SIDEBAR_OPEN_GROUPS_KEY), JSON.stringify([...groups]));
    } catch {
      // Navigation should remain functional in privacy-restricted browsers.
    }
  };

  const persistClosedGroups = () => {
    try {
      localStorage.setItem(
        sidebarStorageKey(SIDEBAR_CLOSED_GROUPS_KEY),
        JSON.stringify([...manuallyClosedGroupsRef.current]),
      );
    } catch {
      // Navigation should remain functional in privacy-restricted browsers.
    }
  };

  useEffect(() => {
    ALL_NAV_GROUPS.forEach((group) => {
      const groupId = group.id;
      if (isGroupChild(group, currentPath)) {
        setOpenGroups((prev) => new Set([...prev, groupId]));
      } else if (!userOpenedGroupsRef.current.has(groupId)) {
        setOpenGroups((prev) => {
          const next = new Set(prev);
          next.delete(groupId);
          return next;
        });
      }
    });
  }, [currentPath]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        userOpenedGroupsRef.current.delete(id);
        manuallyClosedGroupsRef.current.add(id);
      } else {
        next.add(id);
        userOpenedGroupsRef.current.add(id);
        manuallyClosedGroupsRef.current.delete(id);
      }
      persistOpenGroups(next);
      persistClosedGroups();
      return next;
    });
  };

  const handleSignOut = () => signOut({ redirectUrl: `${basePath}/` });

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return (localStorage.getItem(sidebarStorageKey(SIDEBAR_COLLAPSED_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_COLLAPSED_KEY) : null)) === "1";
    } catch {
      return false;
    }
  });

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(sidebarStorageKey(SIDEBAR_COLLAPSED_KEY), next ? "1" : "0");
      } catch {
      }
      return next;
    });
  };

  useEffect(() => {
    try {
      const rawOpen = localStorage.getItem(sidebarStorageKey(SIDEBAR_OPEN_GROUPS_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_OPEN_GROUPS_KEY) : null);
      const rawClosed = localStorage.getItem(sidebarStorageKey(SIDEBAR_CLOSED_GROUPS_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_CLOSED_GROUPS_KEY) : null);
      const savedOpen = new Set<string>(rawOpen ? JSON.parse(rawOpen) : []);
      ALL_NAV_GROUPS.filter((group) => isGroupChild(group, currentPath))
        .forEach((group) => savedOpen.add(group.id));
      userOpenedGroupsRef.current = new Set(savedOpen);
      manuallyClosedGroupsRef.current = new Set(rawClosed ? JSON.parse(rawClosed) : []);
      setOpenGroups(savedOpen);
      const rawCollapsed = localStorage.getItem(sidebarStorageKey(SIDEBAR_COLLAPSED_KEY))
        ?? (sidebarIdentity === "anonymous" ? localStorage.getItem(SIDEBAR_COLLAPSED_KEY) : null);
      setSidebarCollapsed(rawCollapsed === "1");
    } catch {
      // Storage can be unavailable; retain the in-memory navigation state.
    }
  }, [sidebarIdentity]);

  const isRtl = i18n.dir() === "rtl";
  const flyoutSide: "left" | "right" = isRtl ? "left" : "right";

  type NavGroupConfig = {
    group: NavGroup;
    insertAfterPath: string;
    visible: boolean;
    visibleChildren: NavItem[];
    badge?: number;
    badgeClassName?: string;
    childBadges?: Record<string, number>;
    childBadgeClassName?: string;
    childBadgeAriaLabels?: Record<string, string>;
    childBadgeTestIds?: Record<string, string>;
  };
  const navGroupConfigs: NavGroupConfig[] = NAV_SECTIONS.map((group) => {
    const visibleChildren = group.children.filter((item) =>
      isNavVisible(item, isOwner, realIsOwner, allowedPages),
    );
    const config: NavGroupConfig = {
      group,
      insertAfterPath: "/project-manager-dashboard",
      visible: isNavGroupVisible(group, isOwner, realIsOwner, allowedPages),
      visibleChildren,
    };
    if (group.id === "catalog" && recipeAttentionCount && recipeAttentionCount > 0) {
      config.badge = recipeAttentionCount;
      config.badgeClassName = "bg-amber-500 text-white";
      config.childBadges = {
        "/products": recipeAttentionCount,
        "/recipe-review": recipeAttentionCount,
      };
      config.childBadgeClassName = "bg-amber-500 text-white";
      config.childBadgeAriaLabels = {
        "/products": t("nav.recipeAttention", { count: recipeAttentionCount }),
        "/recipe-review": t("nav.recipeAttention", { count: recipeAttentionCount }),
      };
      config.childBadgeTestIds = {
        "/products": "all-products-count-badge",
        "/recipe-review": "recipe-attention-badge",
      };
    }
    if (group.id === "purchasing" && reorderCount > 0) {
      config.childBadges = { "/suppliers/reorder": reorderCount };
      config.childBadgeClassName = "bg-amber-500 text-white";
    }
    if (group.id === "orders-delivery" && canReviewFloristPhotos && floristManualReviewCount > 0) {
      config.badge = floristManualReviewCount;
      config.childBadges = { "/florist-orders": floristManualReviewCount };
      config.childBadgeTestIds = { "/florist-orders": "florist-manual-review-badge" };
    }
    if (group.id === "team") {
      config.badge = realIsOwner && pendingRequestCount > 0 ? pendingRequestCount : undefined;
      config.childBadges = correctionRequests.length > 0
        ? { ...(config.childBadges ?? {}), "/admin/attendance/requests": correctionRequests.length }
        : config.childBadges;
    }
    return config;
  });

  return (
    <OmnichannelSSEContext.Provider value={sseState}>
    <div className="min-h-[100dvh] md:h-[100dvh] w-full bg-background text-foreground flex flex-col md:overflow-hidden">
      {simulatedRole && (
        <div
          className="sticky top-0 z-50 shrink-0 flex items-center justify-between gap-4 bg-amber-500 px-4 py-2 text-white shadow-md"
          data-testid="impersonation-banner"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Eye size={16} />
            <span>{t("nav.viewingAs", { name: simulatedRole.name })}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-white hover:bg-amber-600 hover:text-white"
            onClick={() => setSimulatedRole(null)}
            data-testid="exit-simulation-button"
          >
            <X size={14} />
            {t("nav.exit")}
          </Button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar — desktop only */}
        <aside
          className={cn(
            "hidden md:flex flex-col min-h-0 border-e border-[#E5E7EB] transition-[width] duration-200 ease-in-out",
            sidebarCollapsed ? "w-[72px] bg-white" : "w-64 bg-[#FAFAFA]",
          )}
          data-testid="dashboard-sidebar"
          data-state={sidebarCollapsed ? "collapsed" : "expanded"}
        >
          {sidebarCollapsed ? (
            <div className="py-4 shrink-0 flex flex-col items-center gap-2 border-b border-border">
              <Link href="/" className="flex items-center justify-center" aria-label="Presentail OS">
                <img
                  src="/presentail-logo.png"
                  aria-hidden="true"
                  className="w-10 h-10 rounded-md object-cover"
                />
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleSidebarCollapsed}
                    aria-label={t("nav.expandSidebar")}
                    data-testid="sidebar-toggle"
                    className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:bg-[#F3F4F6] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2"
                  >
                    <ChevronRight size={18} strokeWidth={2} className="rtl:rotate-180" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side={flyoutSide}>{t("nav.expandSidebar")}</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <div className="p-6 border-b border-border shrink-0 relative">
              <Link href="/" className="flex items-center gap-3">
                <img
                  src="/presentail-logo.png"
                  aria-hidden="true"
                  className="w-12 h-12 rounded-md object-cover"
                />
                <span className="font-bold text-lg tracking-tight">
                  Presentail OS
                </span>
              </Link>
              <button
                onClick={toggleSidebarCollapsed}
                aria-label={t("nav.collapseSidebar")}
                data-testid="sidebar-toggle"
                className="absolute top-2 end-2 flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:bg-[#F3F4F6] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2"
              >
                <ChevronLeft size={18} strokeWidth={2} className="rtl:rotate-180" />
              </button>
            </div>
          )}

          {sidebarCollapsed ? (
            <nav className="flex-1 min-h-0 overflow-y-auto py-3 px-2 space-y-1">
              {visibleNav.map((item) => {
                const active = isNavItemActive(item, currentPath);
                const label = t(item.labelKey);
                const showChannelErrorDot = item.path === "/settings/channels" && realIsOwner && hasErrorChannels;
                const showInboxDot = item.path === "/omnichannel/inbox" && inboxUnreadCount > 0;
                const showOrdersDot = item.path === "/orders" && pendingOrdersCount > 0;
                const showFloristReviewDot =
                  item.path === "/florist-orders" &&
                  canReviewFloristPhotos &&
                  floristManualReviewCount > 0;
                const groupsAfterItem = navGroupConfigs.filter(
                  (ng) => ng.visible && item.path === ng.insertAfterPath,
                );
                return (
                  <div key={item.path} className="space-y-1">
                    <CollapsedNavLink
                      item={item}
                      active={active}
                      label={label}
                      tooltipSide={flyoutSide}
                      showDot={
                        showChannelErrorDot ||
                        showInboxDot ||
                        showOrdersDot ||
                        showFloristReviewDot
                      }
                      dotTestId={
                        showFloristReviewDot
                          ? "florist-manual-review-collapsed-dot"
                          : undefined
                      }
                    />
                    {item.path === "/project-manager-dashboard" && (
                      <div className="my-2 border-t border-border" aria-hidden="true" />
                    )}
                    {groupsAfterItem.map((ng) => (
                      <CollapsedNavGroup
                        key={ng.group.id}
                        group={ng.group}
                        visibleChildren={ng.visibleChildren}
                        currentPath={currentPath}
                        tooltipSide={flyoutSide}
                        badge={ng.badge}
                        badgeClassName={ng.badgeClassName}
                        childBadges={ng.childBadges}
                        childBadgeClassName={ng.childBadgeClassName}
                        childBadgeAriaLabels={ng.childBadgeAriaLabels}
                        childBadgeTestIds={ng.childBadgeTestIds}
                      />
                    ))}
                  </div>
                );
              })}
              {navGroupConfigs
                .filter((ng) => ng.visible && !visibleNav.some((item) => item.path === ng.insertAfterPath))
                .map((ng) => (
                  <CollapsedNavGroup
                    key={ng.group.id}
                    group={ng.group}
                    visibleChildren={ng.visibleChildren}
                    currentPath={currentPath}
                    tooltipSide={flyoutSide}
                    badge={ng.badge}
                    badgeClassName={ng.badgeClassName}
                    childBadges={ng.childBadges}
                    childBadgeClassName={ng.childBadgeClassName}
                        childBadgeAriaLabels={ng.childBadgeAriaLabels}
                        childBadgeTestIds={ng.childBadgeTestIds}
                  />
                ))}
            </nav>
          ) : (
          <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-0.5">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              const active = isNavItemActive(item, currentPath);
              const label = t(item.labelKey);
              const showBadge = false; // pending-requests badge moved to PEOPLE_ACCESS_GROUP header
              const showChannelErrorDot = item.path === "/settings/channels" && realIsOwner && hasErrorChannels;
              const showInboxBadge = item.path === "/omnichannel/inbox" && inboxUnreadCount > 0;
              const showOrdersBadge = item.path === "/orders" && pendingOrdersCount > 0;
              const showFloristReviewBadge =
                item.path === "/florist-orders" &&
                canReviewFloristPhotos &&
                floristManualReviewCount > 0;
              const groupsAfterItem = navGroupConfigs.filter(
                (ng) => ng.visible && item.path === ng.insertAfterPath,
              );
              return (
                <div key={item.path}>
                  <Link
                    href={item.path}
                    aria-current={active ? "page" : undefined}
                    data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                    className={cn(
                      "relative flex items-center gap-3 px-3 h-11 rounded-lg text-sm font-medium transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
                      active
                        ? "bg-[#E6F4F6] text-[#064E5A]"
                        : "text-foreground hover:bg-[#F3F4F6]",
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 bg-[#064E5A] rounded-full" aria-hidden="true" />
                    )}
                    <Icon size={20} strokeWidth={2} />
                    <span className="flex-1">{label}</span>
                    {showInboxBadge && (
                      <span
                        className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold flex items-center justify-center"
                        data-testid="inbox-unread-badge"
                      >
                        {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
                      </span>
                    )}
                    {showOrdersBadge && (
                      <span
                        className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold flex items-center justify-center"
                        data-testid="orders-pending-badge"
                      >
                        {pendingOrdersCount > 99 ? "99+" : pendingOrdersCount}
                      </span>
                    )}
                    {showFloristReviewBadge && (
                      <span
                        className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold flex items-center justify-center"
                        data-testid="florist-manual-review-badge"
                      >
                        {floristManualReviewCount > 99
                          ? "99+"
                          : floristManualReviewCount}
                      </span>
                    )}
                    {showBadge && (
                      <span
                        className="ml-auto min-w-[1.25rem] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-semibold flex items-center justify-center"
                        data-testid="users-pending-badge"
                      >
                        {pendingRequestCount > 99 ? "99+" : pendingRequestCount}
                      </span>
                    )}
                    {showChannelErrorDot && (
                      <span
                        className="ml-auto w-2 h-2 rounded-full bg-destructive shrink-0"
                        data-testid="channels-error-dot"
                        aria-label="Channel error"
                      />
                    )}
                  </Link>
                  {item.path === "/project-manager-dashboard" && (
                    <div className="my-2 border-t border-border" aria-hidden="true" />
                  )}
                  {groupsAfterItem.map((ng) => (
                    <NavGroupSection
                      key={ng.group.id}
                      group={ng.group}
                      visibleChildren={ng.visibleChildren}
                      isOpen={openGroups.has(ng.group.id)}
                      onToggle={() => toggleGroup(ng.group.id)}
                      currentPath={currentPath}
                      badge={ng.badge}
                      badgeClassName={ng.badgeClassName}
                      childBadges={ng.childBadges}
                      childBadgeClassName={ng.childBadgeClassName}
                      childBadgeAriaLabels={ng.childBadgeAriaLabels}
                      childBadgeTestIds={ng.childBadgeTestIds}
                    />
                  ))}
                </div>
              );
            })}
            {navGroupConfigs
              .filter((ng) => ng.visible && !visibleNav.some((item) => item.path === ng.insertAfterPath))
              .map((ng) => (
                <NavGroupSection
                  key={ng.group.id}
                  group={ng.group}
                  visibleChildren={ng.visibleChildren}
                  isOpen={openGroups.has(ng.group.id)}
                  onToggle={() => toggleGroup(ng.group.id)}
                  currentPath={currentPath}
                  badge={ng.badge}
                  badgeClassName={ng.badgeClassName}
                  childBadges={ng.childBadges}
                  childBadgeClassName={ng.childBadgeClassName}
                    childBadgeAriaLabels={ng.childBadgeAriaLabels}
                    childBadgeTestIds={ng.childBadgeTestIds}
                />
              ))}
          </nav>
          )}

          {realIsOwner && sidebarCollapsed && (
            <div className="shrink-0 py-3 border-t border-border bg-white flex justify-center">
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label={t("nav.viewAsRole")}
                        data-testid="view-as-select"
                        className={cn(
                          "relative flex items-center justify-center w-11 h-11 rounded-lg transition-all duration-150 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E7490] focus-visible:ring-offset-2",
                          simulatedRole
                            ? "bg-[#E6F4F6] text-[#064E5A]"
                            : "text-foreground hover:bg-[#F3F4F6]",
                        )}
                      >
                        <Eye size={20} strokeWidth={2} />
                        {simulatedRole && (
                          <span className="absolute top-1.5 end-1.5 w-2 h-2 rounded-full bg-amber-500 border-2 border-white" aria-hidden="true" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side={flyoutSide}>{t("nav.viewAsRole")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side={flyoutSide} align="end" className="w-56">
                  <DropdownMenuLabel>{t("nav.viewAsRole")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className={cn("cursor-pointer", !simulatedRole && "bg-[#E6F4F6] text-[#064E5A] focus:bg-[#E6F4F6] focus:text-[#064E5A]")}
                    onClick={() => setSimulatedRole(null)}
                  >
                    {t("nav.yourOwnView")}
                  </DropdownMenuItem>
                  {customRoles.map((r) => (
                    <DropdownMenuItem
                      key={r.id}
                      className={cn(
                        "cursor-pointer",
                        simulatedRole?.id === r.id && "bg-[#E6F4F6] text-[#064E5A] focus:bg-[#E6F4F6] focus:text-[#064E5A]",
                      )}
                      onClick={() =>
                        setSimulatedRole({ id: r.id, name: r.name })
                      }
                    >
                      {r.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {realIsOwner && !sidebarCollapsed && (
            <div className="shrink-0 px-4 py-3 border-t border-border bg-card">
              <p className="text-xs text-muted-foreground mb-1.5 font-medium">{t("nav.viewAsRole")}</p>
              <Select
                value={simulatedRole ? String(simulatedRole.id) : ""}
                onValueChange={(val) => {
                  if (val === "") {
                    setSimulatedRole(null);
                  } else {
                    const found = customRoles.find((r) => String(r.id) === val);
                    if (found) {
                      setSimulatedRole({ id: found.id, name: found.name });
                    }
                  }
                }}
              >
                <SelectTrigger
                  className="w-full h-8 text-xs"
                  data-testid="view-as-select"
                >
                  <SelectValue placeholder={t("nav.yourOwnView")} />
                </SelectTrigger>
                <SelectContent>
                  {customRoles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </aside>

        <div
          className="flex-1 min-w-0 flex flex-col md:min-h-0 md:overflow-y-auto md:scroll-pt-[72px]"
          data-dashboard-scroll-container
          data-testid="dashboard-content-scroll"
        >
          {/* Mobile top bar */}
          <div className="md:hidden fixed top-0 inset-x-0 bg-card border-b border-border z-40 flex items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2">
              <img
                src="/presentail-logo.png"
                aria-hidden="true"
                className="w-8 h-8 rounded-md object-cover"
              />
              <span className="font-bold">Presentail OS</span>
            </Link>
            <div className="flex items-center gap-2">
              <NotificationBell
                requests={pendingRequests}
                timeOffNotifications={timeOffNotifications}
                correctionRequests={correctionRequests}
                correctionSeenIds={correctionSeenIds}
                onMarkCorrectionSeen={markCorrectionSeen}
                lowStockNotifications={lowStockNotifications}
                lowStockSeenIds={lowStockSeenIds}
                onMarkLowStockSeen={markLowStockSeen}
                onDismissLowStock={dismissLowStockNotification}
                onDismissAllLowStock={dismissAllLowStockNotifications}
                newOrderNotifications={newOrderNotifications}
                newOrderSeenIds={newOrderSeenIds}
                onMarkNewOrderSeen={markNewOrderSeen}
                onDismissNewOrder={dismissNewOrderNotification}
                onDismissAllNewOrders={dismissAllNewOrderNotifications}
                cashSessionNotifications={cashSessionNotifications}
                cashSessionSeenIds={cashSessionSeenIds}
                onMarkCashSessionSeen={markCashSessionSeen}
                onDismissCashSession={dismissCashSessionNotification}
                onDismissAllCashSessions={dismissAllCashSessionNotifications}
                salaryDecisionNotifications={salaryDecisions}
                onAckSalaryDecisions={ackSalaryDecisions}
                isLoading={notificationBellLoading}
              />
              {user && (
                <UserDropdown user={user} roleLabel={roleLabel} profileLabel={t("nav.profile")} signOutLabel={t("nav.signOut")} onSignOut={handleSignOut} />
              )}
            </div>
          </div>

          {/* Desktop top header bar */}
          <header className="hidden md:flex items-center justify-end gap-3 px-6 py-3 border-b border-border bg-card">
            <NotificationBell
              requests={pendingRequests}
              timeOffNotifications={timeOffNotifications}
              correctionRequests={correctionRequests}
              correctionSeenIds={correctionSeenIds}
              onMarkCorrectionSeen={markCorrectionSeen}
              lowStockNotifications={lowStockNotifications}
              lowStockSeenIds={lowStockSeenIds}
              onMarkLowStockSeen={markLowStockSeen}
              onDismissLowStock={dismissLowStockNotification}
              onDismissAllLowStock={dismissAllLowStockNotifications}
              newOrderNotifications={newOrderNotifications}
              newOrderSeenIds={newOrderSeenIds}
              onMarkNewOrderSeen={markNewOrderSeen}
              onDismissNewOrder={dismissNewOrderNotification}
              onDismissAllNewOrders={dismissAllNewOrderNotifications}
              cashSessionNotifications={cashSessionNotifications}
              cashSessionSeenIds={cashSessionSeenIds}
              onMarkCashSessionSeen={markCashSessionSeen}
              onDismissCashSession={dismissCashSessionNotification}
              onDismissAllCashSessions={dismissAllCashSessionNotifications}
              salaryDecisionNotifications={salaryDecisions}
              onAckSalaryDecisions={ackSalaryDecisions}
              isLoading={notificationBellLoading}
            />
            {user && (
              <UserDropdown user={user} roleLabel={roleLabel} profileLabel={t("nav.profile")} signOutLabel={t("nav.signOut")} onSignOut={handleSignOut} primaryInstance />
            )}
          </header>

          <main className="min-w-0 pt-16 md:pt-0 flex flex-col">
            <div className="md:hidden border-b border-border bg-card overflow-x-auto">
              <div className="flex">
                {visibleNav.map((item) => {
                  const active = isNavItemActive(item, currentPath);
                  const showMobileBadge = item.path === "/users" && realIsOwner && pendingRequestCount > 0;
                  const showMobileChannelErrorDot = item.path === "/settings/channels" && realIsOwner && hasErrorChannels;
                  const showMobileInboxBadge = item.path === "/omnichannel/inbox" && inboxUnreadCount > 0;
                  const showMobileOrdersBadge = item.path === "/orders" && pendingOrdersCount > 0;
                  const groupsAfterItemMobile = navGroupConfigs.filter(
                    (ng) => ng.visible && item.path === ng.insertAfterPath,
                  );
                  return (
                    <div key={item.path} className="flex">
                      <Link
                        href={item.path}
                        className={cn(
                          "relative px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2",
                          active
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground",
                        )}
                      >
                        {t(item.labelKey)}
                        {showMobileInboxBadge && (
                          <span
                            className="absolute top-1.5 right-1 min-w-[1rem] h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center"
                            data-testid="inbox-unread-badge-mobile"
                          >
                            {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
                          </span>
                        )}
                        {showMobileOrdersBadge && (
                          <span
                            className="absolute top-1.5 right-1 min-w-[1rem] h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center"
                            data-testid="orders-pending-badge-mobile"
                          >
                            {pendingOrdersCount > 99 ? "99+" : pendingOrdersCount}
                          </span>
                        )}
                        {showMobileBadge && (
                          <span className="absolute top-1.5 right-1 min-w-[1rem] h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center">
                            {pendingRequestCount > 99 ? "99+" : pendingRequestCount}
                          </span>
                        )}
                        {showMobileChannelErrorDot && (
                          <span
                            className="absolute top-1.5 right-1 w-2 h-2 rounded-full bg-destructive"
                            data-testid="channels-error-dot-mobile"
                            aria-label="Channel error"
                          />
                        )}
                      </Link>
                      {groupsAfterItemMobile.map((ng) => (
                        <MobileNavGroupSection
                          key={ng.group.id}
                          group={ng.group}
                          visibleChildren={ng.visibleChildren}
                          currentPath={currentPath}
                          isOpen={openGroups.has(ng.group.id)}
                          onToggle={() => toggleGroup(ng.group.id)}
                          childBadges={ng.childBadges}
                          childBadgeClassName={ng.childBadgeClassName}
                          childBadgeAriaLabels={ng.childBadgeAriaLabels}
                        />
                      ))}
                    </div>
                  );
                })}
                {navGroupConfigs
                  .filter((ng) => ng.visible && !visibleNav.some((item) => item.path === ng.insertAfterPath))
                  .map((ng) => (
                    <MobileNavGroupSection
                      key={ng.group.id}
                      group={ng.group}
                      visibleChildren={ng.visibleChildren}
                      currentPath={currentPath}
                      isOpen={openGroups.has(ng.group.id)}
                      onToggle={() => toggleGroup(ng.group.id)}
                      childBadges={ng.childBadges}
                      childBadgeClassName={ng.childBadgeClassName}
                      childBadgeAriaLabels={ng.childBadgeAriaLabels}
                    />
                  ))}
              </div>
            </div>

            {realIsOwner && (
              <div className="md:hidden flex items-center gap-2 px-4 py-2 bg-card border-b border-border">
                <Eye size={14} className="text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">{t("nav.viewAsRole")}:</span>
                <Select
                  value={simulatedRole ? String(simulatedRole.id) : ""}
                  onValueChange={(val) => {
                    if (val === "") {
                      setSimulatedRole(null);
                    } else {
                      const found = customRoles.find((r) => String(r.id) === val);
                      if (found) {
                        setSimulatedRole({ id: found.id, name: found.name });
                      }
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-7 text-xs flex-1"
                    data-testid="mobile-view-as-select"
                  >
                    <SelectValue placeholder={t("nav.yourOwnView")} />
                  </SelectTrigger>
                  <SelectContent>
                    {customRoles.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <NewSessionBanner />
            <DataSaverBanner />
            <NewOrderAlertBanner
              alerts={newOrderAlerts}
              muted={newOrderSoundMuted}
              soundBlocked={newOrderSoundBlocked}
              onAcknowledge={acknowledgeNewOrderAlert}
              onAcknowledgeAll={acknowledgeAllNewOrderAlerts}
              onToggleMute={() => setNewOrderSoundMuted(!newOrderSoundMuted)}
            />

            <div className={location.startsWith("/cmc-pos/sales") ? "p-6 md:p-10" : "p-6 md:p-10 max-w-screen-2xl mx-auto"}>
              {imgTokenReady ? children : null}
            </div>
          </main>
        </div>
      </div>
    </div>
    </OmnichannelSSEContext.Provider>
  );
}
