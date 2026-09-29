import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useUser } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { CalendarDays } from "lucide-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

import { ProfileHeader } from "./profile/ProfileHeader";
import { ProfileOverviewTab } from "./profile/ProfileOverviewTab";
import { ProfilePersonalTab } from "./profile/ProfilePersonalTab";
import { ProfileWorkTab } from "./profile/ProfileWorkTab";
import { ProfileAccessTab } from "./profile/ProfileAccessTab";
import { ProfileTimeOffTab } from "./profile/ProfileTimeOffTab";
import { ProfileNotificationsTab } from "./profile/ProfileNotificationsTab";
import { ProfileSecurityTab } from "./profile/ProfileSecurityTab";
import { ProfilePayTab } from "./profile/ProfilePayTab";
import type { FullProfileData, WorkingDaysConfig } from "./profile/types";
import { DEFAULT_WORKING_DAYS, WORK_SCHEDULE_DAYS } from "./profile/types";

export default function ProfilePage() {
  const { user, isLoaded } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner, allowedPages, loaded: roleLoaded } = useWorkspaceRole();

  const initialTab = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const validTabs = ["overview", "personal", "work", "access", "time-off", "notifications", "security", "pay", "schedule"];
    return tab && validTabs.includes(tab) ? tab : "overview";
  }, []);

  const [activeTab, setActiveTab] = useState(initialTab);
  const [isDirty, setIsDirty] = useState(false);
  const [saveSignal, setSaveSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);

  const [workingDays, setWorkingDays] = useState<WorkingDaysConfig>(DEFAULT_WORKING_DAYS);
  const [savingSchedule, setSavingSchedule] = useState(false);

  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [removingPhoto, setRemovingPhoto] = useState(false);

  const { data: profileData, isLoading: profileLoading } = useQuery<FullProfileData>({
    queryKey: ["profile"],
    queryFn: () => apiFetch<FullProfileData>("/api/profile"),
    enabled: isLoaded && !!user,
  });

  useEffect(() => {
    if (profileData?.working_days) {
      setWorkingDays(profileData.working_days);
    }
  }, [profileData]);

  // Before-unload guard
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty);
  }, []);

  function handleTabChange(tab: string) {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Are you sure you want to leave this tab? Your changes will be lost.",
      );
      if (!confirmed) return;
      setIsDirty(false);
      setResetSignal((s) => s + 1);
    }
    setActiveTab(tab);
  }

  function handleSaveChanges() {
    setSaveSignal((s) => s + 1);
  }

  function handleDiscardChanges() {
    const confirmed = window.confirm("Discard all unsaved changes?");
    if (!confirmed) return;
    setIsDirty(false);
    setResetSignal((s) => s + 1);
  }

  function handleProfileSaved(updated: FullProfileData) {
    setIsDirty(false);
    queryClient.setQueryData(["profile"], updated);
  }

  async function handlePhotoChange(file: File) {
    if (!user) return;
    setUploadingPhoto(true);
    try {
      await user.setProfileImage({ file });
      toast({ title: "Photo updated", description: "Your profile photo has been changed." });
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handlePhotoRemove() {
    if (!user) return;
    setRemovingPhoto(true);
    try {
      await user.setProfileImage({ file: null });
      toast({ title: "Photo removed", description: "Your profile photo has been removed." });
    } catch {
      toast({ title: "Failed to remove photo", variant: "destructive" });
    } finally {
      setRemovingPhoto(false);
    }
  }

  async function handleSaveSchedule() {
    const hasAtLeastOneDay = Object.values(workingDays).some(Boolean);
    if (!hasAtLeastOneDay) {
      toast({ title: "Invalid schedule", description: "Please select at least one working day.", variant: "destructive" });
      return;
    }
    setSavingSchedule(true);
    try {
      const saved = await apiFetch<{ working_days: WorkingDaysConfig }>("/api/profile/work-schedule", {
        method: "PATCH",
        body: JSON.stringify(workingDays),
      });
      queryClient.setQueryData<FullProfileData>(["profile"], (prev) =>
        prev ? { ...prev, working_days: saved.working_days } : prev,
      );
      toast({ title: "Schedule saved", description: "Your work schedule has been updated." });
    } catch {
      toast({ title: "Failed to save", description: "Could not save schedule. Please try again.", variant: "destructive" });
    } finally {
      setSavingSchedule(false);
    }
  }

  if (!isLoaded || !user) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  const TAB_ITEMS = [
    { value: "overview", label: "Overview" },
    { value: "personal", label: "Personal" },
    { value: "work", label: "Work" },
    { value: "access", label: "Access" },
    { value: "schedule", label: "Schedule" },
    { value: "time-off", label: "Time Off" },
    { value: "pay", label: "Pay" },
    { value: "notifications", label: "Notifications" },
    { value: "security", label: "Security" },
  ];

  return (
    <div className={isDirty ? "pb-20" : ""}>
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Manage your personal information, work details, and preferences.
        </p>
      </div>

      {profileLoading ? (
        <div className="rounded-xl border bg-card p-6 mb-6 animate-pulse h-32" />
      ) : (
        <ProfileHeader
          user={user}
          profile={profileData}
          onPhotoChange={handlePhotoChange}
          onPhotoRemove={handlePhotoRemove}
          uploadingPhoto={uploadingPhoto}
          removingPhoto={removingPhoto}
          onEditProfile={() => handleTabChange("personal")}
        />
      )}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="mb-5 flex-wrap h-auto gap-1">
          {TAB_ITEMS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} data-testid={`tab-${tab.value}`}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <ProfileOverviewTab
            user={user}
            profile={profileData}
            allowedPages={allowedPages}
            isOwner={isOwner}
            onNavigate={handleTabChange}
          />
        </TabsContent>

        <TabsContent value="personal">
          <ProfilePersonalTab
            user={user}
            profile={profileData}
            onDirtyChange={handleDirtyChange}
            saveSignal={saveSignal}
            resetSignal={resetSignal}
            onSaved={handleProfileSaved}
          />
        </TabsContent>

        <TabsContent value="work">
          <ProfileWorkTab
            profile={profileData}
            isOwner={isOwner}
            onDirtyChange={handleDirtyChange}
            saveSignal={saveSignal}
            resetSignal={resetSignal}
            onSaved={handleProfileSaved}
          />
        </TabsContent>

        <TabsContent value="access">
          <ProfileAccessTab
            profile={profileData}
            allowedPages={allowedPages}
            isOwner={isOwner}
          />
        </TabsContent>

        <TabsContent value="schedule">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <CalendarDays size={18} />
                Work Schedule
              </CardTitle>
              <CardDescription>
                Select the days you normally work. Time-off requests will only deduct days that fall on your working days.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap" data-testid="work-schedule-toggles">
                {WORK_SCHEDULE_DAYS.map(({ key, label, short }) => {
                  const active = workingDays[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={active}
                      aria-label={label}
                      data-testid={`schedule-day-${key}`}
                      onClick={() => setWorkingDays((prev) => ({ ...prev, [key]: !prev[key] }))}
                      className={`w-12 h-12 rounded-full text-sm font-medium border-2 transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {Object.values(workingDays).filter(Boolean).length === 0
                  ? "Please select at least one working day."
                  : `${Object.values(workingDays).filter(Boolean).length} day${Object.values(workingDays).filter(Boolean).length === 1 ? "" : "s"} per week`}
              </p>
              <Button
                onClick={handleSaveSchedule}
                disabled={savingSchedule || Object.values(workingDays).every((v) => !v)}
                data-testid="save-schedule-button"
              >
                {savingSchedule ? "Saving…" : "Save schedule"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="time-off">
          <ProfileTimeOffTab workingDays={workingDays} />
        </TabsContent>

        <TabsContent value="pay">
          <ProfilePayTab isOwner={isOwner} />
        </TabsContent>

        <TabsContent value="notifications">
          <ProfileNotificationsTab profile={profileData} onSaved={handleProfileSaved} />
        </TabsContent>

        <TabsContent value="security">
          <ProfileSecurityTab user={user} />
        </TabsContent>
      </Tabs>

      {/* Unsaved-changes fixed bottom action bar */}
      {isDirty && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur-sm shadow-lg">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              You have unsaved changes.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDiscardChanges}
                data-testid="discard-changes-btn"
              >
                Discard changes
              </Button>
              <Button
                size="sm"
                onClick={handleSaveChanges}
                data-testid="save-changes-btn"
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
