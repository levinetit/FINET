import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { isPlatformAdmin } from "@/modules/usage/stats";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.settings.title };

/**
 * Setările aplicației (Faza 9, ADR 0020): ghidul de instalare a PWA (același text ca în
 * `/help#instalare`), legătura spre „Aplicația Android”, profilul și ajutorul. Contul (nume,
 * parolă, sesiuni, consimțăminte) rămâne în `/profile`. F9-B: „Datele mele” (export, ștergere) și,
 * doar pentru administratorul platformei, „Statistici”.
 */
export default async function SettingsPage() {
  const session = await requirePageSession("/settings");
  const admin = await isPlatformAdmin(session.runtime.db, session.userId);
  const t = ro.settings;
  const install = ro.help.sections.find((s) => s.id === "instalare")!;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="instalare-titlu" id="instalare">
          <h2 id="instalare-titlu" className="mb-2 text-xl font-semibold">
            {t.installTitle}
          </h2>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            {install.body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
        {(
          [
            ["android", t.androidTitle, t.androidBody, t.androidLink, "/settings/android"],
            ["profil", t.profileTitle, t.profileBody, t.profileLink, "/profile"],
            ["date", t.privacyTitle, t.privacyBody, t.privacyLink, "/settings/privacy"],
            ...(admin
              ? ([
                  ["statistici", t.statsTitle, t.statsBody, t.statsLink, "/settings/statistics"],
                ] as const)
              : []),
            ["ajutor", t.helpTitle, t.helpBody, t.helpLink, "/help"],
          ] as const
        ).map(([id, title, body, link, href]) => (
          <Card key={id} aria-labelledby={`${id}-titlu`}>
            <CardHeader>
              <CardTitle id={`${id}-titlu`}>{title}</CardTitle>
              <CardDescription>{body}</CardDescription>
            </CardHeader>
            <Link href={href} className={buttonClasses("outline")}>
              {link}
            </Link>
          </Card>
        ))}
      </div>
    </>
  );
}
