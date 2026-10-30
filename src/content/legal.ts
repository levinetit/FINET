/**
 * Textele juridice ale site-ului public (Faza 11, ADR 0027): CIORNE de lucru în română, scrise din
 * ceea ce face aplicația, NU consultanță juridică. Nu sunt valabile până nu le revizuiește un om
 * (`SITE_LEGAL_REVIEWED=1`): până atunci pagina afișează un banner vizibil și nu se indexează.
 * Datele firmei nu sunt scrise aici: se inserează din configurație (`config.site.company`).
 */
export type LegalSection = Readonly<{ title: string; paragraphs: readonly string[] }>;

export type CompanyView = Readonly<{
  name: string | null;
  taxId: string | null;
  registrationNo: string | null;
  address: string | null;
  email: string | null;
}>;

const MISSING = "[de completat]";
const or = (v: string | null) => v ?? MISSING;

export function termsSections(c: CompanyView): readonly LegalSection[] {
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

export function privacySections(c: CompanyView): readonly LegalSection[] {
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
        "Folosim cookie-uri strict necesare (sesiune, temă, alegerea ta privind cookie-urile). Cookie-urile de analytics se activează doar dacă le accepți în bannerul de pe paginile publice; le poți refuza fără efect asupra serviciului.",
      ],
    },
  ];
}
