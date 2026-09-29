import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Bell, BellRing, Mail, MessageSquare, ShieldAlert, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { FullProfileData } from "./types";
import {
  isWebPushSupported,
  getCurrentPushSubscription,
  enableWebPush,
  disableWebPush,
} from "@/lib/webPushClient";

const DATE_FORMAT_OPTIONS = [
  { value: "dd/mm/yyyy", label: "DD/MM/YYYY (e.g. 15/05/2026)" },
  { value: "mm/dd/yyyy", label: "MM/DD/YYYY (e.g. 05/15/2026)" },
  { value: "yyyy-mm-dd", label: "YYYY-MM-DD (e.g. 2026-05-15)" },
];

const TIME_FORMAT_OPTIONS = [
  { value: "12h", label: "12-hour (3:30 PM)" },
  { value: "24h", label: "24-hour (15:30)" },
];

interface ProfileNotificationsTabProps {
  profile: FullProfileData | undefined;
  onSaved: (updated: FullProfileData) => void;
  readOnly?: boolean;
}

export function ProfileNotificationsTab({ profile, onSaved, readOnly = false }: ProfileNotificationsTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const isOwner = profile?.role === "owner";

  if (readOnly) {
    return (
      <div className="space-y-5">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Bell size={16} />
              Email Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Email me when a direct report submits a time-off request</span>
              <Badge
                variant="secondary"
                className={`text-xs ${profile?.notify_email_on_time_off_request ? "text-emerald-700 bg-emerald-50 border-emerald-200" : ""}`}
              >
                {profile?.notify_email_on_time_off_request ? "On" : "Off"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Receive email when my time-off request is decided</span>
              <Badge
                variant="secondary"
                className={`text-xs ${profile?.notify_email_on_time_off_decision ? "text-emerald-700 bg-emerald-50 border-emerald-200" : ""}`}
              >
                {profile?.notify_email_on_time_off_decision ? "On" : "Off"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Email me when a new sign-in is detected from an unfamiliar device</span>
              <Badge
                variant="secondary"
                className={`text-xs ${profile?.notify_email_on_new_sign_in ? "text-emerald-700 bg-emerald-50 border-emerald-200" : ""}`}
              >
                {profile?.notify_email_on_new_sign_in ? "On" : "Off"}
              </Badge>
            </div>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground text-center">
          Notification preferences are shown read-only. Only the member can change their own settings.
        </p>
      </div>
    );
  }

  const [notifyEmailTimeOff, setNotifyEmailTimeOff] = useState(
    profile?.notify_email_on_time_off_request ?? true,
  );
  const [notifyEmailDecision, setNotifyEmailDecision] = useState(
    profile?.notify_email_on_time_off_decision ?? true,
  );
  const [notifyEmailNewSignIn, setNotifyEmailNewSignIn] = useState(
    profile?.notify_email_on_new_sign_in ?? true,
  );
  const [notifyEmailNewOrder, setNotifyEmailNewOrder] = useState(
    profile?.notify_email_on_new_order ?? true,
  );
  const [notifyEmailWeeklyDigest, setNotifyEmailWeeklyDigest] = useState(
    profile?.notify_email_weekly_digest ?? true,
  );
  const [savingTimeOff, setSavingTimeOff] = useState(false);
  const [savingDecision, setSavingDecision] = useState(false);
  const [savingNewSignIn, setSavingNewSignIn] = useState(false);
  const [savingNewOrder, setSavingNewOrder] = useState(false);
  const [savingWeeklyDigest, setSavingWeeklyDigest] = useState(false);

  const [inAppEnabled, setInAppEnabled] = useState(true);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);

  const pushSupported = isWebPushSupported();
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!pushSupported) return;
    void getCurrentPushSubscription().then((sub) => setPushEnabled(Boolean(sub)));
  }, [pushSupported]);

  async function handleTogglePush(next: boolean) {
    setPushBusy(true);
    try {
      if (next) {
        await enableWebPush();
        setPushEnabled(true);
        toast({
          title: t("profile.push.enabledTitle"),
          description: t("profile.push.enabledDesc"),
        });
      } else {
        await disableWebPush();
        setPushEnabled(false);
        toast({ title: t("profile.push.disabledTitle") });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast({
        title: t("profile.push.failedTitle"),
        description:
          msg === "permission_denied"
            ? t("profile.push.permissionDenied")
            : msg === "unsupported"
              ? t("profile.push.unsupported")
              : t("profile.push.failedDesc"),
        variant: "destructive",
      });
    } finally {
      setPushBusy(false);
    }
  }

  const [dateFormat, setDateFormat] = useState(() => {
    try { return localStorage.getItem("pref_date_format") ?? "dd/mm/yyyy"; } catch { return "dd/mm/yyyy"; }
  });
  const [timeFormat, setTimeFormat] = useState(() => {
    try { return localStorage.getItem("pref_time_format") ?? "24h"; } catch { return "24h"; }
  });

  useEffect(() => {
    if (profile) {
      setNotifyEmailTimeOff(profile.notify_email_on_time_off_request ?? true);
      setNotifyEmailDecision(profile.notify_email_on_time_off_decision ?? true);
      setNotifyEmailNewSignIn(profile.notify_email_on_new_sign_in ?? true);
      setNotifyEmailNewOrder(profile.notify_email_on_new_order ?? true);
      setNotifyEmailWeeklyDigest(profile.notify_email_weekly_digest ?? true);
    }
  }, [profile]);

  async function handleToggleTimeOff(next: boolean) {
    const prev = notifyEmailTimeOff;
    setNotifyEmailTimeOff(next);
    setSavingTimeOff(true);
    try {
      const saved = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ notify_email_on_time_off_request: next }),
      });
      queryClient.setQueryData(["profile"], saved);
      onSaved(saved);
      toast({
        title: next ? "Email notifications on" : "Email notifications off",
        description: next
          ? "You'll receive an email when a direct report submits a time-off request."
          : "You'll no longer receive emails for new time-off requests.",
      });
    } catch {
      setNotifyEmailTimeOff(prev);
      toast({ title: "Failed to update preference", variant: "destructive" });
    } finally {
      setSavingTimeOff(false);
    }
  }

  async function handleToggleDecision(next: boolean) {
    const prev = notifyEmailDecision;
    setNotifyEmailDecision(next);
    setSavingDecision(true);
    try {
      const saved = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ notify_email_on_time_off_decision: next }),
      });
      queryClient.setQueryData(["profile"], saved);
      onSaved(saved);
      toast({
        title: next ? "Email notifications on" : "Email notifications off",
        description: next
          ? "You'll receive an email when your time-off request is decided."
          : "You'll no longer receive emails when your time-off requests are decided.",
      });
    } catch {
      setNotifyEmailDecision(prev);
      toast({ title: "Failed to update preference", variant: "destructive" });
    } finally {
      setSavingDecision(false);
    }
  }

  async function handleToggleNewSignIn(next: boolean) {
    const prev = notifyEmailNewSignIn;
    setNotifyEmailNewSignIn(next);
    setSavingNewSignIn(true);
    try {
      const saved = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ notify_email_on_new_sign_in: next }),
      });
      queryClient.setQueryData(["profile"], saved);
      onSaved(saved);
      toast({
        title: next ? "Security alerts on" : "Security alerts off",
        description: next
          ? "You'll receive an email when a new sign-in is detected from an unfamiliar device."
          : "You'll no longer receive emails for new device sign-ins.",
      });
    } catch {
      setNotifyEmailNewSignIn(prev);
      toast({ title: "Failed to update preference", variant: "destructive" });
    } finally {
      setSavingNewSignIn(false);
    }
  }

  async function handleToggleNewOrder(next: boolean) {
    const prev = notifyEmailNewOrder;
    setNotifyEmailNewOrder(next);
    setSavingNewOrder(true);
    try {
      const saved = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ notify_email_on_new_order: next }),
      });
      queryClient.setQueryData(["profile"], saved);
      onSaved(saved);
      toast({
        title: next
          ? t("profile.emailPrefs.newOrderOnTitle")
          : t("profile.emailPrefs.newOrderOffTitle"),
        description: next
          ? t("profile.emailPrefs.newOrderOnDesc")
          : t("profile.emailPrefs.newOrderOffDesc"),
      });
    } catch {
      setNotifyEmailNewOrder(prev);
      toast({ title: t("profile.emailPrefs.updateFailed"), variant: "destructive" });
    } finally {
      setSavingNewOrder(false);
    }
  }

  async function handleToggleWeeklyDigest(next: boolean) {
    const prev = notifyEmailWeeklyDigest;
    setNotifyEmailWeeklyDigest(next);
    setSavingWeeklyDigest(true);
    try {
      const saved = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ notify_email_weekly_digest: next }),
      });
      queryClient.setQueryData(["profile"], saved);
      onSaved(saved);
      toast({
        title: next
          ? t("profile.emailPrefs.weeklyDigestOnTitle")
          : t("profile.emailPrefs.weeklyDigestOffTitle"),
        description: next
          ? t("profile.emailPrefs.weeklyDigestOnDesc")
          : t("profile.emailPrefs.weeklyDigestOffDesc"),
      });
    } catch {
      setNotifyEmailWeeklyDigest(prev);
      toast({ title: t("profile.emailPrefs.updateFailed"), variant: "destructive" });
    } finally {
      setSavingWeeklyDigest(false);
    }
  }

  function saveFormatPrefs() {
    try {
      localStorage.setItem("pref_date_format", dateFormat);
      localStorage.setItem("pref_time_format", timeFormat);
    } catch {}
    toast({ title: "Format preferences saved", description: "Your date and time format preferences have been saved locally." });
  }

  return (
    <div className="space-y-5">
      {/* Browser push notifications for new orders */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <BellRing size={16} />
            {t("profile.push.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {pushSupported ? (
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="push-new-order" className="text-sm font-medium">
                  {t("profile.push.newOrderLabel")}
                </Label>
                <p className="text-xs text-muted-foreground max-w-md">
                  {t("profile.push.newOrderDesc")}
                </p>
              </div>
              <Switch
                id="push-new-order"
                checked={pushEnabled}
                onCheckedChange={handleTogglePush}
                disabled={pushBusy}
                data-testid="toggle-push-new-order"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("profile.push.unsupported")}</p>
          )}
        </CardContent>
      </Card>

      {/* Email preferences — order + digest emails */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Mail size={16} />
            {t("profile.emailPrefs.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="notify-new-order-email" className="text-sm font-medium">
                {t("profile.emailPrefs.newOrderLabel")}
              </Label>
              <p className="text-xs text-muted-foreground max-w-md">
                {t("profile.emailPrefs.newOrderDesc")}
              </p>
            </div>
            <Switch
              id="notify-new-order-email"
              checked={notifyEmailNewOrder}
              onCheckedChange={handleToggleNewOrder}
              disabled={savingNewOrder}
              data-testid="toggle-notify-new-order-email"
            />
          </div>
          {isOwner && (
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <Label htmlFor="notify-weekly-digest-email" className="text-sm font-medium">
                  {t("profile.emailPrefs.weeklyDigestLabel")}
                </Label>
                <p className="text-xs text-muted-foreground max-w-md">
                  {t("profile.emailPrefs.weeklyDigestDesc")}
                </p>
              </div>
              <Switch
                id="notify-weekly-digest-email"
                checked={notifyEmailWeeklyDigest}
                onCheckedChange={handleToggleWeeklyDigest}
                disabled={savingWeeklyDigest}
                data-testid="toggle-notify-weekly-digest-email"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email notifications */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Bell size={16} />
            Email Notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="notify-time-off-email" className="text-sm font-medium">
                Email me when a direct report submits a time-off request
              </Label>
              <p className="text-xs text-muted-foreground max-w-md">
                Turn this off if you'd rather just see new requests in the in-app notification bell.
              </p>
            </div>
            <Switch
              id="notify-time-off-email"
              checked={notifyEmailTimeOff}
              onCheckedChange={handleToggleTimeOff}
              disabled={savingTimeOff}
              data-testid="toggle-notify-time-off-email"
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="notify-time-off-decision-email" className="text-sm font-medium">
                Receive email when my time-off request is decided
              </Label>
              <p className="text-xs text-muted-foreground max-w-md">
                Turn this off if you'd rather not get an email when a manager approves or denies your request.
              </p>
            </div>
            <Switch
              id="notify-time-off-decision-email"
              checked={notifyEmailDecision}
              onCheckedChange={handleToggleDecision}
              disabled={savingDecision}
              data-testid="toggle-notify-time-off-decision-email"
            />
          </div>
        </CardContent>
      </Card>

      {/* Security alerts */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ShieldAlert size={16} />
            Security Alerts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="notify-new-sign-in-email" className="text-sm font-medium">
                Email me when a new sign-in is detected from an unfamiliar device
              </Label>
              <p className="text-xs text-muted-foreground max-w-md">
                Sends an alert with the device, location, and time so you can revoke the session if it wasn't you.
              </p>
            </div>
            <Switch
              id="notify-new-sign-in-email"
              checked={notifyEmailNewSignIn}
              onCheckedChange={handleToggleNewSignIn}
              disabled={savingNewSignIn}
              data-testid="toggle-notify-new-sign-in-email"
            />
          </div>
        </CardContent>
      </Card>

      {/* In-app & WhatsApp (UI-only) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Smartphone size={16} />
            In-App & Messaging
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">These toggles are UI-only for now — delivery infrastructure is coming soon.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="in-app-notif" className="text-sm font-medium flex items-center gap-1.5">
                <Bell size={13} />
                In-app notifications
              </Label>
              <p className="text-xs text-muted-foreground">Show notification badges and alerts in the dashboard.</p>
            </div>
            <Switch
              id="in-app-notif"
              checked={inAppEnabled}
              onCheckedChange={setInAppEnabled}
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="whatsapp-notif" className="text-sm font-medium flex items-center gap-1.5">
                <MessageSquare size={13} />
                WhatsApp notifications
              </Label>
              <p className="text-xs text-muted-foreground">Receive important alerts via WhatsApp message. (UI-only — not yet delivered)</p>
            </div>
            <Switch
              id="whatsapp-notif"
              checked={whatsappEnabled}
              onCheckedChange={setWhatsappEnabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Date & time format */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Date & Time Format</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Stored in your browser — applies to this device only.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="date-format">Date format</Label>
            <select
              id="date-format"
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {DATE_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="time-format">Time format</Label>
            <select
              id="time-format"
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {TIME_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={saveFormatPrefs}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2"
            >
              Save format preferences
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
