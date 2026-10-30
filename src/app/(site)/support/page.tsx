import type { Metadata } from "next";

import { siteConfigOrNotFound } from "@/lib/site";
import { getSiteI18n } from "@/lib/site-i18n";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getSiteI18n();
  return { title: t.support.title };
}

/** Pagina publică de suport (Faza 11-C, ADR 0029; ghidul din aplicație rămâne `/help`): răspunsuri scurte; contactul vine din datele firmei. */
export default async function SupportPage() {
  const site = siteConfigOrNotFound();
  const { t: all } = await getSiteI18n();
  const t = all.support;
  const email = site.company.email;
  return (
    <>
      <h1 className="mb-2 text-3xl font-bold">{t.title}</h1>
      <p className="mb-6 text-muted-foreground">{t.lead}</p>
      <div className="flex flex-col gap-6" data-testid="support-sections">
        {t.sections.map((section) => (
          <section key={section.id} aria-labelledby={`support-${section.id}`}>
            <h2 id={`support-${section.id}`} className="mb-1 text-xl font-semibold">
              {section.title}
            </h2>
            <p>{section.body}</p>
          </section>
        ))}
        <section aria-labelledby="support-contact">
          <h2 id="support-contact" className="mb-1 text-xl font-semibold">
            {t.contactTitle}
          </h2>
          <p>
            {t.contactLead}{" "}
            {email ? (
              <a href={`mailto:${email}`}>{email}</a>
            ) : (
              <span className="text-muted-foreground">[{all.footer.missing}]</span>
            )}
            .
          </p>
        </section>
      </div>
    </>
  );
}
