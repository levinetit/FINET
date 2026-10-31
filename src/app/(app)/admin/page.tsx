import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { siteConfigOrNotFound } from "@/lib/site";
import { ro } from "@/messages/ro";
import {
  adminAnnouncements,
  adminErrors,
  adminFeedback,
  adminHouseholds,
  adminJobs,
  adminUsers,
  isAdmin,
} from "@/modules/admin/admin.service";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

import {
  AnnouncementForm,
  ArchiveButton,
  FeedbackReward,
  FeedbackStatus,
  UserStatusButton,
} from "./admin-actions";

export const metadata: Metadata = {
  title: ro.admin.title,
  robots: { index: false, follow: false },
};

/**
 * Panoul de administrare (F11-B, ADR 0028): doar `saas` ȘI doar administratorul platformei; orice alt
 * caz răspunde 404 (nu se dezvăluie panoul). Fără date financiare: utilizatori, gospodării, cozi,
 * feedback, anunțuri și erori.
 */
export default async function AdminPage() {
  // Întâi sesiunea: anonimul ajunge la /login ca pe orice rută privată; abia apoi 404 în `personal`.
  const session = await requirePageSession("/admin");
  siteConfigOrNotFound();
  const db = session.runtime.db;
  if (!(await isAdmin(db, session.userId))) notFound();
  const t = ro.admin;
  const [users, households, jobs, feedback, announcements, errors] = await Promise.all([
    adminUsers(db, session.userId, { limit: 100 }),
    adminHouseholds(db, session.userId, { limit: 100 }),
    adminJobs(db, session.userId),
    adminFeedback(db, session.userId, { limit: 50 }),
    adminAnnouncements(db, session.userId),
    adminErrors(db, session.userId),
  ]);
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={false} />
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="admin-feedback">
          <CardHeader>
            <CardTitle id="admin-feedback">{t.feedback}</CardTitle>
          </CardHeader>
          {feedback.length === 0 ? <p>{t.none}</p> : null}
          <ul className="flex flex-col gap-3" data-testid="admin-feedback-list">
            {feedback.map((f) => (
              <li key={f.id} className="border-t pt-2">
                <p className="text-sm text-muted-foreground">
                  {f.kind} · {f.authorEmail} · {f.createdAt.slice(0, 10)}
                  {f.page ? ` · ${f.page}` : ""}
                </p>
                <p>{f.message}</p>
                <FeedbackStatus id={f.id} status={f.status} />
                <FeedbackReward id={f.id} rewarded={f.rewarded} />
              </li>
            ))}
          </ul>
        </Card>

        <Card aria-labelledby="admin-announcements">
          <CardHeader>
            <CardTitle id="admin-announcements">{t.announcements}</CardTitle>
          </CardHeader>
          <ul className="mb-4 flex flex-col gap-2">
            {announcements.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
                <span className="font-semibold">{a.title}</span>
                <span className="text-muted-foreground">
                  {t.levels[a.level]}
                  {a.archived ? ` · ${t.archived}` : ""}
                </span>
                {a.archived ? null : <ArchiveButton id={a.id} />}
              </li>
            ))}
          </ul>
          <AnnouncementForm />
        </Card>

        <Card aria-labelledby="admin-users">
          <CardHeader>
            <CardTitle id="admin-users">{t.users}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-2" data-testid="admin-users-list">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2 border-t pt-2">
                <span>
                  {u.email} · {u.name}
                </span>
                <span className="text-muted-foreground">
                  {u.status} · {u.households}
                  {u.isPlatformAdmin ? " · admin" : ""}
                </span>
                {u.id === session.userId ? null : <UserStatusButton id={u.id} status={u.status} />}
              </li>
            ))}
          </ul>
        </Card>

        <Card aria-labelledby="admin-households">
          <CardHeader>
            <CardTitle id="admin-households">{t.households}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-1">
            {households.map((h) => (
              <li key={h.id}>
                {h.name} · {t.members}: {h.members}
              </li>
            ))}
          </ul>
        </Card>

        <Card aria-labelledby="admin-jobs">
          <CardHeader>
            <CardTitle id="admin-jobs">{t.jobs}</CardTitle>
          </CardHeader>
          {jobs.length === 0 ? <p>{t.none}</p> : null}
          <ul className="flex flex-col gap-1">
            {jobs.map((j) => (
              <li key={`${j.name}-${j.state}`}>
                {j.name} · {j.state} · {j.jobs}
              </li>
            ))}
          </ul>
        </Card>

        <Card aria-labelledby="admin-errors">
          <CardHeader>
            <CardTitle id="admin-errors">{t.errors}</CardTitle>
          </CardHeader>
          {errors.length === 0 ? <p>{t.none}</p> : null}
          <ul className="flex flex-col gap-1">
            {errors.map((e) => (
              <li key={`${e.kind}-${e.route}-${e.code}-${e.digest ?? ""}`}>
                {e.kind} · {e.route} · {e.code} · ×{e.occurrences}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
