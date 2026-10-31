import type { Config } from "@/lib/config";
import type { LegalSection } from "@/content/legal";

import { getSiteI18n } from "@/lib/site-i18n";
import { legalLocale } from "@/lib/site-locale";

import { DraftBanner } from "./site-shell";

/** O pagină juridică: titlu, bannerul de ciornă și secțiunile (din `src/content/legal.ts`). */
export async function LegalPage({
  title,
  sections,
  site,
}: Readonly<{ title: string; sections: readonly LegalSection[]; site: Config["site"] }>) {
  const { locale, t } = await getSiteI18n();
  // Limbile fără traducere juridică revizuită primesc textul englez, marcat cu `lang` propriu și cu
  // o notă în limba paginii (ADR 0033); româna și engleza rămân neschimbate.
  const textLang = legalLocale(locale);
  const translated = locale !== "ro" && locale !== "en";
  return (
    <article>
      <h1 className="mb-4 text-3xl font-bold">{title}</h1>
      <DraftBanner site={site} t={t.draft} />
      {translated && (
        <p className="mb-4 text-sm text-muted-foreground" data-testid="legal-translation-note">
          {t.draft.translationNote}
        </p>
      )}
      <div lang={translated ? textLang : undefined}>
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
      </div>
    </article>
  );
}
