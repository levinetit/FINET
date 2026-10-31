import { isIP } from "node:net";

import { z } from "zod";

/**
 * Ajutoare pure pentru cererile de autentificare (fără Next.js, fără bază): normalizarea
 * emailului, IP-ul de încredere și antetul clientului mobil.
 */

/** Emailul normalizat (trim + litere mici), aceeași regulă ca CHECK-ul din `finet.users`. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Validarea unui email deja normalizat (aceeași formă ca CHECK-urile din schemă). */
export const emailSchema = z.string().max(254).transform(normalizeEmail).pipe(z.email().max(254));

/**
 * Antetul intern în care se pune IP-ul clientului DUPĂ verificarea de încredere; Better Auth îl
 * citește (`advanced.ipAddress.ipAddressHeaders`). Orice valoare venită de la client se șterge
 * înainte (`withTrustedClientIp`).
 */
export const CLIENT_IP_HEADER = "x-finet-client-ip";

/**
 * Antetul clientului (master prompt 6.5): `X-FINET-Client: android/<versiune>` (Faza 1) sau forma
 * completă `platform=...; installation=...; ...` (F2-B, `parseClientInfo`).
 */
export const CLIENT_HEADER = "x-finet-client";

export type TrustPolicy = Readonly<{
  /**
   * `true` când `src/proxy.ts` a verificat deja JWT-ul Cloudflare Access pentru această cerere
   * (`config.access.clientIpTrusted`): doar atunci cererea a trecut prin tunel, iar `cf-connecting-ip`
   * l-a pus Cloudflare, nu clientul.
   */
  accessVerified: boolean;
}>;

/**
 * IP-ul clientului, doar din surse de încredere: `cf-connecting-ip` dacă cererea a trecut prin
 * Access (altfel orice antet poate fi falsificat de client), validat ca adresă IP. Fără o sursă
 * de încredere, `null` (cheile de rate limiting folosesc atunci un grup comun, „necunoscut”).
 */
export function trustedClientIp(headers: Headers, policy: TrustPolicy): string | null {
  if (!policy.accessVerified) return null;
  const value = headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > 45 || isIP(value) === 0) return null;
  return value.toLowerCase();
}

/** Copie a antetelor, cu `x-finet-client-ip` stabilit DOAR din sursa de încredere. */
export function withTrustedClientIp(headers: Headers, policy: TrustPolicy): Headers {
  const copy = new Headers(headers);
  copy.delete(CLIENT_IP_HEADER);
  const ip = trustedClientIp(headers, policy);
  if (ip) copy.set(CLIENT_IP_HEADER, ip);
  return copy;
}

/**
 * Forma trunchiată a unui IP pentru afișare (6.5): IPv4 → primele 3 octeți (`203.0.113.x`),
 * IPv6 → primele 3 grupuri (`2001:db8:1::/48`). Altceva → `null`.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const kind = isIP(ip);
  if (kind === 4) return `${ip.split(".").slice(0, 3).join(".")}.x`;
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return truncateIp(mapped[1]);
    const groups = expandIpv6(ip).slice(0, 3);
    return `${groups.join(":")}::/48`;
  }
  return null;
}

function expandIpv6(ip: string): string[] {
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const missing = ip.includes("::") ? 8 - h.length - t.length : 0;
  return [...h, ...Array<string>(missing).fill("0"), ...t].map((g) =>
    g.replace(/^0+(?=.)/, "").toLowerCase(),
  );
}

// ---------------------------------------------------------------------------------------------
// Clientul mobil
// ---------------------------------------------------------------------------------------------

/** `android/<versiune>`, versiune semantică scurtă (cu sufix opțional), cel mult 40 de caractere. */
const clientHeaderSchema = z
  .string()
  .max(40)
  .regex(/^android\/\d{1,4}(?:\.\d{1,4}){0,3}(?:-[0-9A-Za-z.]{1,16})?$/);

export type FinetClient = Readonly<{ platform: "android"; version: string }>;

/**
 * Forma completă a antetului (F2-B, ADR 0005), perechi `cheie=valoare` separate prin `;`:
 *
 *   X-FINET-Client: platform=android; version=1.0.2; code=10002;
 *     installation=<uuid>; os=14; model=Pixel 8; locale=ro-RO
 *
 * Reguli (stricte; orice abatere face antetul INVALID, adică ignorat, fără eroare):
 * - cel mult `CLIENT_INFO_MAX_LENGTH` caractere, doar ASCII tipăribil;
 * - cheile din lista fixă de mai jos, fiecare cel mult o dată; o cheie necunoscută → invalid;
 * - `platform` (`android` sau `web`) și `installation` (uuid) sunt obligatorii;
 * - valorile respectă aceleași limite ca CHECK-urile din `finet.client_installations`.
 */
