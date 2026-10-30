/**
 * Textele juridice ale site-ului public (Faza 11, ADR 0027): CIORNE de lucru în română, scrise din
 * ceea ce face aplicația, NU consultanță juridică. Versiunea în engleză (Faza 11-C3, ADR 0031) e o
 * TRADUCERE de lucru a ciornei românești, sub același control (`SITE_LEGAL_REVIEWED`); româna rămâne
 * textul de referință, iar traducerea cere aceeași revizuire umană, pe piață. Nu sunt valabile până nu le revizuiește un om
 * (`SITE_LEGAL_REVIEWED=1`): până atunci pagina afișează un banner vizibil și nu se indexează.
 * Datele firmei nu sunt scrise aici: se inserează din configurație (`config.site.company`).
 */
import type { SiteLocale } from "@/lib/site-locale";

export type LegalSection = Readonly<{ title: string; paragraphs: readonly string[] }>;

export type CompanyView = Readonly<{
  name: string | null;
  taxId: string | null;
  registrationNo: string | null;
  address: string | null;
  email: string | null;
}>;

const MISSING = { ro: "[de completat]", en: "[to be completed]" } as const;
const orIn = (locale: SiteLocale) => (v: string | null) => v ?? MISSING[locale];

/** Termenii în limba cerută (implicit româna). */
export function termsSections(c: CompanyView, locale: SiteLocale = "ro"): readonly LegalSection[] {
  return locale === "en" ? termsEn(c) : termsRo(c);
}

/** Politica de confidențialitate în limba cerută (implicit româna). */
export function privacySections(
  c: CompanyView,
  locale: SiteLocale = "ro",
): readonly LegalSection[] {
  return locale === "en" ? privacyEn(c) : privacyRo(c);
}

function termsRo(c: CompanyView): readonly LegalSection[] {
  const or = orIn("ro");
  return [
    {
      title: "1. Cine oferă serviciul",
      paragraphs: [
        `FINET este oferit de ${or(c.name)}, CUI ${or(c.taxId)}, înregistrată la Registrul Comerțului sub nr. ${or(c.registrationNo)}, cu sediul în ${or(c.address)}. Contact: ${or(c.email)}.`,
        "FINET e o aplicație pentru urmărirea finanțelor personale și de familie: conturi, tranzacții, bugete, obiective, bonuri fiscale citite din poze sau PDF, extrase bancare, liste de cumpărături și rapoarte.",
      ],
    },
    {
      title: "2. Contul tău",
      paragraphs: [
        "Ești responsabil pentru păstrarea parolei și pentru ce se întâmplă în contul tău. Anunță-ne dacă bănuiești un acces neautorizat.",
        "Datele pe care le introduci trebuie să fie corecte; FINET nu verifică exactitatea sumelor.",
      ],
    },
    {
      title: "3. Utilizare acceptabilă",
      paragraphs: [
        "Nu folosi serviciul pentru activități ilegale, pentru a încerca să accesezi datele altor utilizatori sau pentru a-l supraîncărca (de exemplu cereri automate în masă).",
        "Putem limita sau suspenda un cont care încalcă aceste reguli sau pune în pericol securitatea serviciului.",
      ],
    },
    {
      title: "4. Datele tale",
      paragraphs: [
        "Datele pe care le introduci rămân ale tale. Le poți exporta și îți poți șterge contul oricând din aplicație (vezi politica de confidențialitate).",
        "FINET nu oferă sfaturi financiare, fiscale sau contabile. Rezumatele și răspunsurile automate sunt informative și pot conține erori; verifică-le înainte de a lua decizii.",
      ],
    },
    {
      title: "5. Planuri și plăți",
      paragraphs: [
        "Condițiile comerciale ale planurilor plătite (prețuri, perioade, reînnoire, retragere) se publică odată cu activarea lor și fac parte din acești termeni.",
      ],
    },
    {
      title: "6. Disponibilitate și răspundere",
      paragraphs: [
        "Depunem eforturi rezonabile ca serviciul să fie disponibil și datele protejate, dar nu garantăm funcționare neîntreruptă. Răspunderea noastră se limitează în măsura permisă de lege.",
      ],
    },
    {
      title: "7. Încetarea",
      paragraphs: [
        "Poți înceta oricând folosirea serviciului și îți poți șterge contul. După ștergere, datele se elimină conform politicii de confidențialitate.",
      ],
    },
    {
      title: "8. Legea aplicabilă și litigii",
      paragraphs: [
        "Se aplică legea română. Pentru consumatori rămân aplicabile dispozițiile imperative de protecție a consumatorilor.",
        "Soluționarea alternativă a litigiilor: ANPC SAL și platforma europeană SOL (legăturile se află în subsolul fiecărei pagini).",
      ],
    },
  ];
}

