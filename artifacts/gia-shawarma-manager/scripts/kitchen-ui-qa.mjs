/**
 * Headless QA: /kitchen must show دجاج as 15 | kg, never "3 كيلو" in unit column.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.QA_BASE || "http://127.0.0.1:5173";
const OUT = "d:/gia-shawarma-manager-self-host/backups/gia-v3-kitchen-ui-qa.png";
const REPORT = "d:/gia-shawarma-manager-self-host/backups/gia-v3-kitchen-ui-qa.json";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const result = {
  ok: false,
  apiDisplayUnit: null,
  apiBaseUnit: null,
  apiKitchenQty: null,
  rowText: null,
  unitCell: null,
  qtyCell: null,
  has3KiloInUnitColumn: null,
  pageHas3KiloAnywhere: null,
  error: null,
  screenshot: OUT,
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);

  // Login form
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await page.locator('input[type="text"], input:not([type])').first().fill("admin");
    await password.fill("admin123");
    await page.getByRole("button", { name: /دخول|Login|Masuk/i }).click();
    await page.waitForTimeout(2000);
  }

  const api = await page.evaluate(async () => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    }).then((r) => r.json());
    const h = { Authorization: `Bearer ${login.token}` };
    const kit = await fetch("/api/v3/kitchen", { headers: h }).then((r) => r.json());
    const row = (kit.rows || []).find((r) => r.id === 122 || r.name === "دجاج");
    return row || null;
  });
  result.apiDisplayUnit = api?.displayUnit ?? null;
  result.apiBaseUnit = api?.baseUnit ?? null;
  result.apiKitchenQty = api?.kitchenQty ?? null;

  await page.goto(`${BASE}/kitchen`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  await page.waitForTimeout(1000);

  // Prefer id-based match via evaluating rendered table
  const tableScan = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tbody tr")].map((tr) => {
      const cells = [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim());
      return cells;
    });
    const dajaj = rows.find((c) => c[0]?.includes("دجاج") || c.some((t) => t.includes("دجاج")));
    return { rows: rows.slice(0, 5), dajaj, allText: document.body.innerText };
  });

  result.rowText = tableScan.dajaj;
  result.qtyCell = tableScan.dajaj?.[1] ?? null;
  result.unitCell = tableScan.dajaj?.[2] ?? null;
  result.has3KiloInUnitColumn = String(result.unitCell || "").includes("3") && String(result.unitCell || "").includes("كيلو");
  result.pageHas3KiloAnywhere = /3\s*كيلو/.test(tableScan.allText || "");

  const unitOk = String(result.unitCell || "").trim() === "kg";
  const qtyOk = String(result.qtyCell || "").includes("15");
  result.ok = Boolean(api?.displayUnit === "kg" && unitOk && qtyOk && !result.has3KiloInUnitColumn);

  await page.screenshot({ path: OUT, fullPage: true });
} catch (e) {
  result.error = String(e?.stack || e);
  try {
    await page.screenshot({ path: OUT, fullPage: true });
  } catch {
    /* */
  }
} finally {
  await browser.close();
}

fs.writeFileSync(REPORT, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
