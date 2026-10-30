import { expect } from "@playwright/test";

import { MODE, login, loginOk, password, userEmail, test } from "./fixtures";

/**
 * GDPR și statistici (Faza 9, F9-B, ADR 0021; proiectul `gdpr`). Același server de dezvoltare și
 * aceeași bază ca `auth`; utilizatorii `gdpr` (exportul), `gdpr2` (ștergerea contului: după test
 * contul NU mai există) și `main` (primul utilizator creat = administratorul platformei, pentru
 * „Statistici”).
 *
 * Acceptarea Fazei 9: „E2E pentru exportul și ștergerea contului”; „pagina «Statistici» afișează
 * datele reale din Faza 2, fără nicio informație financiară”.
 */

test.describe.configure({ mode: "serial" });

test("exportul: arhiva ZIP se descarcă din Setări → Datele mele", async ({ page }) => {
  await loginOk(page, userEmail("gdpr"), password());
  await page.goto("/settings/privacy");
  await expect(page.getByRole("heading", { name: "Datele mele" })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("gdpr-export").click(),
  ]);
  expect(download.suggestedFilename()).toBe("finet-export.zip");
  const path = await download.path();
  expect(path).toBeTruthy();
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(path!);
  // Semnătura ZIP (antet local) și sfârșitul directorului central.
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  const text = bytes.toString("latin1");
  expect(text).toContain("profil.json");
  expect(text).toContain("README.txt");
  // Fără hash-ul parolei.
  expect(text).not.toContain("$argon2");
});

test("ștergerea contului: previzualizare, parola greșită refuzată, apoi ștergerea și login-ul imposibil", async ({
  page,
}) => {
  const email = userEmail("gdpr2");
  await loginOk(page, email, password());
  await page.goto("/settings/privacy");
  const box = page.getByTestId("delete-account");
  await expect(box).toBeVisible();
  await expect(page.getByTestId("deleted-households")).toContainText("Gospodăria mea");

  // Fără „ȘTERGE” exact: mesaj, nimic trimis.
  await page.getByLabel("Parola curentă").fill(password());
  await page.getByLabel("Scrie ȘTERGE ca să confirmi").fill("sterge");
  await page.getByTestId("delete-account-submit").click();
  await expect(page.getByText("Scrie exact ȘTERGE")).toBeVisible();

  // Parola greșită: refuzată de server.
  await page.getByLabel("Parola curentă").fill("parola-gresita-123");
  await page.getByLabel("Scrie ȘTERGE ca să confirmi").fill("ȘTERGE");
  await page.getByTestId("delete-account-submit").click();
  await expect(page.getByText("Parola nu e corectă.")).toBeVisible();

  await page.getByLabel("Parola curentă").fill(password());
  await page.getByTestId("delete-account-submit").click();
  await expect(page).toHaveURL(/\/login$/);

  // Contul nu mai există: login-ul eșuează (mesaj uniform), iar paginile cer din nou login.
  await login(page, email, password());
  await expect(page).not.toHaveURL(/\/dashboard$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("Statistici: administratorul vede datele agregate, fără sume; alt utilizator primește 404", async ({
  page,
  browser,
  baseURL,
}) => {
  // Administratorul platformei e primul utilizator creat (`e2e-main-personal`, CI).
  test.skip(MODE !== "personal", "administratorul platformei e utilizatorul din modul personal");
  await loginOk(page, userEmail("main"), password());
  await page.goto("/settings/statistics");
  await expect(page.getByTestId("stats-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Utilizatori activi" })).toBeVisible();
  const text = (await page.getByTestId("stats-page").innerText()).replace(/\s+/g, " ");
  // Nicio descriere de tranzacție sau email în pagină (6.5).
  expect(text).not.toMatch(/@finet\.test/);

  const other = await browser.newContext({ baseURL });
  const p2 = await other.newPage();
  await loginOk(p2, userEmail("gdpr"), password());
  const response = await p2.goto("/settings/statistics");
  expect(response?.status()).toBe(404);
  await other.close();
});