function privacyRo(c: CompanyView): readonly LegalSection[] {
  const or = orIn("ro");
  return [
    {
      title: "1. Operatorul datelor",
      paragraphs: [
        `Operatorul este ${or(c.name)}, CUI ${or(c.taxId)}, nr. Registrul Comerțului ${or(c.registrationNo)}, sediul ${or(c.address)}. Pentru orice cerere privind datele tale: ${or(c.email)}.`,
      ],
    },
    {
      title: "2. Ce date prelucrăm",
      paragraphs: [
        "Datele contului (email, nume, parolă stocată doar ca hash), datele financiare pe care le introduci (conturi, tranzacții, bugete, obiective, liste), documentele încărcate (poze de bonuri, PDF-uri, extrase) și conținutul citit din ele, precum și date tehnice minime (jurnale de securitate, adresa IP pentru limitarea abuzurilor).",
      ],
    },
    {
      title: "3. De ce și pe ce temei",
      paragraphs: [
        "Furnizarea serviciului pe care l-ai cerut (executarea contractului); securitatea și prevenirea abuzurilor (interes legitim); obligațiile legale; analiza vizitelor pe paginile publice, doar cu acordul tău (cookie-uri analytics).",
      ],
    },
    {
      title: "4. Servicii AI externe (opțional)",
      paragraphs: [
        "Citirea bonurilor cu un model AI extern, interpretarea întrebărilor libere din „Întreabă FINET” și alte funcții cu AI se fac DOAR cu acordul tău separat pentru fiecare, pe care îl poți retrage oricând din Profil. Către model pleacă doar datele strict necesare funcției respective, descrise în dreptul acordului; fără acord, nimic nu pleacă.",
      ],
    },
    {
      title: "5. Cu cine le împărtășim",
      paragraphs: [
        "Furnizorii de infrastructură (găzduire, bază de date, protecție de rețea, email tranzacțional) și, doar cu acordul tău, furnizorul modelului AI. Administratorii serviciului nu văd datele tale financiare.",
      ],
    },
    {
      title: "6. Cât păstrăm datele",
      paragraphs: [
        "Cât ai contul activ. Pozele bonurilor au o perioadă de retenție limitată, după care se șterg; la ștergerea contului eliminăm datele tale personale, iar copiile din backup expiră după perioada de backup.",
      ],
    },
    {
      title: "7. Drepturile tale",
      paragraphs: [
        "Acces, rectificare, ștergere, restricționare, portabilitate (export din aplicație), opoziție și retragerea consimțământului. Ștergerea contului și exportul datelor se fac direct din Profil. Ai dreptul de a depune plângere la ANSPDCP (dataprotection.ro).",
      ],
    },
    {
      title: "8. Cookie-uri",
      paragraphs: [
        "Folosim cookie-uri strict necesare (sesiune, temă, limba site-ului, alegerea ta privind cookie-urile). Cookie-urile de analytics se activează doar dacă le accepți în bannerul de pe paginile publice; le poți refuza fără efect asupra serviciului.",
      ],
    },
  ];
}

