import type { SiteMessages } from "./en-site";

/**
 * Texte der ÖFFENTLICHEN SEITEN der `saas`-Website auf Deutsch (Phase 13, ADR 0033). Arbeitsübersetzung
 * des englischen Textes; die Form gibt der Typ `SiteMessages` vor, ein Test prüft, dass kein Schlüssel
 * fehlt. Rumänisch bleibt die Referenzfassung.
 */
export const deSite: SiteMessages = {
  nav: {
    pricing: "Preise",
    terms: "Bedingungen",
    privacy: "Datenschutz",
    support: "Support",
    login: "Anmelden",
    register: "Konto erstellen",
    language: "Sprache",
    skip: "Zum Inhalt springen",
  },
  landing: {
    title: "FINET: Ihre Finanzen und die Ihrer Familie an einem Ort",
    lead: "Behalten Sie Konten, Ausgaben und Budgets im Blick, scannen Sie Belege und sehen Sie, wohin das Geld fließt.",
    features: [
      "Belege werden aus einem Foto oder PDF gelesen, mit Ihrer Prüfung vor dem Speichern",
      "Budgets, Ziele und Berichte nach Monat, Kategorie und Händler",
      "Familie: gemeinsame und persönliche Konten, Salden und Ausgleichszahlungen",
      "Kontoauszüge, Einkaufslisten und Preise pro Produkt",
      "Export als CSV, Excel und PDF sowie ein Export für Ihre Steuerberatung",
      "Ihre Daten unter Ihrer Kontrolle: direkt in der App exportieren und löschen",
    ],
    cta: "Konto erstellen",
    secondary: "Sie haben schon ein Konto? Anmelden",
  },
  pricing: {
    title: "Preise",
    body: "Tarife und Preise werden hier veröffentlicht, sobald sie starten. Bis dahin gibt es noch keine kostenpflichtigen Tarife.",
  },
  support: {
    title: "Support",
    lead: "Kurze Antworten zur Nutzung von FINET. Wenn Sie nicht finden, was Sie suchen, schreiben Sie uns.",
    sections: [
      {
        id: "inceput",
        title: "Wie fange ich an?",
        body: "Erstellen Sie Ihr Konto mit Ihrer E-Mail-Adresse und fügen Sie dann Ihre Konten (Bargeld, Bank, Karte) und Ihre ersten Buchungen hinzu. Jedes neue Konto erhält einen persönlichen Haushalt, den Sie später erweitern können.",
      },
      {
        id: "bonuri",
        title: "Belege",
        body: "Laden Sie ein Foto oder PDF eines Belegs hoch; FINET schlägt die gelesenen Daten vor, und Sie prüfen und korrigieren sie vor dem Speichern. Ohne Ihre Bestätigung wird nichts gespeichert.",
      },
      {
        id: "familie",
        title: "Familie und Haushalte",
        body: "Sie können Mitglieder in einen Haushalt einladen, mit gemeinsamen und persönlichen Konten. Jede Person sieht nur, was ihre Rolle erlaubt.",
      },
      {
        id: "export",
        title: "Export und Berichte",
        body: "Exportieren Sie Buchungen als CSV, Excel oder PDF und erstellen Sie einen Export für Ihre Steuerberatung. Berichte nach Monat, Kategorie und Händler finden Sie in der App.",
      },
      {
        id: "date",
        title: "Ihre Daten",
        body: "Sie können alle Ihre Daten herunterladen und Ihr Konto direkt in den Einstellungen im Bereich Datenschutz löschen. Einzelheiten stehen in der Datenschutzerklärung.",
      },
      {
        id: "parola",
        title: "Ich habe mein Passwort vergessen",
        body: "Nutzen Sie auf der Anmeldeseite die Option zum Zurücksetzen des Passworts oder den per E-Mail gesendeten Anmeldelink, sofern der Dienst dies anbietet.",
      },
    ],
    contactTitle: "Kontakt",
    contactLead: "Bei Fragen oder Problemen schreiben Sie uns an",
  },
  terms: { title: "Allgemeine Geschäftsbedingungen" },
  privacy: { title: "Datenschutzerklärung" },
  draft: {
    title: "Text in Prüfung",
    body: "Dies ist ein Arbeitsentwurf ohne rechtliche Prüfung. Er hat keine Wirkung, bis der Betreiber ihn geprüft und veröffentlicht hat. Die rumänische Fassung ist der maßgebliche Text.",
    incomplete: "Die Angaben zum Unternehmen, das den Dienst betreibt, sind noch nicht ausgefüllt.",
    translationNote:
      "Der rechtliche Text wird auf Englisch angezeigt (Arbeitsübersetzung); die rumänische Fassung ist der maßgebliche Text.",
  },
  footer: {
    operator: "Betreiber",
    taxId: "Steuernummer (CUI)",
    registration: "Handelsregister",
    address: "Adresse",
    contact: "Kontakt",
    missing: "noch auszufüllen",
    consumer: "Verbraucherstreitigkeiten",
    anpcSal: "ANPC SAL",
    sol: "EU-Plattform zur Online-Streitbeilegung (OS)",
  },
  consent: {
    title: "Cookies",
    body: "Wir verwenden ausschließlich notwendige Cookies. Mit Ihrer Einwilligung nutzen wir zusätzlich Analyse-Cookies, um zu verstehen, wie die Website genutzt wird. Sie können ablehnen, ohne dass der Dienst beeinträchtigt wird.",
    accept: "Analyse akzeptieren",
    reject: "Ablehnen",
    region: "Ihre Cookie-Auswahl",
  },
};
