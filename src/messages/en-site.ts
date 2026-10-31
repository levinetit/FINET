import type { ro } from "./ro";

/**
 * Textele PAGINILOR PUBLICE ale site-ului `saas` în engleză (Faza 11-C3, ADR 0031). Forma e
 * impusă de tipul `ro.site` (aceleași chei, același tip de valori), deci TypeScript refuză o cheie
 * lipsă sau în plus; lungimea listelor o verifică un test. Româna rămâne versiunea de referință.
 */
type Shape<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Shape<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Shape<T[K]> }
      : T;

export type SiteMessages = Shape<typeof ro.site>;

export const enSite: SiteMessages = {
  nav: {
    pricing: "Pricing",
    terms: "Terms",
    privacy: "Privacy",
    support: "Support",
    login: "Sign in",
    register: "Create account",
    language: "Language",
    skip: "Skip to content",
  },
  landing: {
    title: "FINET: your finances and your family's, in one place",
    lead: "Track accounts, spending and budgets, scan receipts and see where the money goes.",
    features: [
      "Receipts read from a photo or PDF, with your review before saving",
      "Budgets, goals and reports by month, category and merchant",
      "Family: shared and personal accounts, balances and settlements",
      "Bank statements, shopping lists and prices per product",
      "Export to CSV, Excel and PDF, plus an export for your accountant",
      "Your data under your control: export and delete straight from the app",
    ],
    cta: "Create account",
    secondary: "Already have an account? Sign in",
  },
  pricing: {
    title: "Pricing",
    body: "Plans and prices will be published here when they launch. Until then, the service has no paid plans yet.",
  },
  support: {
    title: "Support",
    lead: "Short answers about using FINET. If you can't find what you need, write to us.",
    sections: [
      {
        id: "inceput",
        title: "How do I get started?",
        body: "Create your account with your email, then add your accounts (cash, bank, card) and your first transactions. Every new account gets a personal household that you can extend later.",
      },
      {
        id: "bonuri",
        title: "Receipts",
        body: "Upload a photo or PDF of a receipt; FINET suggests the data it read, and you review and correct it before saving. Nothing is saved without your confirmation.",
      },
      {
        id: "familie",
        title: "Family and households",
        body: "You can invite members to a household, with shared and personal accounts. Everyone sees only what their role allows.",
      },
      {
        id: "export",
        title: "Export and reports",
        body: "Export transactions to CSV, Excel or PDF, and generate an export for your accountant. Reports by month, category and merchant are in the app.",
      },
      {
        id: "date",
        title: "Your data",
        body: "You can download all your data and delete your account straight from Settings, in the privacy section. Details are in the privacy policy.",
      },
      {
        id: "parola",
        title: "I forgot my password",
        body: "On the sign-in page, use the password reset option or the sign-in link sent by email, if the service offers it.",
      },
    ],
    contactTitle: "Contact",
    contactLead: "For questions or problems, write to us at",
  },
  terms: { title: "Terms and conditions" },
  privacy: { title: "Privacy policy" },
  draft: {
    title: "Text under review",
    body: "This is a working draft that has not been legally reviewed. It has no effect until it is reviewed and published by the operator. The Romanian version is the reference text.",
    incomplete: "The details of the company operating the service have not been filled in yet.",
    translationNote:
      "The legal text is shown in English (working translation); the Romanian version is the reference text.",
  },
  footer: {
    operator: "Operator",
    taxId: "Tax ID (CUI)",
    registration: "Trade Register",
    address: "Address",
    contact: "Contact",
    missing: "to be completed",
    consumer: "Consumer disputes",
    anpcSal: "ANPC SAL",
    sol: "EU ODR platform",
  },
  consent: {
    title: "Cookies",
    body: "We use strictly necessary cookies. With your consent we also use analytics cookies to understand how the site is used. You can decline with no effect on the service.",
    accept: "Accept analytics",
    reject: "Decline",
    region: "Your cookie choice",
  },
};
