"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

import { apiFetch, goToLogin } from "../../_lib/api-client";
import { themeCookie } from "../../_lib/theme";
import { useHydrated } from "../../_lib/use-hydrated";

type Preferences = Readonly<{
  locale: string;
  timezone: string;
  defaultCurrency: string;
  theme: string;
}>;

type Options = Readonly<{
  locales: string[];
  timezones: string[];
  currencies: string[];
  themes: string[];
}>;

/** Numele și preferințele: `PATCH /api/v1/me` (aceeași validare Zod strictă ca pentru Android). */
export function ProfileForm({
  name,
  email,
  preferences,
  options,
}: Readonly<{ name: string; email: string; preferences: Preferences; options: Options }>) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const hydrated = useHydrated();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextName = String(form.get("name") ?? "").trim();
    setSaved(null);
    if (nextName.length < 1 || nextName.length > 100) {
      setError(ro.profile.invalidName);
      return;
    }
    const theme = String(form.get("theme"));
    setSaving(true);
    setError(null);
    const result = await apiFetch("/api/v1/me", {
      method: "PATCH",
      body: {
        name: nextName,
        preferences: {
          theme,
          locale: String(form.get("locale")),
          timezone: String(form.get("timezone")),
          defaultCurrency: String(form.get("defaultCurrency")),
        },
      },
    });
    setSaving(false);
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(ro.profile.saveError);
      return;
    }
    // Tema se aplică imediat și la următoarele pagini (cookie fără date personale).
    document.cookie = themeCookie(theme, window.location.protocol === "https:");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    setSaved(ro.profile.saved);
    router.refresh();
  }

  return (
    <Card aria-labelledby="profile-title">
      <CardHeader>
        <CardTitle id="profile-title">{ro.profile.account}</CardTitle>
      </CardHeader>
      <form method="post" onSubmit={onSubmit} noValidate aria-busy={saving}>
        <CardContent>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-name">{ro.profile.name}</Label>
            <Input
              id="profile-name"
              name="name"
              defaultValue={name}
              autoComplete="name"
              required
              maxLength={100}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-email">{ro.profile.email}</Label>
            <Input
              id="profile-email"
              value={email}
              readOnly
              aria-describedby="profile-email-hint"
              className="bg-muted"
            />
            <p id="profile-email-hint" className="text-xs text-muted-foreground">
              {ro.profile.emailHint}
            </p>
          </div>
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 font-display font-bold">{ro.profile.preferences}</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pref-theme">{ro.profile.theme}</Label>
                <Select id="pref-theme" name="theme" defaultValue={preferences.theme}>
                  {options.themes.map((t) => (
                    <option key={t} value={t}>
                      {ro.profile.themes[t] ?? t}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pref-locale">{ro.profile.locale}</Label>
                <Select id="pref-locale" name="locale" defaultValue={preferences.locale}>
                  {options.locales.map((l) => (
                    <option key={l} value={l}>
                      {ro.profile.locales[l] ?? l}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pref-timezone">{ro.profile.timezone}</Label>
                <Select id="pref-timezone" name="timezone" defaultValue={preferences.timezone}>
                  {options.timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pref-currency">{ro.profile.currency}</Label>
                <Select
                  id="pref-currency"
                  name="defaultCurrency"
                  defaultValue={preferences.defaultCurrency}
                >
                  {options.currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </fieldset>
          <Alert>{error}</Alert>
          <Alert tone="ok">{saved}</Alert>
          <div>
            <Button type="submit" disabled={saving || !hydrated}>
              {saving ? ro.profile.saving : ro.profile.save}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
