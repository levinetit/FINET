import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { requirePageSession } from "../../_lib/session";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.help.title };

/**
 * Ghidul `/help` (Faza 9, ADR 0020), în zona autentificată (și în modul `personal`): pașii
 * principali (conturi, tranzacții, bonuri, extrase (Faza 7), familie, instalarea
 * PWA) și întrebările frecvente. Text static din `ro.help`; fără date ale utilizatorului.
 * Întrebările frecvente folosesc `<details>`/`<summary>` (accesibile din tastatură, fără JS).
 */
export default async function HelpPage() {
  await requirePageSession("/help");
  const t = ro.help;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <nav aria-label={t.tocLabel} className="mb-6">
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {t.sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="font-semibold text-primary underline">
                {s.title}
              </a>
            </li>
          ))}
          <li>
            <a href="#intrebari" className="font-semibold text-primary underline">
              {t.faqTitle}
            </a>
          </li>
        </ul>
      </nav>
      <div className="flex flex-col gap-4">
        {t.sections.map((s) => (
          <Card key={s.id} id={s.id} aria-labelledby={`${s.id}-titlu`} className="scroll-mt-6">
            <h2 id={`${s.id}-titlu`} className="mb-2 text-xl font-semibold">
              {s.title}
              {"soon" in s && s.soon ? (
                <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-sm font-medium text-muted-foreground">
                  {t.soon}
                </span>
              ) : null}
            </h2>
            <ul className="flex list-disc flex-col gap-2 pl-5">
              {s.body.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        ))}
        <Card id="intrebari" aria-labelledby="intrebari-titlu" className="scroll-mt-6">
          <h2 id="intrebari-titlu" className="mb-2 text-xl font-semibold">
            {t.faqTitle}
          </h2>
          <div className="flex flex-col divide-y divide-border">
            {t.faq.map((item) => (
              <details key={item.q} className="py-2">
                <summary className="cursor-pointer font-semibold">{item.q}</summary>
                <p className="mt-2 text-muted-foreground">{item.a}</p>
              </details>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
