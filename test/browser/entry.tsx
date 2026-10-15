// Renders the real Uploader component with a fake API, for checking it in a real browser
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { Uploader } from "../../app/components/uploader/Uploader";
import { Backups, type BackupList } from "../../app/components/uploader/Backups";

const HEADERS = [
  "Product Key", "SKU", "Image Name", "Product Title", "Vendor", "Tags", "Colour", "Size", "Price",
  "Material (custom.material)",
];
const thumb = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`)}`;

const w = window as unknown as Record<string, unknown>;
const calls: { method: string; url: string; body?: unknown }[] = [];
w.__calls = calls;
w.__saved = null;
let polls = 0;
let images = 3;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const job = (status: string, done: number) => ({
  id: "j2",
  command: "plan",
  status,
  options: null,
  progress: { done, total: 3, elapsedMs: done * 1000, etaMs: (3 - done) * 1000 },
  counts: status === "done" ? { "Will update": 2, "Not found in Shopify": 1 } : null,
  error: null,
  stopAsked: false,
  log: `12:00:00  === PLAN started ===\n12:00:01  [1/3] SOFA-001: Will update`,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: status === "done" ? new Date().toISOString() : null,
});

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || "GET";
  let body: unknown;
  if (typeof init?.body === "string") body = JSON.parse(init.body);
  calls.push({ method, url, body });
  await new Promise((r) => setTimeout(r, 30));
  if (url === "/app/api/settings" && method === "POST") {
    w.__saved = body;
    return json({ settings: body });
  }
  if (url === "/app/api/sheet") {
    return json({
      sheet: {
        name: "products.xlsx",
        worksheets: ["Products", "Example"],
        headers: HEADERS,
        headerRow: 1,
        rowCount: 4,
        preview: [{ "Product Key": "SOFA-001", SKU: "OSLO-GRY", "Product Title": "Oslo Sofa", Price: "1299" }],
      },
    });
  }
  if (url.startsWith("/app/api/files?kind=image") && method === "GET") return json({ files: Array.from({ length: images }, (_, i) => ({ id: `f${i}` })) });
  if (url.startsWith("/app/api/files?kind=image") && method === "POST") {
    images++;
    return json({ file: { id: "x" } });
  }
  if (url === "/app/api/jobs" && method === "GET") return json({ jobs: [] });
  if (url === "/app/api/jobs" && method === "POST") {
    const cmd = (body as { command: string }).command;
    const id = cmd === "restore-plan" ? "r1" : cmd === "restore" ? "r2" : "j2";
    return json({ job: { id, status: "queued", command: cmd } }, 201);
  }
  if (url === "/app/api/jobs/j2?report=json") {
    return json({
      report: [
        { sheet_rows: "2 3", product_key: "SOFA-001", title: "Oslo Sofa", action: "Will update", found_by: "Found by SKU", images_new: 2, changes: "title, tags", variants: "1 updated, 1 new", tags_added: "living room", shopify_link: "https://admin.shopify.com/store/x/products/111" },
        { sheet_rows: "4", product_key: "BED-014", title: "Aria Bed", action: "Will update", found_by: "Found by SKU", images_new: 0, changes: "price" },
        { sheet_rows: "5", product_key: "TBL-007", title: "Nordic Table", action: "Not found in Shopify", warnings: 'Searched by SKU "NORD-CT"' },
      ],
      images: {
        "SOFA-001": [
          { name: "Oslo Sofa_1.jpg", where: "Sofas/Oslo Sofa_1.jpg", url: thumb("#c47") },
          { name: "Oslo Sofa_2.jpg", where: "Sofas/Oslo Sofa_2.jpg", url: thumb("#47c") },
        ],
      },
      unmatched: [{ name: "old-banner.png", where: "old-banner.png", url: thumb("#999") }],
      csvUrl: "/dl/report-csv/j2?sig=x",
    });
  }
  if (url === "/app/api/jobs/j2") {
    polls++;
    return json({ job: polls < 2 ? job("running", 1) : job("done", 3) });
  }
  // ---- Backups page ----
  if (url === "/app/api/backups") return json(backupList(restored));
  if (url.startsWith("/app/api/jobs/r") && url.endsWith("?report=json")) {
    const apply = url.includes("/r2");
    return json({
      report: [
        { product_key: "SOFA-001", title: "Oslo Sofa", action: apply ? "Restored" : "Will restore", changes: "description, meta title/description", shopify_link: "https://admin.shopify.com/store/x/products/111" },
        { product_key: "BED-014", title: "Aria Bed", action: "Already same as backup", changes: "" },
      ],
      images: {},
      unmatched: [],
      csvUrl: "/dl/report-csv/r1?sig=x",
    });
  }
  if (url === "/app/api/jobs/r1" || url === "/app/api/jobs/r2") {
    const apply = url.endsWith("r2");
    if (apply) restored = true;
    return json({
      job: {
        ...job("done", 2),
        id: apply ? "r2" : "r1",
        command: apply ? "restore" : "restore-plan",
        options: { backup: "b0000000001" },
        progress: { done: 2, total: 2, elapsedMs: 1000, etaMs: 0 },
        counts: apply ? { Restored: 1, "Already same as backup": 1 } : { "Will restore": 1, "Already same as backup": 1 },
        log: "12:00:00  === RESTORE PREVIEW started ===",
      },
    });
  }
  return json({ error: `fake API: no answer for ${method} ${url}` }, 404);
};

let restored = false;
const day = 24 * 3600e3;
const at = (daysAgo: number, hour: number) => new Date(new Date().setHours(hour, 15, 0, 0) - daysAgo * day).toISOString();
const backup = (id: string, daysAgo: number, hour: number, extra = {}) => ({
  id,
  kind: "upload",
  at: at(daysAgo, hour),
  products: 158,
  of: null,
  hidden: daysAgo > 61,
  expiresAt: new Date(Date.parse(at(daysAgo, hour)) + 182 * day).toISOString(),
  ...extra,
});
const backupList = (withRestore: boolean) => ({
  hideMonths: 2,
  keepMonths: 6,
  backups: [
    ...(withRestore ? [backup("r2", 0, 23, { kind: "restore", of: "b0000000001", products: 1 })] : []),
    backup("b0000000001", 0, 12),
    backup("b0000000002", 0, 11, { products: 64 }),
    backup("b0000000003", 1, 18, { products: 1 }),
    backup("b0000000004", 90, 10, { products: 7 }),
  ],
});

const root = createRoot(document.getElementById("root")!);
if (location.search.includes("backups")) {
  root.render(createElement(Backups, { initial: backupList(false) as BackupList, latestJob: null }));
} else {
  root.render(
    createElement(Uploader, {
      initialSettings: { sheet: { source: "file", fileId: "sheet1" }, images: { source: "upload" } },
      imageCount: 3,
      googleEmail: "uploader@example.iam.gserviceaccount.com",
      templateUrl: "/templates/Shopify-Product-Template.xlsx",
      latestJob: null,
      allowance: { plan: "Free", limit: 50, used: 12, remaining: 38 },
    }),
  );
}
