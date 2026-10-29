#!/usr/bin/env node
// Extrase bancare SINTETICE pentru parserele Fazei 7 (F7-A; ADR 0018).
//
//   node scripts/make-statement-fixtures.mjs [director]   # implicit fixtures/statements
//
// Pentru fiecare bancă cu parser (BT, BRD, Raiffeisen, Revolut) scrie `<bancă>/items.json`
// (elementele de text poziționale, exact forma pe care o produce extracția PDF din worker:
// `{ p, x, y, w, s }`) și `<bancă>/expected.json` (adevărul: solduri, rânduri, avertismente).
//
// STRUCTURA reproduce extrasele reale (antete, coloane, formate de sumă și dată, sume aliniate la
// dreapta, valori de sold pe un rând vecin etichetei, descrieri pe mai multe rânduri, antete
// repetate pe fiecare pagină, rânduri care continuă pe pagina următoare, secțiunea de tranzacții
// în așteptare peste o pagină, encodarea defectuoasă a fontului Raiffeisen, schimbul valutar
// Revolut). CONȚINUTUL e inventat: titulari, IBAN-uri, referințe, ID-uri, adrese, comercianți
// locali și sume nu provin din niciun extras real (doar lanțuri mari: Kaufland, Lidl, Netflix…).
// Determinist: aceeași ieșire la fiecare rulare (testul o compară cu fișierele din repo).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Utilitare
// ---------------------------------------------------------------------------------------------

/** Lățimea aproximativă a unui text Helvetica 8 pt (suficientă pentru centrul coloanelor). */
const width = (s) => Math.round(s.length * 4.4 * 100) / 100;

function group3(digits, sep) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
/** `1,234.56` */
export function fmtCommaDot(minor) {
  const v = BigInt(minor);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${group3((abs / 100n).toString(), ",")}.${(abs % 100n).toString().padStart(2, "0")}`;
}
/** `1.234,56` */
export function fmtDotComma(minor) {
  const v = BigInt(minor);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}${group3((abs / 100n).toString(), ".")},${(abs % 100n).toString().padStart(2, "0")}`;
}

class Page {
  constructor(doc, p) {
    this.doc = doc;
    this.p = p;
    this.y = 800;
  }
  /** Un fragment la x (stânga) pe rândul curent, cu deviație verticală opțională. */
  at(x, s, dy = 0) {
    this.doc.items.push({ p: this.p, x, y: Math.round((this.y + dy) * 100) / 100, w: width(s), s });
    return this;
  }
  /** Un fragment aliniat la dreapta la `right`. */
  right(right, s, dy = 0) {
    return this.at(Math.round((right - width(s)) * 100) / 100, s, dy);
  }
  nl(step = 11) {
    this.y -= step;
    return this;
  }
}

class Doc {
  constructor() {
    this.items = [];
    this.pages = 0;
  }
  page() {
    this.pages += 1;
    return new Page(this, this.pages);
  }
}

const sum = (list, dir) =>
  list.filter((t) => t.dir === dir).reduce((a, t) => a + BigInt(t.amount), 0n);

// ---------------------------------------------------------------------------------------------
// Banca Transilvania: extrase zilnice concatenate
// ---------------------------------------------------------------------------------------------