function termsEn(c: CompanyView): readonly LegalSection[] {
  const or = orIn("en");
  return [
    {
      title: "1. Who provides the service",
      paragraphs: [
        `FINET is provided by ${or(c.name)}, tax ID (CUI) ${or(c.taxId)}, registered with the Trade Register under no. ${or(c.registrationNo)}, with its registered office at ${or(c.address)}. Contact: ${or(c.email)}.`,
        "FINET is an application for tracking personal and family finances: accounts, transactions, budgets, goals, receipts read from photos or PDFs, bank statements, shopping lists and reports.",
      ],
    },
    {
      title: "2. Your account",
      paragraphs: [
        "You are responsible for keeping your password safe and for what happens in your account. Tell us if you suspect unauthorised access.",
        "The data you enter must be correct; FINET does not verify the accuracy of amounts.",
      ],
    },
    {
      title: "3. Acceptable use",
      paragraphs: [
        "Do not use the service for illegal activities, to try to access other users' data or to overload it (for example, mass automated requests).",
        "We may limit or suspend an account that breaks these rules or endangers the security of the service.",
      ],
    },
    {
      title: "4. Your data",
      paragraphs: [
        "The data you enter remains yours. You can export it and delete your account at any time from the app (see the privacy policy).",
        "FINET does not provide financial, tax or accounting advice. Summaries and automatic answers are informational and may contain errors; check them before making decisions.",
      ],
    },
    {
      title: "5. Plans and payments",
      paragraphs: [
        "The commercial terms of paid plans (prices, periods, renewal, withdrawal) are published when the plans launch and form part of these terms.",
      ],
    },
    {
      title: "6. Availability and liability",
      paragraphs: [
        "We make reasonable efforts to keep the service available and the data protected, but we do not guarantee uninterrupted operation. Our liability is limited to the extent permitted by law.",
      ],
    },
    {
      title: "7. Termination",
      paragraphs: [
        "You can stop using the service and delete your account at any time. After deletion, the data is removed according to the privacy policy.",
      ],
    },
    {
      title: "8. Governing law and disputes",
      paragraphs: [
        "Romanian law applies. For consumers, the mandatory consumer-protection provisions remain applicable.",
        "Alternative dispute resolution: ANPC SAL and the European ODR platform (the links are in the footer of every page).",
      ],
    },
  ];
}

function privacyEn(c: CompanyView): readonly LegalSection[] {
  const or = orIn("en");
  return [
    {
      title: "1. Data controller",
      paragraphs: [
        `The controller is ${or(c.name)}, tax ID (CUI) ${or(c.taxId)}, Trade Register no. ${or(c.registrationNo)}, registered office ${or(c.address)}. For any request about your data: ${or(c.email)}.`,
      ],
    },
    {
      title: "2. What data we process",
      paragraphs: [
        "Account data (email, name, password stored only as a hash), the financial data you enter (accounts, transactions, budgets, goals, lists), uploaded documents (receipt photos, PDFs, statements) and the content read from them, and minimal technical data (security logs, the IP address used to limit abuse).",
      ],
    },
    {
      title: "3. Why and on what legal basis",
      paragraphs: [
        "Providing the service you requested (performance of the contract); security and abuse prevention (legitimate interest); legal obligations; analysis of visits to the public pages, only with your consent (analytics cookies).",
      ],
    },
    {
      title: "4. External AI services (optional)",
      paragraphs: [
        "Reading receipts with an external AI model, interpreting free-form questions in “Ask FINET” and other AI features happen ONLY with your separate consent for each, which you can withdraw at any time from your Profile. Only the data strictly necessary for that feature, described next to the consent, is sent to the model; without consent, nothing is sent.",
      ],
    },
    {
      title: "5. Who we share it with",
      paragraphs: [
        "Infrastructure providers (hosting, database, network protection, transactional email) and, only with your consent, the AI model provider. The administrators of the service do not see your financial data.",
      ],
    },
    {
      title: "6. How long we keep the data",
      paragraphs: [
        "For as long as your account is active. Receipt photos have a limited retention period after which they are deleted; when you delete your account we remove your personal data, and backup copies expire after the backup period.",
      ],
    },
    {
      title: "7. Your rights",
      paragraphs: [
        "Access, rectification, erasure, restriction, portability (export from the app), objection and withdrawal of consent. Account deletion and data export are done directly from your Profile. You have the right to lodge a complaint with ANSPDCP (dataprotection.ro).",
      ],
    },
    {
      title: "8. Cookies",
      paragraphs: [
        "We use strictly necessary cookies (session, theme, site language, your cookie choice). Analytics cookies are enabled only if you accept them in the banner on the public pages; you can decline them with no effect on the service.",
      ],
    },
  ];
}
