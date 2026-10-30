import type { ReportRules, RuleTerm } from "./rules";

/**
 * Rapoartele de SISTEM (Faza 10, F10-B; ADR 0023): definiții în date, inserate de migrația
 * `0018_report_definitions` (aceleași id-uri, nume, reguli și sfaturi; un test compară rândurile
 * din bază cu această constantă). Se schimbă DOAR printr-o migrație nouă (aplicația nu poate scrie
 * rânduri de sistem: politicile RLS cer `household_id` = gospodăria curentă). Versiunea constantei
 * crește la fiecare schimbare.
 *
 * Regulile sunt puncte de plecare, nu adevăruri: potrivirea se face pe NUMELE normalizat al
 * produsului, deci un nume neobișnuit poate scăpa sau poate intra în plus. Utilizatorul poate
 * copia orice raport de sistem într-unul propriu și îl poate ajusta (cu previzualizare). Sfaturile
 * sunt texte fixe, fără sume de economie.
 */
export const SYSTEM_REPORTS_VERSION = 1;

export type SystemReport = Readonly<{
  id: string;
  /** Cheie stabilă (teste, ancore UI); nu e stocată în bază. */
  key: string;
  name: string;
  description: string;
  rules: ReportRules;
  advice: string;
}>;

const t = (type: RuleTerm["type"], value: string): RuleTerm => ({ type, value });
const tokens = (...values: string[]): RuleTerm[] => values.map((v) => t("token", v));
const contains = (...values: string[]): RuleTerm[] => values.map((v) => t("contains", v));

const base = { v: 1, categoryIds: [], tagIds: [] } as const;

export const SYSTEM_REPORTS: readonly SystemReport[] = [
  {
    id: "a10b0000-0000-4000-8000-000000000001",
    key: "bags",
    name: "Pungi și sacoșe",
    description: "Pungile și sacoșele plătite la casă (nu și pungile de menaj sau de gunoi).",
    rules: {
      ...base,
      combine: "any",
      include: tokens("punga", "pungi", "sacosa", "sacose"),
      exclude: tokens("menaj", "gunoi", "congelare", "congelator", "frigider", "sandwich"),
      kinds: ["product", "bag", "other"],
    },
    advice:
      "Pungile și sacoșele de la casă se plătesc la fiecare cumpărătură. O sacoșă refolosibilă adusă de acasă elimină această cheltuială.",
  },
  {
    id: "a10b0000-0000-4000-8000-000000000002",
    key: "sgr",
    name: "Garanția SGR: plătită și recuperată",
    description:
      "Garanțiile SGR plătite pe bonuri (ambalaje returnabile) față de cele recuperate prin bonurile de retur.",
    rules: {
      ...base,
      combine: "any",
      include: [
        ...tokens("sgr", "garantie", "garantii", "deposit"),
        ...contains("ambalaj returnabil", "retur ambalaj"),
      ],
      exclude: [],
      kinds: ["deposit_sgr", "discount"],
    },
    advice:
      "Garanția SGR este de 0,50 lei pentru fiecare ambalaj returnabil și se recuperează doar dacă returnezi ambalajul și folosești bonul de retur. Diferența dintre plătit și recuperat arată garanțiile încă nerecuperate pe bonurile tale; returnările făcute la un automat pot să nu apară pe bonuri.",
  },
  {
    id: "a10b0000-0000-4000-8000-000000000003",
    key: "checkout",
    name: "Cumpărături de la casă",
    description: "Dulciuri, gumă de mestecat și batoane, cumpărate de obicei în ultimul moment.",
    rules: {
      ...base,
      combine: "any",
      include: tokens(
        "guma",
        "gume",
        "bomboane",
        "bomboana",
        "ciocolata",
        "baton",
        "batoane",
        "napolitana",
        "napolitane",
        "jeleuri",
        "dropsuri",
        "acadele",
        "lizoi",
        "drajeuri",
        "snickers",
        "twix",
        "bounty",
        "kitkat",
        "mentos",
        "orbit",
      ),
      exclude: [],
      kinds: ["product", "other"],
    },
    advice:
      "Produsele de la casă se cumpără adesea fără să fie pe lista de cumpărături. Compară totalul cu ce îți propuseseși să cumperi.",
  },
  {
    id: "a10b0000-0000-4000-8000-000000000004",
    key: "nonfood",
    name: "Nealimentare la supermarket",
    description: "Produse de igienă și de menaj cumpărate odată cu alimentele.",
    rules: {
      ...base,
      combine: "any",
      include: [
        ...tokens(
          "sampon",
          "balsam",
          "sapun",
          "deodorant",
          "detergent",
          "dezinfectant",
          "odorizant",
          "servetele",
          "burete",
          "prosop",
          "prosoape",
          "periuta",
          "lotiune",
          "absorbante",
          "tampoane",
        ),
        ...contains("hartie igienica", "pasta de dinti", "pasta dinti", "gel de dus", "gel dus"),
      ],
      exclude: [],
      kinds: ["product", "other"],
    },
    advice:
      "Compară prețul pe unitate între magazine, în secțiunea Prețuri, înainte să cumperi astfel de produse în cantități mari.",
  },
  {
    id: "a10b0000-0000-4000-8000-000000000005",
    key: "drinks",
    name: "Cafea și băuturi la bucată",
    description:
      "Cafea, sucuri, apă, bere și alte băuturi cumpărate la bucată (fără ambalajele mari de cafea).",
    rules: {
      ...base,
      combine: "any",
      include: [
        ...tokens(
          "cafea",
          "espresso",
          "cappuccino",
          "capuccino",
          "latte",
          "frappe",
          "ceai",
          "suc",
          "cola",
          "pepsi",
          "fanta",
          "sprite",
          "nestea",
          "bere",
          "energizant",
          "monster",
          "apa",
          "limonada",
        ),
        ...contains("red bull", "izotonic"),
      ],
      exclude: [
        ...tokens(
          "boabe",
          "macinata",
          "solubila",
          "instant",
          "capsule",
          "plicuri",
          "pliculete",
          "bax",
          "set",
          "multipack",
          "colonie",
          "gura",
          "oxigenata",
        ),
        ...contains("kg", "6x", "12x", "24x", "4x", "250g", "500g"),
      ],
      kinds: ["product", "other"],
    },
    advice:
      "Compară prețul pe litru al aceluiași produs în ambalaje diferite, în secțiunea Prețuri.",
  },
  {
    id: "a10b0000-0000-4000-8000-000000000006",
    key: "savings",
    name: "Economii din reduceri și carduri",
    description:
      "Reducerile, cupoanele și avantajele cardurilor de fidelitate scăzute pe bonuri (fără retururile SGR).",
    rules: {
      ...base,
      combine: "any",
      include: [],
      exclude: [...tokens("sgr", "garantie", "garantii"), ...contains("retur ambalaj")],
      kinds: ["discount"],
    },
    advice:
      "Totalul arată cât s-a scăzut efectiv din bonurile tale prin reduceri și carduri de fidelitate, așa cum apare pe bon.",
  },
];

export const SYSTEM_REPORT_IDS: ReadonlySet<string> = new Set(SYSTEM_REPORTS.map((r) => r.id));
