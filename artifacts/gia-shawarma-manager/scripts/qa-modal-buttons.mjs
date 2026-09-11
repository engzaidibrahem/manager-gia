/**
 * Real-browser QA: warehouse-in / warehouse-to-kitchen Add buttons open a dialog.
 * Uses Playwright if available via npx.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const install = spawnSync(
      "npx",
      ["--yes", "playwright@1.49.1", "install", "chromium"],
      { stdio: "inherit", shell: true },
    );
    if (install.status !== 0) throw new Error("playwright install failed");
    return await import("playwright");
  }
}

const BASE = process.env.QA_BASE_URL || "http://127.0.0.1:5173";
const USER = process.env.QA_USER || "owner";
const PASS = process.env.QA_PASS || "owner123";

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // Already logged in?
  if (await page.locator("text=إدخال للمستودع").first().isVisible().catch(() => false)) return;
  const user = page.locator('input[type="text"], input[name="username"], input[autocomplete="username"]').first();
  const pass = page.locator('input[type="password"]').first();
  if (await user.isVisible().catch(() => false)) {
    await user.fill(USER);
    await pass.fill(PASS);
    await page.locator('button[type="submit"], button:has-text("دخول"), button:has-text("Login")').first().click();
    await page.waitForTimeout(1500);
  }
}

async function assertModalOpens(page, path, buttonText) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const btn = page.getByRole("button", { name: buttonText }).first();
  await btn.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  const visible = await dialog.isVisible();
  if (!visible) throw new Error(`Dialog not visible on ${path}`);
  console.log(`OK ${path}: modal opened after click "${buttonText}"`);
  // Close
  await page.keyboard.press("Escape").catch(() => {});
  const close = dialog.locator("button", { hasText: "×" }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await login(page);
    await assertModalOpens(page, "/warehouse-in", "+ إدخال للمستودع");
    await assertModalOpens(page, "/warehouse-out", "+ إخراج للمطبخ");
    await assertModalOpens(page, "/warehouse-to-kitchen", "+ إخراج للمطبخ");
    console.log("BROWSER_QA_PASS");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("BROWSER_QA_FAIL", e);
  process.exit(1);
});
