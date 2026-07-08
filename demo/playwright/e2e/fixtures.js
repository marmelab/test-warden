// Custom fixture module — the common pattern where specs do NOT import
// @playwright/test directly (this is what the nudge's testDir check covers).
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  heading: async ({ page }, use) => {
    await page.goto("data:text/html,<h1>todo</h1>");
    await use(page.locator("h1"));
  },
});
export { expect };
