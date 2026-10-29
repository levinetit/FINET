import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { qrMatrix, qrSvgPath } from "@/lib/qr";
import { ro } from "@/messages/ro";
import { readAndroidRelease } from "@/modules/app-release/android";

import { requirePageSession } from "../../../_lib/session";
import { PageHeader } from "../../page-header";

export const metadata: Metadata = { title: ro.android.title };

const dateFormat = new Intl.DateTimeFormat("ro-RO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Bucharest",
});

/** Dimensiunea în MB, cu o zecimală (`23,4 MB`); întregi, fără aritmetică float pe octeți. */
function megabytes(bytes: number): string {
  const tenths = Math.round((bytes * 10) / (1024 * 1024));
  return `${Math.floor(tenths / 10)},${tenths % 10} MB`;
}

/**
 * Setări → Aplicația Android (Faza 9; promptul Android 12.1; ADR 0020), doar cu sesiune: versiunea
 * curentă din `<STORAGE_DIR>/app/android-latest.json` (aceeași sursă ca
 * `GET /api/v1/app/android/latest`), butonul de descărcare, codul QR al aceluiași link (generat pe
 * server, `src/lib/qr.ts`, SVG fără JavaScript) și pașii de instalare. Fără versiune publicată:
 * mesaj „indisponibil”.
 */
export default async function AndroidPage() {
  const session = await requirePageSession("/settings/android");
  const t = ro.android;
  const release = await readAndroidRelease(session.runtime.config.storage.dir);
  const qr = release ? qrSvgPath(qrMatrix(release.url)) : null;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} />
      <div className="flex flex-col gap-4">
        {!release || !qr ? (
          <Alert tone="info" data-testid="android-unavailable">
            {t.unavailable}
          </Alert>
        ) : (
          <Card aria-labelledby="android-versiune" data-testid="android-release">
            <CardHeader>
              <CardTitle id="android-versiune">FINET {release.versionName}</CardTitle>
              <CardDescription>{t.minSupported(release.minSupportedVersionCode)}</CardDescription>
            </CardHeader>
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_220px]">
              <div className="flex min-w-0 flex-col gap-3">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                  <dt className="text-muted-foreground">{t.version}</dt>
                  <dd>
                    {release.versionName} ({release.versionCode})
                  </dd>
                  {release.publishedAt ? (
                    <>
                      <dt className="text-muted-foreground">{t.published}</dt>
                      <dd>{dateFormat.format(new Date(release.publishedAt))}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">{t.size}</dt>
                  <dd>{megabytes(release.sizeBytes)}</dd>
                  <dt className="text-muted-foreground">{t.sha256}</dt>
                  <dd className="font-mono text-sm break-all" data-testid="android-sha256">
                    {release.sha256}
                  </dd>
                </dl>
                {release.notes ? (
                  <div>
                    <h3 className="font-semibold">{t.notes}</h3>
                    <p className="whitespace-pre-line text-muted-foreground">{release.notes}</p>
                  </div>
                ) : null}
                <a
                  href={release.url}
                  rel="noopener noreferrer"
                  className={buttonClasses("default")}
                  data-testid="android-download"
                >
                  {t.download}
                </a>
              </div>
              <figure className="flex flex-col items-center gap-2">
                <svg
                  viewBox={`0 0 ${qr.size} ${qr.size}`}
                  role="img"
                  aria-label={t.qrLabel(release.versionName)}
                  className="size-[200px] rounded-md"
                  shapeRendering="crispEdges"
                  data-testid="android-qr"
                >
                  <rect width={qr.size} height={qr.size} fill="#ffffff" />
                  <path d={qr.d} fill="#000000" />
                </svg>
                <figcaption className="text-center text-sm text-muted-foreground">
                  {t.qrHint}
                </figcaption>
              </figure>
            </div>
          </Card>
        )}
        <Card aria-labelledby="android-pasi">
          <h2 id="android-pasi" className="mb-2 text-xl font-semibold">
            {t.stepsTitle}
          </h2>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            {t.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
