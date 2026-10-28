import type { Metadata } from "next";

import { DB_CURRENCIES, THEMES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { LOCALES, isValidTimeZone } from "@/modules/profile/profile.schema";
import { getMe } from "@/modules/profile/profile.service";
import { listMySessions } from "@/modules/sessions/sessions.service";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";
import { type SessionRow, SessionsList } from "./sessions-list";

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
  return new Intl.DateTimeFormat("ro-RO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: isValidTimeZone(timeZone) ? timeZone : "Europe/Bucharest",
  });
}

export default async function ProfilePage() {
  const session = await requirePageSession("/profile");
  const { db } = session.runtime;
  const [me, sessions] = await Promise.all([
    getMe(db, session.userId),
    listMySessions(db, session),
  ]);
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
      <PageHeader eyebrow={me.user.email} title={ro.profile.title} />
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
      </div>
    </>
  );
}
