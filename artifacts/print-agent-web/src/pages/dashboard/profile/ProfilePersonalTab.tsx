import { useState, useEffect, useRef } from "react";
import { useUser } from "@clerk/react";
type UserResource = NonNullable<ReturnType<typeof useUser>["user"]>;
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getCountries, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { isExcludedCountry } from "@/lib/countries";
import { User, Phone as PhoneIcon, Calendar, Lock } from "lucide-react";
import type { FullProfileData } from "./types";
import { GENDER_OPTIONS } from "./types";
import { BirthdayPicker } from "@/components/BirthdayPicker";

const ALLOWED_COUNTRIES: Country[] = getCountries().filter((c) => !isExcludedCountry(c));

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية (Arabic)" },
];

const TIMEZONE_OPTIONS = [
  { value: "UTC", label: "UTC" },
  { value: "Asia/Beirut", label: "Beirut (GMT+2/3)" },
  { value: "Asia/Dubai", label: "Dubai (GMT+4)" },
  { value: "Asia/Riyadh", label: "Riyadh (GMT+3)" },
  { value: "Europe/London", label: "London (GMT+0/1)" },
  { value: "Europe/Paris", label: "Paris (GMT+1/2)" },
  { value: "America/New_York", label: "New York (GMT-5/4)" },
  { value: "America/Los_Angeles", label: "Los Angeles (GMT-8/7)" },
];

interface ProfilePersonalTabProps {
  user?: UserResource;
  profile: FullProfileData | undefined;
  onDirtyChange: (dirty: boolean) => void;
  saveSignal: number;
  resetSignal: number;
  onSaved: (updated: FullProfileData) => void;
  readOnly?: boolean;
  readOnlyName?: { firstName: string | null; lastName: string | null };
}

function getInitialLang() {
  try {
    const stored = localStorage.getItem("i18nextLng");
    if (stored && ["en", "ar"].includes(stored)) return stored;
  } catch {}
  return "en";
}

