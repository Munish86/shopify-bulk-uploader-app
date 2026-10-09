// Browser test: npm run test:browser (needs Chrome or Edge installed, and internet for Polaris from Shopify CDN).
// Set CHROME_PATH if the browser is somewhere else. Drives the page in Chrome: checks that Polaris fields show and send values, and that a run
// shows progress and results. Prints PASS / FAIL lines and saves screenshots.
import fs from "node:fs";
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
if (!executablePath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH.");
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const saved = () => page.evaluate(() => window.__saved);
const shot = (name) => page.screenshot({ path: path.join(here, ".out", `${name}.png`), fullPage: true });
// Polaris field by its label
const field = (tag, label) => page.locator(`${tag}[label="${label}"]`).first();
const valueOf = (tag, label) => field(tag, label).evaluate((el) => el.value);

await page.goto("file:///" + path.join(here, "index.html").replace(/\\/g, "/"));
await page.waitForFunction(() => customElements.get("s-select") && document.querySelector("s-section"), null, { timeout: 30000 });
await page.waitForTimeout(1500);
await shot("1-loaded");

// Sheet info loaded and auto-fill ran (nothing was mapped)
check("sheet banner shown", await page.getByText("products.xlsx: 4 rows, 10 columns").isVisible());
check("auto-fill set Title select", (await valueOf("s-select", "Title")) === "Product Title", await valueOf("s-select", "Title"));
check("auto-fill set Price select", (await valueOf("s-select", "Price")) === "Price");
check("auto-fill saved to server", (await saved())?.columns?.title === "Product Title");
check("metafield row from header", (await saved())?.metafields?.[0]?.key === "material");
const colour = page.locator('s-checkbox[label="Colour"]');
check("Colour option ticked", await colour.evaluate((el) => el.checked));

// Select: change Vendor to Tags through the real dropdown inside the component
const vendor = field("s-select", "Vendor / Supplier");
await vendor.locator("select").selectOption("Tags");
await page.waitForTimeout(700);
check("select change reaches the form", (await saved())?.columns?.vendor === "Tags", JSON.stringify((await saved())?.columns?.vendor));

// Checkbox
await page.locator('s-checkbox[label="Create products that are not in Shopify"]').locator("input").check();
await page.waitForTimeout(700);
check("checkbox change reaches the form", (await saved())?.match?.create_missing === true);

// Text field in the run section (local state) and number field
const only = field("s-text-field", "Only these products (product keys, comma separated)");
await only.locator("input").fill("SOFA-001");
await page.waitForTimeout(200);
check("text field keeps typed value", (await only.evaluate((el) => el.value)) === "SOFA-001");

// Switch the sheet to a Google Sheet link and type it
await page.getByText("Google Sheet link", { exact: true }).first().click();
await page.waitForTimeout(500);
await field("s-text-field", "Google Sheet link").locator("input").fill("https://docs.google.com/spreadsheets/d/abcdefghijklmnop/edit");
await page.waitForTimeout(700);
const sv = await saved();
check("segmented + text field reach the form", sv?.sheet?.source === "google" && sv?.sheet?.google_sheet?.includes("abcdefghijklmnop"), JSON.stringify(sv?.sheet));
await shot("2-edited");

// Checklist and run
check("checklist says ready", await page.getByText('Products found by SKU from "SKU"').isVisible());
await page.getByText("2 · Preview changes").click();
await page.waitForTimeout(800);
await shot("3-running");
const runCall = (await page.evaluate(() => window.__calls)).find((c) => c.url === "/app/api/jobs" && c.method === "POST");
check("run request sent with options", runCall?.body?.command === "plan" && runCall?.body?.only === "SOFA-001", JSON.stringify(runCall?.body));
await page.waitForSelector("text=Preview results", { timeout: 15000 });
await page.waitForTimeout(1000);
check("progress finished", await page.getByText("✓ Preview finished (3 products).").isVisible());
check("results table rows", (await page.locator("table:has(th:text-is(\"Product key\")) tbody tr").count()) >= 3);
check("thumbnails shown", (await page.locator("table img").count()) === 2);
check("unmatched image shown", await page.getByText("Images that match no product").isVisible());
check("admin link rewritten", (await page.locator('s-link[href="shopify:admin/products/111"]').count()) === 1);
await shot("4-results");

// Filter chip
await page.locator("s-button", { hasText: "Not found in Shopify 1" }).click();
await page.waitForTimeout(300);
check("filter narrows rows", (await page.locator("table:has(th:text-is(\"Product key\")) tbody tr").count()) === 1);

// Upload asks first
await page.getByText("3 · Upload to Shopify").click();
await page.waitForTimeout(300);
check("confirmation counts the preview just run", await page.getByText("The latest preview shows 2 products will change in Shopify.").isVisible());
check("one confirmation banner", (await page.locator('s-banner[heading="Upload to Shopify?"]').count()) === 1, String(await page.locator('s-banner[heading="Upload to Shopify?"]').count()));
check("selected choices visible", await page.locator("s-button", { hasText: "Google Sheet link" }).first().isVisible() && await page.locator("s-button", { hasText: "Upload images" }).first().isVisible());
await shot("5-confirm");

check("no page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