function bt() {
  const doc = new Doc();
  const IBAN = "RO66BTRLRONCRT0X1Y2Z3W01";
  const days = [
    {
      day: "03/11/2026",
      iso: "2026-11-03",
      no: 41,
      txs: [
        {
          dir: "credit",
          amount: 450000,
          lines: ["Incasare OP - canal electronic", "Salariu noiembrie; EXEMPLU SOFT SRL;"],
          ref: "REF: TQX7A1",
        },
        {
          dir: "debit",
          amount: 8714,
          lines: [
            "Plata la POS non-BT cu card VISA",
            "EPOS 02/11/2026 TID:T0A1 KAUFLAND RO valoare",
            "tranzactie: 87.14 RON",
          ],
          ref: "REF: TQX7A2",
        },
        {
          dir: "debit",
          amount: 86,
          lines: [
            "Round Up",
            "EPOS 02/11/2026 TID:T0A1 KAUFLAND RO valoare",
            "tranzactie: 87.14 RON",
          ],
          ref: "REF: TQX7A2",
        },
      ],
      // Valoarea `SOLD FINAL ZI` pe un rând separat, deasupra etichetei (ca în extrasele reale).
      splitDayBalance: true,
    },
    {
      day: "04/11/2026",
      iso: "2026-11-04",
      no: 42,
      txs: [
        {
          dir: "debit",
          amount: 1500,
          lines: [
            "Plata la POS non-BT cu card VISA",
            "EPOS 03/11/2026 TID:T0B2 CAFENEA EXEMPLU valoare",
            "tranzactie: 15.00 RON",
          ],
          ref: "REF: TQX7B1",
        },
        // Două tranzacții identice în aceeași zi (indicele de apariție le separă la deduplicare).
        {
          dir: "debit",
          amount: 1500,
          lines: [
            "Plata la POS non-BT cu card VISA",
            "EPOS 03/11/2026 TID:T0B2 CAFENEA EXEMPLU valoare",
            "tranzactie: 15.00 RON",
          ],
          ref: "REF: TQX7B1",
        },
        {
          dir: "debit",
          amount: 70000,
          lines: [
            "Retragere de numerar de la ATM BT",
            "ATM 04/11/2026 TID A0X1 STR. EXEMPLULUI NR. 1",
          ],
          ref: "REF: TQX7B3",
        },
        {
          dir: "debit",
          amount: 5499,
          lines: [
            "Plata la POS non-BT cu card VISA",
            "EPOS 03/11/2026 TID:T0B4 NETFLIX.COM valoare",
            "tranzactie: 54.99 RON",
          ],
          ref: "REF: TQX7B4",
        },
        {
          dir: "credit",
          amount: 2500,
          lines: ["Transfer intern", "Rambursare cina; ION TEST;"],
          ref: "REF: TQX7B5",
        },
      ],
      // Extrasul continuă pe pagina următoare după al treilea rând (antete repetate).
      breakAfter: 3,
    },
    {
      day: "05/11/2026",
      iso: "2026-11-05",
      no: 43,
      txs: [
        {
          dir: "debit",
          amount: 23456,
          lines: ["Plata OP inter - canal electronic", "Factura energie; FURNIZOR EXEMPLU SA;"],
          ref: "REF: TQX7C1",
        },
      ],
      // Tranzacții în așteptare (SUME BLOCATE), întinse peste o pagină.
      pending: [1290, 4410, 999],
      pendingBreakAfter: 2,
    },
  ];

  const chrome = (pg) => {
    pg.at(483, "BANCA TRANSILVANIA").nl();
    pg.at(531, "Info clienti:").nl();
    pg.at(516, "Solicitant: Online").nl();
    pg.at(481, "Tiparit: 2026-11-06 07:15:00").nl();
    pg.at(20, "EXEMPLU ANA").at(497, "Client: 7700001").nl();
    pg.at(22, "Fondurile pe care le aveti la Banca Transilvania sunt garantate de Fondul de").nl();
  };
  const footer = (pg, n, of) => {
    pg.y = 60;
    pg.at(26, "BANCA TRANSILVANIA S.A.").at(142, "Capitalul social: 1.000.000 lei (RON)").nl();
    pg.at(558, `${n} /`).at(569, String(of));
  };
  const header = (pg) => {
    pg.at(22, "Data").at(89, "Descriere").at(451, "Debit").at(545, "Credit").nl(13);
  };
  const DEBIT_R = 470;
  const CREDIT_R = 572;
  const BAL_R = 560;

  let balance = 312045n;
  const opening = balance;
  const expectedLines = [];
  let pendingTotal = 0;
  for (const d of days) {
    let pg = doc.page();
    chrome(pg);
    pg.at(22, "EXTRAS CONT").at(249, `Numarul: ${d.no}`).at(503, `din ${d.day}`).nl();
    pg.at(22, "CONT 990RONCRT0X1Y2Z3W01").at(261, "Valuta").at(484, "Cont de disponibil").nl();
    pg.at(265, "RON").at(370, `Cod IBAN: ${IBAN}`).nl(13);
    header(pg);
    pg.at(89, "SOLD ANTERIOR").right(BAL_R, fmtCommaDot(balance)).nl();
    d.txs.forEach((t, idx) => {
      if (d.breakAfter !== undefined && idx === d.breakAfter) {
        footer(pg, 1, 2);
        pg = doc.page();
        chrome(pg);
        pg.nl(6);
        header(pg);
      }
      const amt = fmtCommaDot(t.amount);
      pg.at(90, t.lines[0])
        .right(t.dir === "debit" ? DEBIT_R : CREDIT_R, amt, 1.2)
        .nl();
      if (idx === 0) pg.at(28, d.day).nl();
      for (const l of t.lines.slice(1)) pg.at(90, l).nl();
      pg.at(90, t.ref).nl();
      balance += t.dir === "credit" ? BigInt(t.amount) : -BigInt(t.amount);
      expectedLines.push({
        occurredOn: d.iso,
        direction: t.dir,
        amountMinor: String(t.amount),
        reference: t.ref.slice(5),
      });
    });
    pg.at(28, d.day)
      .at(89, "RULAJ ZI")
      .right(DEBIT_R, fmtCommaDot(sum(d.txs, "debit")))
      .right(CREDIT_R, fmtCommaDot(sum(d.txs, "credit")))
      .nl();
    if (d.splitDayBalance) {
      pg.right(BAL_R, fmtCommaDot(balance), 0).nl(4);
      pg.at(89, "SOLD FINAL ZI").nl();
    } else {
      pg.at(89, "SOLD FINAL ZI").right(BAL_R, fmtCommaDot(balance)).nl();
    }
    pg.at(28, d.day)
      .at(89, "RULAJ TOTAL CONT")
      .right(DEBIT_R, fmtCommaDot(sum(d.txs, "debit")))
      .right(CREDIT_R, fmtCommaDot(sum(d.txs, "credit")))
      .nl();
    pg.at(89, "SOLD FINAL CONT").right(BAL_R, fmtCommaDot(balance)).nl();
    if (d.pending) {
      pg.at(258, "SUME BLOCATE").nl();
      pg.at(22, "La data curenta")
        .at(87, "pe contul")
        .at(126, IBAN)
        .at(264, "aveti urmatoarele sume blocate:")
        .nl();
      d.pending.forEach((p, idx) => {
        if (idx === d.pendingBreakAfter) {
          footer(pg, 1, 2);
          pg = doc.page();
          chrome(pg);
        }
        pg.at(58, "-")
          .at(62, `${fmtCommaDot(p)} RON`)
          .at(105, "aferenta tranzactiei")
          .at(175, `EPOS 05/11/2026 TID:T0P${idx} LIDL DISCOUNT`)
          .nl();
        pg.at(22, `valoare tranzactie: ${fmtCommaDot(p)} RON comision tranzactie 0.00 RON`).nl();
        pendingTotal++;
      });
    }
    pg.at(92, "TOTAL DISPONIBIL").right(BAL_R, fmtCommaDot(balance)).nl();
    pg.at(92, "Fonduri proprii").right(BAL_R, fmtCommaDot(balance)).nl();
    footer(pg, 1, 1);
  }
  return {
    items: doc.items,
    expected: {
      bank: "bt",
      currency: "RON",
      periodStart: days[0].iso,
      periodEnd: days[days.length - 1].iso,
      openingBalanceMinor: String(opening),
      closingBalanceMinor: String(balance),
      pendingCount: pendingTotal,
      ibanLast4: IBAN.slice(-4),
      balanceStatus: "ok",
      lines: expectedLines,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// BRD: extras lunar bilingv
// ---------------------------------------------------------------------------------------------

function brd() {
  const doc = new Doc();
  const IBAN = "RO09BRDE000SV11223344550";
  const txs = [
    {
      date: "02/10/2026",
      dir: "credit",
      amount: 315000,
      lines: [
        "Transfer credit-Inc. interb",
        "Automat",
        "OPTEST000000A1",
        "EXEMPLU SOFT SRL",
        "/ROC/Salariu octombrie",
      ],
    },
    {
      date: "05/10/2026",
      dir: "debit",
      amount: 4567,
      lines: [
        "Utilizare POS comerciant strain.",
        "Card/Terminale",
        "OP 7000001/10001",
        "Card nr....0001",
        "NETFLIX.COM Amsterdam NLD",
      ],
    },
    {
      date: "07/10/2026",
      dir: "debit",
      amount: 120000,
      lines: [
        "Transfer debit-Plata intrab.",
        "Mobile Omnichannel",
        "OPTEST000000A3",
        "Dl EXEMPLU ION",
        "Chirie octombrie",
      ],
      breakInside: 2,
    },
    {
      date: "07/10/2026",
      dir: "debit",
      amount: 300,
      lines: ["Comision operatiune", "Mobile Omnichannel", "OPTEST000000A3", "Tx.Instant"],
    },
    {
      date: "15/10/2026",
      dir: "debit",
      amount: 21890,
      lines: ["Plata asigurare", "Automat", "NC 2610150000000001", "AsigTestStd"],
    },
  ];
  const DEBIT_R = 420;
  const CREDIT_R = 512;
  const chrome = (pg, n, of) => {
    pg.at(487, `Pag. ${n} /`).at(535, String(of)).nl();
  };
  const header = (pg) => {
    pg.at(28, "Data oper.")
      .at(162, "Descriere operatiune")
      .at(368, "Debit")
      .at(460, "Credit")
      .at(531, "Data val.")
      .nl();
    pg.at(27, "Trans.Date").at(155, "Transaction description").at(528, "Value date").nl();
  };
  const footer = (pg) => {
    pg.y = 70;
    pg.at(26, "BRD-Groupe Societe Generale S.A. Turn BRD").at(295, "CAPITAL SOCIAL IN RON").nl();
  };
  let pg = doc.page();
  chrome(pg, 1, 2);
  pg.at(339, "Extras de cont / Statement").nl();
  pg.at(339, "De la / From").at(398, "01/10/2026").at(451, "La / To").at(493, "31/10/2026").nl();
  pg.at(26, "SWIFT").at(67, "BRDEROBU").nl();
  pg.at(26, "Titular / Account holder").at(149, "Dl EXEMPLU ION").nl();
  pg.at(26, "IBAN").at(77, IBAN).nl();
  pg.at(26, "Valuta / Currency").at(137, "RON").nl();
  header(pg);
  let balance = 4521n;
  const opening = balance;
  pg.at(152, "Sold initial / Start balance").right(515, fmtDotComma(balance)).nl();
  const expectedLines = [];
  for (const t of txs) {
    pg.at(22, t.date)
      .at(81, t.lines[0])
      .right(t.dir === "debit" ? DEBIT_R : CREDIT_R, fmtDotComma(t.amount), -0.8)
      .at(522, t.date)
      .nl();
    t.lines.slice(1).forEach((l, idx) => {
      if (t.breakInside !== undefined && idx === t.breakInside) {
        footer(pg);
        pg = doc.page();
        chrome(pg, 2, 2);
        header(pg);
      }
      pg.at(81, l).nl();
    });
    balance += t.dir === "credit" ? BigInt(t.amount) : -BigInt(t.amount);
    const [y, m, d] = [t.date.slice(6), t.date.slice(3, 5), t.date.slice(0, 2)];
    expectedLines.push({
      occurredOn: `${y}-${m}-${d}`,
      direction: t.dir,
      amountMinor: String(t.amount),
      reference: t.lines[2],
    });
  }
  pg.at(81, "Total debit / Total credit")
    .right(DEBIT_R - 10, fmtDotComma(sum(txs, "debit")))
    .right(CREDIT_R - 20, fmtDotComma(sum(txs, "credit")))
    .nl();
  pg.at(81, "Sold final / End balance").right(515, fmtDotComma(balance)).nl();
  footer(pg);
  return {
    items: doc.items,
    expected: {
      bank: "brd",
      currency: "RON",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      openingBalanceMinor: String(opening),
      closingBalanceMinor: String(balance),
      pendingCount: 0,
      ibanLast4: IBAN.slice(-4),
      balanceStatus: "ok",
      lines: expectedLines,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Raiffeisen: font cu encodare defectuoasă (`\`` = ă, `]` = ț, `[` = ș)
// ---------------------------------------------------------------------------------------------

function raiffeisen() {
  const doc = new Doc();
  const IBAN = "RO30 RZBR 0000 0600 7777 1234";
  const txs = [
    {
      d: "02.11.2026",
      dir: "debit",
      amount: 2475,
      lines: ["Schimb valutar RON/EUR", "Rata schimb = 4.9750", "EXEMPLU ANA"],
    },
    { d: "02.11.2026", dir: "credit", amount: 50000, lines: ["OPIB/1", "ION TEST", "Restituire"] },
    {
      d: "06.11.2026",
      dir: "debit",
      amount: 3999,
      lines: [
        "WWW.SPOTIFY.COM STOCKHOLM",
        "Card nr. XXXX XXXX XXXX 0002",
        "Data utiliz`rii cardului 05/11/2026",
      ],
    },
    {
      d: "10.11.2026",
      dir: "debit",
      amount: 12000,
      lines: ["OPIB/1", "EXEMPLU ANA", "Transfer intre conturile proprii"],
      newPage: true,
    },
  ];
  const DEBIT_R = 455;
  const CREDIT_R = 555;
  const header = (pg) => {
    pg.at(28, "Dat`")
      .at(84, "Data")
      .at(122, "Descrierea tranzac]iei")
      .at(406, "Sum` debit")
      .at(504, "Sum` credit")
      .nl();
    pg.at(13, "înregistrare").at(71, "tranzac]iei").nl();
  };
  const footer = (pg, n, of) => {
    pg.y = 80;
    pg.at(
      12,
      "Prezentul extras are valoare de original fiind valabil fara semnatura si stampila",
    ).nl();
    pg.at(12, "Raiffeisen Bank S.A. · Bucure[ti").nl();
    pg.at(501, "Pagina").at(532, `${n}/`).at(540, String(of));
  };
  let pg = doc.page();
  pg.at(12, "Extras de cont").nl();
  pg.at(12, "Dat` extras: 30.11.2026 / Num`r extras: 11").nl();
  pg.at(12, "Perioada: de la 01.11.2026 la 30.11.2026").nl();
  pg.at(284, "Cod BIC Raiffeisen Bank:").at(517, "RZBRROBU").nl();
  pg.at(12, "ANA").at(40, "EXEMPLU").nl();
  pg.at(284, "Cod IBAN:").at(427, IBAN).nl();
  pg.at(284, "Valuta:").at(545, "LEI").nl();
  let balance = 98765n;
  const opening = balance;
  const debit = sum(txs, "debit");
  const credit = sum(txs, "credit");
  const closing = opening + credit - debit;
  pg.at(57, "Sold ini]ial")
    .at(188, "Rulaj debitor")
    .at(323, "Rulaj creditor")
    .at(467, "Sold final")
    .nl();
  pg.at(63, fmtCommaDot(opening))
    .at(197, fmtCommaDot(debit))
    .at(334, fmtCommaDot(credit))
    .at(479, fmtCommaDot(closing))
    .nl(14);
  header(pg);
  const expectedLines = [];
  txs.forEach((t, idx) => {
    if (t.newPage) {
      footer(pg, 1, 2);
      pg = doc.page();
      pg.at(12, "ANA").at(33, "EXEMPLU/Num`r client: 0000042/Nr. extras: 11").nl();
      header(pg);
    }
    pg.at(18, t.d)
      .at(73, t.d)
      .at(122, t.lines[0])
      .right(t.dir === "debit" ? DEBIT_R : CREDIT_R, fmtCommaDot(t.amount))
      .nl();
    for (const l of t.lines.slice(1)) pg.at(122, l).nl();
    balance += t.dir === "credit" ? BigInt(t.amount) : -BigInt(t.amount);
    const next = txs[idx + 1];
    if (!next || next.d !== t.d) pg.at(419, `Soldul zilei: ${t.d} ${fmtCommaDot(balance)}`).nl();
    const [d, m, y] = t.d.split(".");
    expectedLines.push({
      occurredOn: `${y}-${m}-${d}`,
      direction: t.dir,
      amountMinor: String(t.amount),
      reference: null,
      ...(t.lines[0].startsWith("Schimb valutar") ? { kind: "fx", fxCurrency: "EUR" } : {}),
    });
  });
  pg.at(492, `Sold final ${fmtCommaDot(balance)}`).nl();
  footer(pg, 2, 2);
  return {
    items: doc.items,
    expected: {
      bank: "raiffeisen",
      currency: "RON",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      openingBalanceMinor: String(opening),
      closingBalanceMinor: String(closing),
      pendingCount: 0,
      ibanLast4: IBAN.replace(/ /g, "").slice(-4),
      balanceStatus: "ok",
      lines: expectedLines,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Revolut: un cont pe monedă, schimb valutar
// ---------------------------------------------------------------------------------------------

function revolut() {
  const doc = new Doc();
  const IBAN = "RO77REVO0000123498765432";
  const txs = [
    {
      d: "3 nov. 2026",
      iso: "2026-11-03",
      dir: "credit",
      amount: 60000,
      desc: "Plată de la ION TEST",
      extra: [
        "Referință: Cadou",
        "ID tranzacție: 0a1b2c3d-1111-4aaa-8bbb-000000000001",
        IBAN,
        "De la: ION TEST, RO55TEST0000111122223333",
      ],
    },
    {
      d: "4 nov. 2026",
      iso: "2026-11-04",
      dir: "debit",
      amount: 4975,
      desc: "Schimbat în EUR",
      extra: ["ID tranzacție: 0a1b2c3d-1111-4aaa-8bbb-000000000002"],
      fx: "10,00€",
      fxMinor: 1000,
    },
    {
      d: "6 nov. 2026",
      iso: "2026-11-06",
      dir: "debit",
      amount: 3999,
      desc: "Spotify",
      extra: [
        "ID tranzacție: 0a1b2c3d-1111-4aaa-8bbb-000000000003",
        "Către: Spotify, Stockholm, SWE",
        "Card: 400000******0003",
      ],
    },
    {
      d: "6 nov. 2026",
      iso: "2026-11-06",
      dir: "debit",
      amount: 4999,
      desc: "Netflix",
      extra: [
        "ID tranzacție: 0a1b2c3d-1111-4aaa-8bbb-000000000004",
        "Către: Netflix.com, Amsterdam, NLD",
        "Card: 400000******0003",
      ],
    },
  ];
  const pg = doc.page();
  const opening = 12034n;
  const debit = sum(txs, "debit");
  const credit = sum(txs, "credit");
  const closing = opening + credit - debit;
  pg.at(452, "Extras RON").nl();
  pg.at(439, "Generat la data de 7 nov. 2026").nl();
  pg.at(388, "Revolut Bank UAB Vilnius Sucursala Bucuresti").nl();
  pg.at(40, "ANA EXEMPLU").at(353, "IBAN").at(376, IBAN).nl();
  pg.at(40, "Rezumatul soldului").nl();
  pg.at(43, "Produs")
    .at(253, "Sold inițial")
    .at(335, "Sume retrase")
    .at(417, "Sume adăugate")
    .at(521, "Sold final")
    .nl();
  for (const label of ["Cont (Contul Curent)", "Total"]) {
    pg.at(43, label)
      .at(253, `${fmtDotComma(opening)} RON`)
      .at(335, `${fmtDotComma(debit)} RON`)
      .at(417, `${fmtDotComma(credit)} RON`)
      .at(521, `${fmtDotComma(closing)} RON`)
      .nl();
  }
  pg.at(40, "Tranzacții din cont de la 1 noiembrie 2026 până la 7 noiembrie 2026").nl();
  pg.at(43, "Dată")
    .at(125, "Descriere")
    .at(335, "Sume retrase")
    .at(417, "Sume adăugate")
    .at(539, "Sold")
    .nl();
  let balance = opening;
  const expectedLines = [];
  for (const t of txs) {
    balance += t.dir === "credit" ? BigInt(t.amount) : -BigInt(t.amount);
    pg.at(43, t.d)
      .at(125, t.desc)
      .right(t.dir === "debit" ? 380 : 465, `${fmtDotComma(t.amount)} RON`)
      .right(575, `${fmtDotComma(balance)} RON`)
      .nl();
    for (const e of t.extra) pg.at(125, e).nl();
    if (t.fx) pg.at(335, t.fx).nl();
    expectedLines.push({
      occurredOn: t.iso,
      direction: t.dir,
      amountMinor: String(t.amount),
      reference: t.extra[t.extra.findIndex((e) => e.startsWith("ID tranzacție"))].slice(15),
      ...(t.fx ? { kind: "fx", fxCurrency: "EUR", fxAmountMinor: String(t.fxMinor) } : {}),
    });
  }
  pg.y = 120;
  pg.at(218, "Revolut Bank UAB este autorizată de Banca Națională a Lituaniei").nl();
  pg.at(40, "© 2026 Revolut Bank UAB").at(504, "Pagina").at(531, "1").at(538, "din").at(551, "1");
  return {
    items: doc.items,
    expected: {
      bank: "revolut",
      currency: "RON",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-07",
      openingBalanceMinor: String(opening),
      closingBalanceMinor: String(closing),
      pendingCount: 0,
      ibanLast4: IBAN.slice(-4),
      balanceStatus: "ok",
      lines: expectedLines,
    },
  };
}

/** Toate fixture-urile, în memorie (folosit de test pentru a verifica fișierele din repo). */
export function buildStatementFixtures() {
  return { bt: bt(), brd: brd(), raiffeisen: raiffeisen(), revolut: revolut() };
}

/** Serializarea stabilă (o linie per element, ca diff-urile să rămână lizibile). */
export function serializeItems(items) {
  return `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "fixtures/statements";
  for (const [bank, f] of Object.entries(buildStatementFixtures())) {
    mkdirSync(join(out, bank), { recursive: true });
    writeFileSync(join(out, bank, "items.json"), serializeItems(f.items));
    writeFileSync(join(out, bank, "expected.json"), `${JSON.stringify(f.expected, null, 2)}\n`);
    console.log(`${bank}: ${f.items.length} elemente, ${f.expected.lines.length} rânduri`);
  }
}
