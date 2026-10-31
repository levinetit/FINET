import type { SiteMessages } from "./en-site";

/**
 * Teksty STRON PUBLICZNYCH serwisu `saas` po polsku (Faza 13, ADR 0033). Robocze tłumaczenie tekstu
 * angielskiego; kształt narzuca typ `SiteMessages`, a test sprawdza, że nie brakuje żadnego klucza.
 * Wersją wzorcową pozostaje rumuńska.
 */
export const plSite: SiteMessages = {
  nav: {
    pricing: "Cennik",
    terms: "Regulamin",
    privacy: "Prywatność",
    support: "Pomoc",
    login: "Zaloguj się",
    register: "Utwórz konto",
    language: "Język",
    skip: "Przejdź do treści",
  },
  landing: {
    title: "FINET: Twoje finanse i finanse Twojej rodziny w jednym miejscu",
    lead: "Śledź konta, wydatki i budżety, skanuj paragony i sprawdzaj, na co idą pieniądze.",
    features: [
      "Paragony odczytywane ze zdjęcia lub pliku PDF, z Twoją weryfikacją przed zapisaniem",
      "Budżety, cele i raporty według miesiąca, kategorii i sprzedawcy",
      "Rodzina: konta wspólne i osobiste, salda i rozliczenia",
      "Wyciągi bankowe, listy zakupów i ceny produktów",
      "Eksport do CSV, Excela i PDF oraz eksport dla Twojego księgowego",
      "Twoje dane pod Twoją kontrolą: eksportuj i usuwaj bezpośrednio w aplikacji",
    ],
    cta: "Utwórz konto",
    secondary: "Masz już konto? Zaloguj się",
  },
  pricing: {
    title: "Cennik",
    body: "Plany i ceny zostaną tu opublikowane w momencie ich uruchomienia. Do tego czasu usługa nie ma jeszcze planów płatnych.",
  },
  support: {
    title: "Pomoc",
    lead: "Krótkie odpowiedzi na temat korzystania z FINET. Jeśli nie znajdziesz tego, czego szukasz, napisz do nas.",
    sections: [
      {
        id: "inceput",
        title: "Jak zacząć?",
        body: "Załóż konto za pomocą adresu e-mail, a potem dodaj swoje konta (gotówka, bank, karta) i pierwsze transakcje. Każde nowe konto otrzymuje osobiste gospodarstwo domowe, które możesz później rozszerzyć.",
      },
      {
        id: "bonuri",
        title: "Paragony",
        body: "Prześlij zdjęcie lub plik PDF paragonu; FINET proponuje odczytane dane, a Ty sprawdzasz je i poprawiasz przed zapisaniem. Nic nie jest zapisywane bez Twojego potwierdzenia.",
      },
      {
        id: "familie",
        title: "Rodzina i gospodarstwa domowe",
        body: "Możesz zapraszać członków do gospodarstwa domowego, z kontami wspólnymi i osobistymi. Każdy widzi tylko to, na co pozwala jego rola.",
      },
      {
        id: "export",
        title: "Eksport i raporty",
        body: "Eksportuj transakcje do CSV, Excela lub PDF i wygeneruj eksport dla księgowego. Raporty według miesiąca, kategorii i sprzedawcy są w aplikacji.",
      },
      {
        id: "date",
        title: "Twoje dane",
        body: "Możesz pobrać wszystkie swoje dane i usunąć konto bezpośrednio w Ustawieniach, w sekcji prywatności. Szczegóły znajdziesz w polityce prywatności.",
      },
      {
        id: "parola",
        title: "Zapomniałem hasła",
        body: "Na stronie logowania skorzystaj z opcji resetowania hasła lub z linku do logowania wysłanego e-mailem, jeśli usługa taką możliwość oferuje.",
      },
    ],
    contactTitle: "Kontakt",
    contactLead: "W razie pytań lub problemów napisz do nas na adres",
  },
  terms: { title: "Regulamin" },
  privacy: { title: "Polityka prywatności" },
  draft: {
    title: "Tekst w trakcie weryfikacji",
    body: "To roboczy projekt, niezweryfikowany prawnie. Nie wywołuje skutków, dopóki operator go nie zweryfikuje i nie opublikuje. Wersja rumuńska jest tekstem wzorcowym.",
    incomplete: "Dane firmy prowadzącej usługę nie zostały jeszcze uzupełnione.",
    translationNote:
      "Tekst prawny jest wyświetlany po angielsku (tłumaczenie robocze); wersja rumuńska jest tekstem wzorcowym.",
  },
  footer: {
    operator: "Operator",
    taxId: "Numer identyfikacji podatkowej (CUI)",
    registration: "Rejestr handlowy",
    address: "Adres",
    contact: "Kontakt",
    missing: "do uzupełnienia",
    consumer: "Spory konsumenckie",
    anpcSal: "ANPC SAL",
    sol: "Europejska platforma ODR do internetowego rozstrzygania sporów",
  },
  consent: {
    title: "Pliki cookie",
    body: "Używamy wyłącznie niezbędnych plików cookie. Za Twoją zgodą używamy także analitycznych plików cookie, aby zrozumieć, jak korzysta się z serwisu. Możesz odmówić bez wpływu na działanie usługi.",
    accept: "Zaakceptuj analitykę",
    reject: "Odrzuć",
    region: "Twój wybór dotyczący plików cookie",
  },
};
