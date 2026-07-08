import { test, expect } from "./fixtures.js";

test("shows the heading", async ({ heading }) => {
  await expect(heading).toHaveText("todo");
});

test("heading is visible", async ({ heading }) => {
  await expect(heading).toBeVisible();
});
