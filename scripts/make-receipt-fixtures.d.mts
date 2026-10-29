// Tipuri pentru scripts/make-receipt-fixtures.mjs (folosite de evaluare și de teste).
export type FixtureLine = {
  name: string;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string;
  vatRate: string;
  type: "item" | "discount" | "deposit" | "bag" | "other";
  category: string | null;
};
export type FixtureVariant = {
  format: "jpeg" | "png" | "pdf";
  rotate?: number;
  noise?: boolean;
  blur?: number;
  quality?: number;
  crumple?: boolean;
  parts?: number;
  overlap?: number;
};
export type Fixture = {
  id: string;
  variant: FixtureVariant;
  merchantName: string;
  merchantTaxId: string;
  storeAddress: string;
  receiptNumber: string;
  date: string;
  paymentMethod: "cash" | "card";
  currency: "RON";
  total: string;
  vatTotal: string;
  lines: FixtureLine[];
};
export declare const FIXTURES: Fixture[];
export declare function renderFixture(
  fixture: Fixture,
): Promise<{ name: string; mime: "image/jpeg" | "image/png" | "application/pdf"; data: Buffer }[]>;
export declare function fontsAvailable(): Promise<boolean>;
