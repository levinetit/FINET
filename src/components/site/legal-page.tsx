import type { Config } from "@/lib/config";
import type { LegalSection } from "@/content/legal";

import { getSiteI18n } from "@/lib/site-i18n";

import { DraftBanner } from "./site-shell";

/** O pagină juridică: titlu, bannerul de ciornă și secțiunile (din `src/content/legal.ts`). */
export async function LegalPage({
  title,
  sections,
  site,
}: Readonly<{ title: string; sections: readonly LegalSection[]; site: Config["site"] }>) {
  const { t } = await getSiteI18n();
  return (
    <article>
      <h1 className="mb-4 text-3xl font-bold">{title}</h1>
      <DraftBanner site={site} t={t.draft} />
      {sections.map((s) => (
        <section key={s.title} className="mb-5">
          <h2 className="mb-1 text-xl font-bold">{s.title}</h2>
          {s.paragraphs.map((p) => (
            <p key={p} className="mb-2">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
