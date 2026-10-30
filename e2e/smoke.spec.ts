import { expect } from "@playwright/test";

import { MODE, test } from "./fixtures";

test("pagina principală duce la login (personal) sau arată prezentarea (saas); login-ul afișează logo-ul FINET", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  if (MODE === "saas") {
    // Faza 11: în `saas`, `/` e pagina publică de prezentare, cu legătură spre login.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("landing-register")).toBeVisible();
    await page.goto("/login");
  }
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.getByRole("img", { name: "FINET" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Autentificare" })).toBeVisible();
});
