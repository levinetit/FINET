/**
 * Textele interfeței în română (Faza 1). Nu conțin secrete: sunt importate și de componentele de
 * client. O limbă nouă (`en-US`, rezervată în `profile.schema.ts`) va avea un fișier cu aceeași
 * formă (`Messages`).
 */
export const ro = {
  app: {
    name: "FINET",
    tagline: "România · finanțe de familie",
  },
  nav: {
    label: "Navigare principală",
    dashboard: "Acasă",
    profile: "Profil",
    logout: "Deconectează-te",
    loggingOut: "Se deconectează…",
    logoutError: "Deconectarea nu a reușit. Încearcă din nou.",
  },
  login: {
    title: "Autentificare",
    subtitle: "Intră în contul FINET al gospodăriei tale.",
    email: "Email",
    password: "Parolă",
    submit: "Intră în cont",
    submitting: "Se verifică…",
    magicLink: "Trimite link de autentificare",
    magicLinkSending: "Se trimite…",
    magicLinkSent:
      "Dacă adresa are un cont activ, vei primi în câteva minute un link de autentificare valabil 10 minute.",
    magicLinkNeedsEmail: "Completează adresa de email pentru link.",
    or: "sau",
    // Mesaj uniform: nu spune dacă emailul există sau doar parola e greșită.
    invalidCredentials: "Email sau parolă greșită.",
    rateLimited: "Prea multe încercări. Încearcă din nou mai târziu.",
    rateLimitedRetry: (minutes: number) =>
      `Prea multe încercări. Încearcă din nou peste ${minutes} ${minutes === 1 ? "minut" : "minute"}.`,
    genericError: "Autentificarea nu a reușit. Încearcă din nou.",
    missingFields: "Completează emailul și parola.",
    noAccount: "Conturile se creează de administratorul gospodăriei.",
  },
  register: {
    title: "Înregistrare",
    unavailable:
      "Înregistrarea publică nu e disponibilă încă: va fi deschisă odată cu fundația SaaS (Faza 11).",
    backToLogin: "Înapoi la autentificare",
  },
  dashboard: {
    title: "Acasă",
    placeholder: "Aici va apărea dashboard-ul (Faza 3).",
    household: "Gospodăria",
    role: "Rolul tău",
    noHousehold: "Nu faci parte încă din nicio gospodărie.",
    roles: { owner: "Proprietar", member: "Membru" } as Record<string, string>,
    greeting: (name: string) => `Bună, ${name}!`,
  },
  profile: {
    title: "Profil",
    account: "Cont",
    name: "Nume",
    email: "Email",
    emailHint: "Emailul îl schimbă administratorul.",
    preferences: "Preferințe",
    theme: "Temă",
    themes: { system: "Ca sistemul", light: "Luminoasă", dark: "Întunecată" } as Record<
      string,
      string
    >,
    locale: "Limba",
    locales: { "ro-RO": "Română", "en-US": "English (în curând)" } as Record<string, string>,
    timezone: "Fus orar",
    currency: "Moneda implicită",
    save: "Salvează",
    saving: "Se salvează…",
    saved: "Modificările au fost salvate.",
    saveError: "Modificările nu au fost salvate. Verifică valorile și încearcă din nou.",
    invalidName: "Numele trebuie să aibă între 1 și 100 de caractere.",
  },
  password: {
    title: "Schimbă parola",
    hint: "Minimum 10 caractere. După schimbare, celelalte sesiuni se închid.",
    current: "Parola curentă",
    next: "Parola nouă",
    confirm: "Confirmă parola nouă",
    submit: "Schimbă parola",
    submitting: "Se schimbă…",
    mismatch: "Parolele noi nu coincid.",
    tooShort: "Parola nouă trebuie să aibă cel puțin 10 caractere.",
    done: (revoked: number) =>
      revoked === 0
        ? "Parola a fost schimbată."
        : `Parola a fost schimbată. ${revoked === 1 ? "O altă sesiune a fost închisă" : `${revoked} alte sesiuni au fost închise`}.`,
    error: "Parola nu a fost schimbată. Încearcă din nou.",
  },
  sessions: {
    title: "Sesiuni active",
    hint: "Dispozitivele conectate acum la contul tău.",
    empty: "Nu există alte sesiuni active.",
    current: "Sesiunea curentă",
    lastActive: "Ultima activitate",
    created: "Conectat",
    ip: "IP",
    revoke: "Revocă",
    revokeConfirm: "Sigur închizi această sesiune?",
    confirm: "Da, revocă",
    cancel: "Anulează",
    revoking: "Se revocă…",
    revokeOthers: "Deconectează celelalte",
    revokeOthersConfirm: "Sigur închizi toate celelalte sesiuni?",
    revokedOthers: (n: number) =>
      n === 0
        ? "Nu existau alte sesiuni."
        : n === 1
          ? "O sesiune a fost închisă."
          : `${n} sesiuni au fost închise.`,
    revoked: "Sesiunea a fost închisă.",
    error: "Operația nu a reușit. Reîncarcă pagina și încearcă din nou.",
    loadError: "Lista sesiunilor nu a putut fi încărcată.",
  },
  common: {
    loading: "Se încarcă…",
    unexpected: "A apărut o eroare. Reîncarcă pagina.",
    notFoundTitle: "Pagina nu există",
    notFoundBody: "Adresa nu corespunde niciunei pagini FINET.",
    backHome: "Mergi la pagina principală",
    errorTitle: "Ceva nu a mers",
    retry: "Încearcă din nou",
    sessionExpired: "Sesiunea a expirat. Autentifică-te din nou.",
  },
} as const;

export type Messages = typeof ro;
