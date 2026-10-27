import { expect, test } from "@playwright/test";

test("pagina principală duce la login, care afișează logo-ul FINET", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.getByRole("img", { name: "FINET" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Autentificare" })).toBeVisible();
});