function getInitialTimezone() {
  try {
    const stored = localStorage.getItem("preferred_timezone");
    if (stored) return stored;
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function ProfilePersonalTab({
  user,
  profile,
  onDirtyChange,
  saveSignal,
  resetSignal,
  onSaved,
  readOnly = false,
  readOnlyName,
}: ProfilePersonalTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [phone, setPhone] = useState<string>(profile?.phone ?? "");
  const [jobTitle, setJobTitle] = useState(profile?.job_title ?? "");
  const [birthday, setBirthday] = useState(profile?.birthday ?? "");
  const [gender, setGender] = useState(profile?.gender ?? "");
  const [preferredLang, setPreferredLang] = useState(getInitialLang());
  const [timezone, setTimezone] = useState(getInitialTimezone());
  const [emergencyName, setEmergencyName] = useState(profile?.ec_name ?? "");
  const [emergencyRel, setEmergencyRel] = useState(profile?.ec_relationship ?? "");
  const [emergencyPhone, setEmergencyPhone] = useState<string>(profile?.ec_phone ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [defaultCountry, setDefaultCountry] = useState<Country>("US");

  const savedRef = useRef({
    firstName: user?.firstName ?? "",
    lastName: user?.lastName ?? "",
    phone: profile?.phone ?? "",
    jobTitle: profile?.job_title ?? "",
    birthday: profile?.birthday ?? "",
    gender: profile?.gender ?? "",
    preferredLang: getInitialLang(),
    timezone: getInitialTimezone(),
    emergencyName: profile?.ec_name ?? "",
    emergencyRel: profile?.ec_relationship ?? "",
    emergencyPhone: profile?.ec_phone ?? "",
  });

  useEffect(() => {
    if (profile) {
      const ph = profile.phone ?? "";
      const jt = profile.job_title ?? "";
      const bd = profile.birthday ?? "";
      const gen = profile.gender ?? "";
      const en = profile.ec_name ?? "";
      const er = profile.ec_relationship ?? "";
      const ep = profile.ec_phone ?? "";
      setPhone(ph);
      setJobTitle(jt);
      setBirthday(bd);
      setGender(gen);
      setEmergencyName(en);
      setEmergencyRel(er);
      setEmergencyPhone(ep);
      savedRef.current.phone = ph;
      savedRef.current.jobTitle = jt;
      savedRef.current.birthday = bd;
      savedRef.current.gender = gen;
      savedRef.current.emergencyName = en;
      savedRef.current.emergencyRel = er;
      savedRef.current.emergencyPhone = ep;
    }
  }, [profile]);

  useEffect(() => {
    if (!user) return;
    setFirstName(user.firstName ?? "");
    setLastName(user.lastName ?? "");
  }, [user]);

  useEffect(() => {
    fetch("https://ipapi.co/json/")
      .then((r) => r.json())
      .then((data: { country_code?: string }) => {
        const code = data.country_code as Country | undefined;
        if (code && code.length === 2 && !isExcludedCountry(code)) {
          setDefaultCountry(code);
        }
      })
      .catch(() => {});
  }, []);

  const isDirty =
    firstName !== savedRef.current.firstName ||
    lastName !== savedRef.current.lastName ||
    phone !== savedRef.current.phone ||
    jobTitle !== savedRef.current.jobTitle ||
    birthday !== savedRef.current.birthday ||
    gender !== savedRef.current.gender ||
    preferredLang !== savedRef.current.preferredLang ||
    timezone !== savedRef.current.timezone ||
    emergencyName !== savedRef.current.emergencyName ||
    emergencyRel !== savedRef.current.emergencyRel ||
    emergencyPhone !== savedRef.current.emergencyPhone;

  useEffect(() => {
    onDirtyChange(readOnly ? false : isDirty);
  }, [isDirty, onDirtyChange, readOnly]);

  useEffect(() => {
    if (resetSignal > 0) {
      setFirstName(savedRef.current.firstName);
      setLastName(savedRef.current.lastName);
      setPhone(savedRef.current.phone);
      setJobTitle(savedRef.current.jobTitle);
      setBirthday(savedRef.current.birthday);
      setGender(savedRef.current.gender);
      setPreferredLang(savedRef.current.preferredLang);
      setTimezone(savedRef.current.timezone);
      setEmergencyName(savedRef.current.emergencyName);
      setEmergencyRel(savedRef.current.emergencyRel);
      setEmergencyPhone(savedRef.current.emergencyPhone);
      setNameError(null);
    }
  }, [resetSignal]);

  useEffect(() => {
    if (saveSignal > 0 && !readOnly) {
      void handleSave();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSignal]);

  async function handleNameSave() {
    if (!user) return;
    if (!firstName.trim()) {
      setNameError("First name cannot be blank.");
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      await user.update({ firstName: firstName.trim(), lastName: lastName.trim() });
      savedRef.current.firstName = firstName.trim();
      savedRef.current.lastName = lastName.trim();
      toast({ title: "Name updated", description: "Your name has been changed." });
    } catch {
      toast({ title: "Failed to save name", description: "Could not update your name. Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    try {
      const updated = await apiFetch<FullProfileData>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({
          phone: phone || null,
          job_title: jobTitle.trim() || null,
          birthday: birthday || null,
          gender: gender || null,
          ec_name: emergencyName.trim() || null,
          ec_relationship: emergencyRel.trim() || null,
          ec_phone_country_code: emergencyPhone
            ? (emergencyPhone.match(/^(\+\d+)/)?.[1] ?? null)
            : null,
          ec_phone: emergencyPhone || null,
        }),
      });

      try {
        localStorage.setItem("i18nextLng", preferredLang);
        localStorage.setItem("preferred_timezone", timezone);
      } catch {}

      savedRef.current = {
        ...savedRef.current,
        phone: updated.phone ?? "",
        jobTitle: updated.job_title ?? "",
        birthday: updated.birthday ?? "",
        gender: updated.gender ?? "",
        preferredLang,
        timezone,
        emergencyName: updated.ec_name ?? "",
        emergencyRel: updated.ec_relationship ?? "",
        emergencyPhone: updated.ec_phone ?? "",
      };

      queryClient.setQueryData(["profile"], updated);
      onSaved(updated);
      toast({ title: "Profile saved", description: "Your profile has been updated." });
    } catch {
      toast({ title: "Failed to save", description: "Could not save profile. Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (readOnly) {
    const displayFirst = readOnlyName?.firstName ?? null;
    const displayLast = readOnlyName?.lastName ?? null;
    const fullName = [displayFirst, displayLast].filter(Boolean).join(" ") || profile?.member_email?.split("@")[0] || "—";
    const genderLabel = GENDER_OPTIONS.find((g) => g.value === profile?.gender)?.label ?? profile?.gender ?? "—";
    return (
      <div className="space-y-5">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <User size={16} />
              Name
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">First name</p>
                <p className="text-sm font-medium">{displayFirst || "—"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Last name</p>
                <p className="text-sm font-medium">{displayLast || "—"}</p>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="text-sm font-medium">{profile?.member_email || "—"}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <PhoneIcon size={16} />
              Contact & Role
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Phone number</p>
              <p className="text-sm font-medium">{profile?.phone || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Job title</p>
              <p className="text-sm font-medium">{profile?.job_title || "—"}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Calendar size={16} />
              Personal Details
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Birthday</p>
              <p className="text-sm font-medium">{profile?.birthday ? profile.birthday : "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Gender</p>
              <p className="text-sm font-medium">{genderLabel}</p>
            </div>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground text-center">
          Viewing {fullName}&apos;s personal details in read-only mode.
        </p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="space-y-5">
      {/* Name */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <User size={16} />
            Name
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="first-name">First name</Label>
              <Input
                id="first-name"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); setNameError(null); }}
                placeholder="First name"
                data-testid="input-first-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="last-name">Last name</Label>
              <Input
                id="last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
                data-testid="input-last-name"
              />
            </div>
          </div>
          {nameError && <p className="text-sm text-destructive">{nameError}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={user.primaryEmailAddress?.emailAddress ?? ""}
              readOnly
              disabled
              className="bg-secondary text-muted-foreground cursor-not-allowed"
              data-testid="input-email"
            />
            <p className="text-xs text-muted-foreground">Email is managed by your account provider.</p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleNameSave} disabled={saving} size="sm" data-testid="save-name-button">
              {saving ? "Saving…" : "Save name"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Contact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <PhoneIcon size={16} />
            Contact & Role
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone number</Label>
            <PhoneInputField
              id="phone"
              international
              countryCallingCodeEditable={false}
              defaultCountry={defaultCountry}
              countries={ALLOWED_COUNTRIES}
              value={phone}
              onChange={(val) => setPhone(val ?? "")}
              data-testid="input-phone"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="job-title">Job title</Label>
            <Input
              id="job-title"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Store Manager"
              data-testid="input-job-title"
            />
          </div>
        </CardContent>
      </Card>

      {/* Personal details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Calendar size={16} />
            Personal Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Birthday</Label>
            <BirthdayPicker
              value={birthday}
              onChange={(val) => setBirthday(val)}
              data-testid="input-birthday"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gender">Gender</Label>
            <select
              id="gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              data-testid="select-gender"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {GENDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preferred-lang">Preferred language</Label>
            <select
              id="preferred-lang"
              value={preferredLang}
              onChange={(e) => setPreferredLang(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {TIMEZONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Stored locally in your browser — no backend column.</p>
          </div>
        </CardContent>
      </Card>

      {/* Emergency contact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            Emergency Contact
            <span className="text-xs font-normal text-muted-foreground ml-1 flex items-center gap-1">
              <Lock size={12} /> Private information
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ec-name">Name</Label>
              <Input
                id="ec-name"
                value={emergencyName}
                onChange={(e) => setEmergencyName(e.target.value)}
                placeholder="Full name"
                data-testid="input-ec-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ec-rel">Relationship</Label>
              <Input
                id="ec-rel"
                value={emergencyRel}
                onChange={(e) => setEmergencyRel(e.target.value)}
                placeholder="e.g. Spouse, Parent"
                data-testid="input-ec-relationship"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ec-phone">Phone number</Label>
            <PhoneInputField
              id="ec-phone"
              international
              countryCallingCodeEditable={false}
              defaultCountry={defaultCountry}
              countries={ALLOWED_COUNTRIES}
              value={emergencyPhone}
              onChange={(val) => setEmergencyPhone(val ?? "")}
              data-testid="input-ec-phone"
            />
          </div>
          <p className="text-xs text-muted-foreground">Only visible to you, workspace owners, and admins.</p>
        </CardContent>
      </Card>

      {/* Inline save (also available via bottom bar) */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} data-testid="save-profile-button">
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}
