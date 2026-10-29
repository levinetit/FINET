// Datele serverului AI FALS pentru E2E (F6-C, ADR 0015), funcții pure: lățimea unei poze JPEG și
// bonul determinist întors pentru ea. Stau în `scripts/` (nu în `e2e/`, exclus din contextul
// Docker), ca testul lor unitar (`scripts/e2e-ai-mock.test.ts`) să compileze și în `next build`.
// Serverul propriu-zis: `e2e/ai-mock-server.mjs`.

/** Lățimea unei imagini JPEG (markerul SOFn), fără biblioteci. */
export function jpegWidth(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return buf.readUInt16BE(i + 7);
    }
    i += 2 + len;
  }
  return null;
}

const line = (name, quantity, unitPrice, lineTotal) => ({
  name,
  quantity,
  unitPrice,
  lineTotal,
  vatRate: "11",
  type: "item",
});

const base = {
  storeAddress: null,
  paymentMethod: "card",
  currency: "RON",
  vatTotal: null,
};

export function receiptFor(width) {
  if (width === 801) {
    return {
      ...base,
      merchantName: "KAUFLAND ROMANIA SCS",
      merchantTaxId: "RO15991149",
      receiptNumber: "0777",
      date: "2026-10-20",
      total: "20.48",
      lines: [
        line("LAPTE ZUZU 1L", "2", "7.49", "14.98"),
        line("PAINE TOAST", "1", "5.50", "5.50"),
      ],
    };
  }
  if (width === 802) {
    return {
      ...base,
      merchantName: "LIDL DISCOUNT SRL",
      merchantTaxId: "RO22891860",
      receiptNumber: "0142",
      date: "2026-10-21",
      total: null,
      lines: [
        line("PAINE", "1", "3.00", "3.00"),
        line("LAPTE", "1", "7.50", "7.50"),
        line("OUA", "1", "12.00", "12.00"),
      ],
    };
  }
  if (width === 803) {
    return {
      ...base,
      merchantName: null,
      merchantTaxId: null,
      receiptNumber: null,
      date: null,
      total: "27.50",
      lines: [line("OUA", "1", "12.00", "12.00"), line("MERE", "1", "5.00", "5.00")],
    };
  }
  return {
    ...base,
    merchantName: "MEGA IMAGE SRL",
    merchantTaxId: "RO6719278",
    receiptNumber: String(width ?? 1),
    date: "2026-10-22",
    total: "9.99",
    lines: [line("APA PLATA 2L", "1", "9.99", "9.99")],
  };
}