export const CLIENT_INFO_MAX_LENGTH = 400;

export const CLIENT_INFO_KEYS = [
  "platform",
  "version",
  "code",
  "installation",
  "os",
  "model",
  "locale",
] as const;

const clientInfoSchema = z.strictObject({
  platform: z.enum(["android", "web"]),
  installation: z.uuid().transform((v) => v.toLowerCase()),
  version: z
    .string()
    .regex(/^[0-9A-Za-z.+_-]{1,32}$/)
    .optional(),
  code: z
    .string()
    .regex(/^[0-9]{1,10}$/)
    .transform(Number)
    .refine((n) => n <= 2_100_000_000)
    .optional(),
  os: z
    .string()
    .regex(/^[0-9A-Za-z .+_()-]{1,64}$/)
    .optional(),
  model: z
    .string()
    .regex(/^[0-9A-Za-z .+_()-]{1,64}$/)
    .optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
});

export type ClientInfo = Readonly<{
  platform: "android" | "web";
  installationId: string;
  appVersion: string | null;
  versionCode: number | null;
  osVersion: string | null;
  deviceModel: string | null;
  locale: string | null;
}>;

/** Antetul complet validat, sau `null` (lipsă, formă veche `android/<v>` sau invalid). */
export function parseClientInfo(value: string | null | undefined): ClientInfo | null {
  if (!value || value.length > CLIENT_INFO_MAX_LENGTH) return null;
  if (!/^[\x20-\x7e]+$/.test(value)) return null;
  const pairs: Record<string, string> = {};
  for (const part of value.split(";")) {
    const item = part.trim();
    if (item === "") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) return null;
    const key = item.slice(0, eq).trim();
    const val = item.slice(eq + 1).trim();
    if (!(CLIENT_INFO_KEYS as readonly string[]).includes(key) || key in pairs || val === "") {
      return null;
    }
    pairs[key] = val;
  }
  const parsed = clientInfoSchema.safeParse(pairs);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    platform: d.platform,
    installationId: d.installation,
    appVersion: d.version ?? null,
    versionCode: d.code ?? null,
    osVersion: d.os ?? null,
    deviceModel: d.model ?? null,
    locale: d.locale ?? null,
  };
}

/**
 * Clientul Android din antetul `X-FINET-Client`, în oricare formă: cea veche (`android/<v>`,
 * Faza 1) sau cea completă cu `platform=android` și `version`. Orice altă formă e ignorată
 * (clientul e tratat ca web).
 */
export function parseClientHeader(value: string | null | undefined): FinetClient | null {
  if (!value) return null;
  const parsed = clientHeaderSchema.safeParse(value.trim());
  if (parsed.success) {
    return { platform: "android", version: parsed.data.slice("android/".length) };
  }
  const info = parseClientInfo(value);
  if (info?.platform === "android" && info.appVersion) {
    return { platform: "android", version: info.appVersion };
  }
  return null;
}

/**
 * Valoarea stocată în `auth_sessions.user_agent` pentru o sesiune mobilă (fără coloană nouă):
 * `FINET-Android/<versiune>`. Lista de sesiuni o afișează drept „Telefon Android”.
 */
export const ANDROID_USER_AGENT_PREFIX = "FINET-Android/";

/** User-agent-ul stocat pentru o sesiune web: trunchiat, fără caractere de control. */
export const USER_AGENT_MAX_LENGTH = 256;

export function sessionUserAgent(
  headers: Headers | null | undefined,
  rawUserAgent: string | null | undefined,
): string | null {
  const client = parseClientHeader(headers?.get(CLIENT_HEADER));
  if (client) return `${ANDROID_USER_AGENT_PREFIX}${client.version}`;
  if (!rawUserAgent) return null;
  const clean = rawUserAgent.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, USER_AGENT_MAX_LENGTH) : null;
}

/** Descrierea dispozitivului pentru lista de sesiuni (română, fără detalii inutile). */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Dispozitiv necunoscut";
  if (userAgent.startsWith(ANDROID_USER_AGENT_PREFIX)) return "Telefon Android";
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("firefox/")
      ? "Firefox"
      : ua.includes("chrome/") || ua.includes("crios/")
        ? "Chrome"
        : ua.includes("safari/")
          ? "Safari"
          : null;
  const os = ua.includes("android")
    ? "Android"
    : ua.includes("iphone") || ua.includes("ipad")
      ? "iOS"
      : ua.includes("windows")
        ? "Windows"
        : ua.includes("mac os")
          ? "macOS"
          : ua.includes("linux")
            ? "Linux"
            : null;
  if (browser && os) return `${browser} pe ${os}`;
  return browser ?? os ?? "Alt dispozitiv";
}
