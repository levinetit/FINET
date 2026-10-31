import type { SiteMessages } from "./en-site";

/**
 * Testi delle PAGINE PUBBLICHE del sito `saas` in italiano (Fase 13, ADR 0033). Traduzione di lavoro
 * del testo inglese; la forma è imposta dal tipo `SiteMessages` e un test verifica che non manchi
 * nessuna chiave. Il rumeno resta la versione di riferimento.
 */
export const itSite: SiteMessages = {
  nav: {
    pricing: "Prezzi",
    terms: "Termini",
    privacy: "Privacy",
    support: "Assistenza",
    login: "Accedi",
    register: "Crea account",
    language: "Lingua",
    skip: "Vai al contenuto",
  },
  landing: {
    title: "FINET: le tue finanze e quelle della tua famiglia, in un unico posto",
    lead: "Tieni sotto controllo conti, spese e budget, scansiona gli scontrini e scopri dove vanno i soldi.",
    features: [
      "Scontrini letti da una foto o da un PDF, con la tua verifica prima del salvataggio",
      "Budget, obiettivi e report per mese, categoria ed esercente",
      "Famiglia: conti condivisi e personali, saldi e rimborsi",
      "Estratti conto, liste della spesa e prezzi per prodotto",
      "Esportazione in CSV, Excel e PDF, più un'esportazione per il tuo commercialista",
      "I tuoi dati sotto il tuo controllo: esporta ed elimina direttamente dall'app",
    ],
    cta: "Crea account",
    secondary: "Hai già un account? Accedi",
  },
  pricing: {
    title: "Prezzi",
    body: "Piani e prezzi saranno pubblicati qui al momento del lancio. Fino ad allora il servizio non ha ancora piani a pagamento.",
  },
  support: {
    title: "Assistenza",
    lead: "Risposte brevi sull'uso di FINET. Se non trovi ciò che cerchi, scrivici.",
    sections: [
      {
        id: "inceput",
        title: "Come comincio?",
        body: "Crea il tuo account con la tua email, poi aggiungi i tuoi conti (contanti, banca, carta) e le prime transazioni. Ogni nuovo account riceve un nucleo familiare personale che potrai ampliare in seguito.",
      },
      {
        id: "bonuri",
        title: "Scontrini",
        body: "Carica una foto o un PDF di uno scontrino; FINET propone i dati letti e tu li controlli e li correggi prima di salvare. Nulla viene salvato senza la tua conferma.",
      },
      {
        id: "familie",
        title: "Famiglia e nuclei familiari",
        body: "Puoi invitare dei membri in un nucleo familiare, con conti condivisi e personali. Ognuno vede solo ciò che il suo ruolo consente.",
      },
      {
        id: "export",
        title: "Esportazione e report",
        body: "Esporta le transazioni in CSV, Excel o PDF e genera un'esportazione per il tuo commercialista. I report per mese, categoria ed esercente sono nell'app.",
      },
      {
        id: "date",
        title: "I tuoi dati",
        body: "Puoi scaricare tutti i tuoi dati ed eliminare il tuo account direttamente da Impostazioni, nella sezione privacy. I dettagli sono nell'informativa sulla privacy.",
      },
      {
        id: "parola",
        title: "Ho dimenticato la password",
        body: "Nella pagina di accesso usa l'opzione di reimpostazione della password o il link di accesso inviato via email, se il servizio lo offre.",
      },
    ],
    contactTitle: "Contatti",
    contactLead: "Per domande o problemi, scrivici a",
  },
  terms: { title: "Termini e condizioni" },
  privacy: { title: "Informativa sulla privacy" },
  draft: {
    title: "Testo in fase di revisione",
    body: "Questa è una bozza di lavoro, non rivista da un punto di vista legale. Non produce effetti finché non viene rivista e pubblicata dall'operatore. La versione rumena è il testo di riferimento.",
    incomplete: "I dati dell'azienda che gestisce il servizio non sono ancora stati compilati.",
    translationNote:
      "Il testo legale è mostrato in inglese (traduzione di lavoro); la versione rumena è il testo di riferimento.",
  },
  footer: {
    operator: "Operatore",
    taxId: "Codice fiscale (CUI)",
    registration: "Registro delle imprese",
    address: "Indirizzo",
    contact: "Contatti",
    missing: "da completare",
    consumer: "Controversie dei consumatori",
    anpcSal: "ANPC SAL",
    sol: "Piattaforma europea per la risoluzione online delle controversie (ODR)",
  },
  consent: {
    title: "Cookie",
    body: "Usiamo solo cookie strettamente necessari. Con il tuo consenso usiamo anche cookie di analisi per capire come viene usato il sito. Puoi rifiutare senza conseguenze per il servizio.",
    accept: "Accetta l'analisi",
    reject: "Rifiuta",
    region: "La tua scelta sui cookie",
  },
};
