import { expect, test } from "@playwright/test";

test("pagina principală afișează logo-ul FINET", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.getByRole("img", { name: "FINET" })).toBeVisible();
});
