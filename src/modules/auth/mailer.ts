import "server-only";

import type { Config } from "@/lib/config";

/**
 * Emailurile de autentificare (magic link, resetarea parolei), prin SMTP cu Nodemailer
 * (master prompt 3.2). Fără SMTP configurat (`SMTP_HOST`), `createMailer` întoarce `null`, iar
 * magic link-ul și resetarea prin email sunt dezactivate (resetarea se face din CLI).
 *
 * Reguli: link-urile și tokenurile NU se loghează niciodată; o eroare de trimitere se raportează
 * doar prin cod (fără adresă, fără conținut). Testele injectează un `Mailer` fals (fără rețea).
 */

export type MailMessage = Readonly<{ to: string; subject: string; text: string; html: string }>;

export type Mailer = Readonly<{ send: (message: MailMessage) => Promise<void> }>;

type SmtpConfig = NonNullable<Config["notify"]["smtp"]>;

/** Transportul Nodemailer; importul e leneș, ca modulul să nu fie încărcat fără SMTP. */
export function createMailer(smtp: SmtpConfig | null): Mailer | null {
  if (!smtp) return null;
  let transport: Promise<{ sendMail: (m: object) => Promise<unknown> }> | null = null;
  const getTransport = () => {
    transport ??= import("nodemailer").then((nodemailer) =>
      nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        // 465 = TLS implicit; 587 (submission) = STARTTLS obligatoriu. Alte porturi (de exemplu
        // 1025, serverul de test local) folosesc STARTTLS doar dacă serverul îl oferă.
        secure: smtp.port === 465,
        requireTLS: smtp.port === 587,
        auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? "" } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        logger: false,
        debug: false,
      }),
    );
    return transport;
  };
  return {
    send: async (message) => {
      const t = await getTransport();
      try {
        await t.sendMail({ from: smtp.from, ...message });
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : "necunoscut";
        // Fără adresă și fără conținut în mesaj.
        throw new Error(`trimiterea emailului a eșuat (${code})`);
      }
    },
  };
}

/**
 * Trimiterea în fundal (M4): răspunsul HTTP nu așteaptă căutarea contului și trimiterea, deci
 * timpul lui nu depinde de existența contului (fără oracol de timp la magic link / resetare).
 * O eroare se raportează fără adresă și fără conținut. Promisiunile în curs se pot aștepta
 * (`waitForBackgroundMail`, teste și oprirea procesului).
 */
const pending = new Set<Promise<void>>();

export function sendInBackground(
  mailer: Mailer,
  build: () => Promise<MailMessage | null> | MailMessage | null,
): void {
  const task = (async () => {
    const message = await build();
    if (message) await mailer.send(message);
  })()
    .catch(() => {
      console.error("[auth] trimiterea emailului de autentificare a eșuat");
    })
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

/** Așteaptă emailurile trimise în fundal (teste; oprirea procesului). */
export async function waitForBackgroundMail(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function render(appName: string, intro: string, action: string, url: string, outro: string) {
  const text = `${intro}\n\n${action}:\n${url}\n\n${outro}\n\n— ${appName}`;
  const html =
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p>` +
    `<p>${escapeHtml(outro)}</p><p>— ${escapeHtml(appName)}</p>`;
  return { text, html };
}

/** Șablonul magic link (română, scurt). */
export function magicLinkMessage(appName: string, to: string, url: string, minutes: number) {
  return {
    to,
    subject: `Conectare la ${appName}`,
    ...render(
      appName,
      `Ai cerut un link de conectare la ${appName}.`,
      "Conectează-te",
      url,
      `Linkul se poate folosi o singură dată și expiră în ${minutes} minute. Dacă nu ai cerut tu, ignoră acest mesaj.`,
    ),
  } satisfies MailMessage;
}

/** Șablonul de resetare a parolei (română, scurt). */
export function resetPasswordMessage(appName: string, to: string, url: string, minutes: number) {
  return {
    to,
    subject: `Resetarea parolei ${appName}`,
    ...render(
      appName,
      `Ai cerut resetarea parolei pentru contul ${appName}.`,
      "Alege o parolă nouă",
      url,
      `Linkul expiră în ${minutes} minute. Dacă nu ai cerut tu, ignoră acest mesaj; parola rămâne aceeași.`,
    ),
  } satisfies MailMessage;
}
