import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isCurrency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { readAndroidRelease } from "@/modules/app-release/android";
import { getUsageStats, isPlatformAdmin } from "@/modules/usage/stats";

import { formatMinor } from "../../../_lib/ledger-ui";
import { requirePageSession } from "../../../_lib/session";
import { PageHeader } from "../../page-header";

export const metadata: Metadata = { title: ro.stats.title };

const dateTime = new Intl.DateTimeFormat("ro-RO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Bucharest",
});

const number = new Intl.NumberFormat("ro-RO");

function when(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : ro.stats.never;
}

/** Un tabel simplu, cu `caption` (accesibil) și mesajul „gol”. */
function Table({
  id,
  caption,
  head,
  rows,
}: Readonly<{ id: string; caption: string; head: string[]; rows: ReactNode[][] }>) {
  return (
    <Card aria-labelledby={`${id}-titlu`}>
      <CardHeader>
        <CardTitle id={`${id}-titlu`}>{caption}</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{ro.stats.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid={`stats-${id}`}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h} scope="col" className="py-1 pr-4 text-left font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {r.map((c, j) => (
                    <td key={j} className="py-1 pr-4 tabular-nums">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * Setări → Statistici (Faza 9, F9-B; master prompt 6.5), DOAR pentru administratorul platformei
 * (altcineva: 404, pagina nu există pentru el). Datele: `getUsageStats` (funcția din bază
 * `finet.usage_stats`), aceleași ca `GET /api/v1/admin/stats`. Fără date financiare ale
 * utilizatorilor; costul AI e costul de operare.
 */
export default async function StatisticsPage() {
  const session = await requirePageSession("/settings/statistics");
  const { db, config } = session.runtime;
  if (!(await isPlatformAdmin(db, session.userId))) notFound();
  const latestAndroid = await readAndroidRelease(config.storage.dir).catch(() => null);
  const s = await getUsageStats(db, session.userId, { appMode: config.appMode, latestAndroid });
  const t = ro.stats;
  const versionState = (v: { belowMinimum: boolean; outdated: boolean }) =>
    v.belowMinimum ? t.belowMinimum : v.outdated ? t.outdated : t.current;

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <div className="flex flex-col gap-4" data-testid="stats-page">
        <Card aria-labelledby="stats-intro">
          <CardHeader>
            <CardTitle id="stats-intro">{t.title}</CardTitle>
            <CardDescription>{t.intro}</CardDescription>
          </CardHeader>
          <p className="text-sm">
            {s.latestAndroid
              ? t.latestAndroid(
                  s.latestAndroid.versionName,
                  s.latestAndroid.versionCode,
                  s.latestAndroid.minSupportedVersionCode,
                )
              : t.noAndroid}
          </p>
          <p className="text-sm text-muted-foreground">{t.archived(s.archivedEvents)}</p>
          <p className="text-sm text-muted-foreground">{t.loginFailures}</p>
        </Card>
        <Table
          id="active"
          caption={t.active}
          head={[t.platform, t.daily, t.weekly, t.monthly]}
          rows={[
            ...s.activeUsers.map((a) => [a.platform, a.daily, a.weekly, a.monthly]),
            [t.sessions, s.sessionUsers.daily, s.sessionUsers.weekly, s.sessionUsers.monthly],
          ]}
        />
        <p className="text-sm text-muted-foreground">
          {t.expiredSessions}: {number.format(s.sessionUsers.expiredSessions)}
        </p>
        {s.members ? (
          <Table
            id="members"
            caption={t.members}
            head={[t.member, t.lastSeen, t.platform, t.version, t.status]}
            rows={s.members.map((m) => [
              m.name,
              when(m.lastSeenAt),
              m.platform ?? t.never,
              m.appVersion ?? t.never,
              m.platform === "android" ? versionState(m) : t.never,
            ])}
          />
        ) : null}
        <Table
          id="installations"
          caption={t.installations}
          head={[t.platform, t.version, t.count, t.status]}
          rows={s.installations.map((i) => [
            i.platform,
            i.appVersion ?? t.never,
            i.count,
            i.platform === "android" ? versionState(i) : t.never,
          ])}
        />
        <Table
          id="downloads"
          caption={t.downloads}
          head={[t.version, t.source, t.count]}
          rows={s.downloads.map((d) => [d.version, d.source, d.count])}
        />
        <Table
          id="logins"
          caption={t.logins}
          head={[t.day, t.platform, t.count]}
          rows={s.logins.map((l) => [l.day, l.platform, l.count])}
        />
        <Table
          id="features"
          caption={t.features}
          head={[t.event, t.count]}
          rows={s.features.map((f) => [f.name, f.count])}
        />
        <Table
          id="screens"
          caption={t.screens}
          head={[t.screen, t.count]}
          rows={s.screens.map((x) => [x.screen, x.count])}
        />
        <Table
          id="errors"
          caption={t.errors}
          head={[t.errorCode, t.version, t.count]}
          rows={s.errors.map((e) => [e.errorCode, e.appVersion ?? t.never, e.count])}
        />
        <Table
          id="ai"
          caption={t.ai}
          head={[t.provider, t.result, t.count, t.avgDuration]}
          rows={s.ai.map((a) => [
            a.provider,
            a.result,
            a.count,
            `${number.format(a.avgDurationMs)} ms`,
          ])}
        />
        <Table
          id="ai-cost"
          caption={t.aiCost}
          head={[t.month, t.cost]}
          rows={s.aiCost.map((c) => [
            c.month,
            isCurrency(c.currency) ? formatMinor(c.costMinor, c.currency) : t.never,
          ])}
        />
      </div>
    </>
  );
}
