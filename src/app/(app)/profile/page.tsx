import type { Metadata } from "next";

import { DB_CURRENCIES, THEMES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { LOCALES, isValidTimeZone } from "@/modules/profile/profile.schema";
import { getMe } from "@/modules/profile/profile.service";
import { listMySessions } from "@/modules/sessions/sessions.service";
import { getConsents } from "@/modules/usage/consents";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";
import { type SessionRow, SessionsList } from "./sessions-list";
import { AskAiConsent } from "./ask-ai-consent";
import { ExternalAiConsent } from "./external-ai-consent";
import { UsageConsent } from "./usage-consent";

export const metadata: Metadata = { title: ro.profile.title };

/** Fusurile orare oferite (decizia mea: o listă scurtă, plus valoarea curentă dacă lipsește). */
const COMMON_TIMEZONES = [
  "Europe/Bucharest",
  "Europe/Chisinau",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Vienna",
  "Europe/Athens",
  "America/New_York",
  "America/Toronto",
  "UTC",
];

function formatter(timeZone: string): Intl.DateTimeFormat {
  // Faza 4: `zz.ll.aaaa, HH:mm` (5.3), ca restul datelor din aplicație.
  return new Intl.DateTimeFormat("ro-RO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: isValidTimeZone(timeZone) ? timeZone : "Europe/Bucharest",
  });
}

export default async function ProfilePage() {
  const session = await requirePageSession("/profile");
  const { db } = session.runtime;
  const [me, sessions, consents] = await Promise.all([
    getMe(db, session.userId),
    listMySessions(db, session),
    getConsents(db, session.userId),
  ]);
  const usageStats = consents.some((c) => c.kind === "usageStats" && c.granted);
  const externalAi = consents.some((c) => c.kind === "externalAi" && c.granted);
  const externalAiAsk = consents.some((c) => c.kind === "externalAiAsk" && c.granted);
  const fmt = formatter(me.preferences.timezone);
  const rows: SessionRow[] = sessions.map((s) => ({
    id: s.id,
    device: s.device,
    platform: s.platform,
    ipAddress: s.ipAddress,
    current: s.current,
    lastActive: fmt.format(new Date(s.lastActiveAt)),
    created: fmt.format(new Date(s.createdAt)),
  }));
  const timezones = COMMON_TIMEZONES.includes(me.preferences.timezone)
    ? COMMON_TIMEZONES
    : [me.preferences.timezone, ...COMMON_TIMEZONES];

  return (
    <>
      <PageHeader eyebrow={me.user.email} title={ro.profile.title} usageStats={usageStats} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ProfileForm
          name={me.user.name}
          email={me.user.email}
          preferences={me.preferences}
          options={{
            locales: [...LOCALES],
            timezones,
            currencies: [...DB_CURRENCIES],
            themes: [...THEMES],
          }}
        />
        <PasswordForm />
        <div className="lg:col-span-2">
          <SessionsList sessions={rows} />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <UsageConsent granted={usageStats} />
          <ExternalAiConsent granted={externalAi} />
          <AskAiConsent granted={externalAiAsk} />
        </div>
      </div>
    </>
  );
}
