/* eslint-disable @typescript-eslint/no-explicit-any -- loose simulated-store data */
// Backups, restore and the plan limit, against the simulated Shopify store (never a real one)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mergeBackupInfo, type BackupData, type BackupInfo } from "../app/.server/core/backup";
import { normalizeConfig } from "../app/.server/core/config";
import { Google } from "../app/.server/core/google";
import { describeImage, type ImageFile } from "../app/.server/core/images";
import { restoreRun } from "../app/.server/core/restore";
import { runJob, type RunDeps, type RunStore } from "../app/.server/core/runner";
import { Shopify, type ShopifyProduct } from "../app/.server/core/shopify";
import { planByKey, planKeyFromName, remaining, monthOf } from "../app/lib/plans";
import { startMock } from "./mock-shopify";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const cfg = normalizeConfig({
  sheet: { source: "file", fileId: "sample" },
  images: { source: "upload", mode: "append" },
  match: { find_by: "sku", create_missing: true },
  columns: {
    product_key: "AMC Name",
    image_key: "Meta Name",
    image_alt: "Product Name",
    title: "Product Name",
    description: "Description",
    tags: "Tags",
    collections: "Collections",
    options: ["Colour", "Size"],
    price: "Price",
    compare_at_price: "Compare Price",
    sku: "SKU",
  },
  metafields: [
    { column: "Material", namespace: "custom", key: "material", type: "single_line_text_field" },
    { column: "Warranty Years", namespace: "custom", key: "warranty_years", type: "number_integer" },
  ],
});

const images = async (): Promise<ImageFile[]> =>
  fs.readdirSync(path.join(FIXTURES, "images")).map((name) => {
    const file = path.join(FIXTURES, "images", name);
    return describeImage(name, { uid: `upload:${name}`, size: fs.statSync(file).size, read: async () => fs.readFileSync(file) });
  });

// Backups by run, like the ProductBackup table (first snapshot kept, lists merged)
function memoryBackups() {
  const byRun = new Map<string, Map<string, BackupData>>();
  const save = async (run: string, product: ShopifyProduct, info: BackupInfo) => {
    const m = byRun.get(run) ?? new Map<string, BackupData>();
    byRun.set(run, m);
    const prev = m.get(product.id);
    m.set(product.id, prev?._backup ? { ...prev, _backup: mergeBackupInfo(prev._backup, info) } : structuredClone({ ...product, _backup: info }));
  };
  const items = (run: string) => [...(byRun.get(run)?.values() ?? [])];
  return { save, items, byRun };
}

function memoryStore(backups: ReturnType<typeof memoryBackups>, run: string, limit: number | null = null) {
  const fingerprints = new Map<string, string>();
  let used = 0;
  const store: RunStore = {
    getFingerprint: async (k) => fingerprints.get(k) ?? null,
    setFingerprint: async (k, fp) => void fingerprints.set(k, fp),
    getUploaded: async () => [],
    addUploaded: async () => {},
    saveBackup: (p, info) => backups.save(run, p, info),
    useQuota: async () => (limit == null || used < limit ? (used++, true) : false),
    releaseQuota: async () => void used--,
  };
  return { store, fingerprints, used: () => used };
}

describe("backup and restore", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let shopify: Shopify;
  let deps: RunDeps;
  let original: any[];
  const backups = memoryBackups();
  const forgotten: string[] = [];
  const shape = (p: any) => ({
    descriptionHtml: p.descriptionHtml,
    tags: p.tags,
    variants: p.variants.nodes.map((v: any) => ({ id: v.id, price: Number(v.price), compareAtPrice: v.compareAtPrice == null ? null : Number(v.compareAtPrice), sku: v.sku })),
    media: p.media.nodes.map((m: any) => m.id),
    collections: p.collections.nodes.map((c: any) => c.id),
    metafields: (p.metafields || []).map((m: any) => `${m.namespace}.${m.key}=${m.value}`),
  });
  const product = (id: string) => mock.products.find((p) => p.id === id);
  const restoreDeps = (run: string, undoRun: string, finishedAt = new Date()) => ({
    shopify,
    items: backups.items(run),
    finishedAt,
    saveUndo: (p: ShopifyProduct, info: BackupInfo) => backups.save(undoRun, p, info),
    afterRestore: async (key: string | undefined) => void forgotten.push(key || ""),
  });

  beforeAll(async () => {
    mock = await startMock();
    original = structuredClone(mock.products);
    shopify = new Shopify({ shop: "mock-store.myshopify.com", apiVersion: "2026-10", endpoint: mock.endpoint, accessToken: async () => "t" });
    deps = {
      cfg,
      sheet: { kind: "file", name: "products-sample.csv", data: fs.readFileSync(path.join(FIXTURES, "products-sample.csv")) },
      uploadedImages: images,
      google: new Google(),
      shopify,
      store: memoryStore(backups, "upload1").store,
    };
    const r = await runJob("apply", deps);
    expect(r.report.filter((x) => x.action === "Error")).toEqual([]);
  });
  afterAll(() => mock.server.close());

  it("the backup records what the upload changed and the metafields before it", () => {
    const oslo = backups.items("upload1").find((b) => b.handle === "oslo-3-seater-sofa")!;
    expect(oslo.descriptionHtml).toBe("<p>old</p>");
    expect([...oslo._backup!.fields].sort()).toEqual(["descriptionHtml", "tags", "variants"]);
    expect(oslo._backup!.metafields.map((m) => [m.key, m.value])).toEqual([["material", null], ["warranty_years", null]]);
    expect(oslo._backup!).toMatchObject({ kind: "upload", key: "AMC-SOFA-001", collections: ["Sofas"], imagesAdded: 3 });
    const aria = backups.items("upload1").find((b) => b.handle === "aria-king-size-bed")!;
    expect(aria._backup!.metafields.find((m) => m.key === "material")!.value).toBe("Pine");
  });

  it("preview lists what goes back and saves nothing", async () => {
    const before = mock.calls.length;
    const r = await restoreRun(restoreDeps("upload1", "never"));
    const byTitle = Object.fromEntries(r.report.map((x) => [x.title, x]));
    expect(byTitle["Oslo 3 Seater Sofa"].action).toBe("Will restore");
    expect(byTitle["Oslo 3 Seater Sofa"].changes).toMatch(
      /description, tags, 1 variants.*metafields: custom\.material, custom\.warranty_years.*removed from: Sofas.*3 images added by the upload removed/,
    );
    expect(byTitle["Oslo 3 Seater Sofa"].warnings).toMatch(/1 variants added since the backup were kept \(OSLO-3S-BLU\)/);
    expect(byTitle["Aria King Size Bed"].changes).toMatch(/metafields: custom\.material, custom\.warranty_years, removed from: Beds/);
    expect(mock.calls.slice(before).some((c) => /mutation/.test(c.query))).toBe(false);
    expect(backups.items("never")).toEqual([]);
  });

  let afterUpload: Record<string, unknown>;
  it("restore puts the products back; the added variant is kept", async () => {
    afterUpload = { oslo: shape(product("gid://shopify/Product/1")), aria: shape(product("gid://shopify/Product/2")) };
    const r = await restoreRun(restoreDeps("upload1", "restore1"), { apply: true });
    expect(r.report.map((x) => x.action)).toEqual(["Restored", "Restored"]);
    const now = shape(product("gid://shopify/Product/1"));
    expect({ ...now, variants: now.variants.slice(0, 1) }).toEqual(shape(original[0]));
    expect(now.variants[1].sku).toBe("OSLO-3S-BLU");
    expect(shape(product("gid://shopify/Product/2"))).toEqual(shape(original[1]));
    expect(forgotten.sort()).toEqual(["AMC-BED-014", "AMC-SOFA-001"]);
    expect(backups.items("restore1").every((b) => b._backup?.kind === "restore")).toBe(true);
  });

  it("a restore can be undone (images excepted)", async () => {
    await restoreRun(restoreDeps("restore1", "restore2"), { apply: true });
    expect({ ...shape(product("gid://shopify/Product/1")), media: [] }).toEqual({ ...(afterUpload.oslo as object), media: [] });
    expect(shape(product("gid://shopify/Product/2"))).toEqual(afterUpload.aria);
  });

  it("products changed after the upload get a note, and can be skipped", async () => {
    // Both products were last changed after this (made-up) end of the run
    const r = await restoreRun(restoreDeps("restore2", "x", new Date("2019-01-01T00:00:00Z")), { apply: true, skipEdited: true });
    expect(r.report.every((x) => x.action === "Skipped")).toBe(true);
    expect(r.report[0].warnings).toMatch(/Changed in Shopify after this upload/);
    expect(backups.items("x")).toEqual([]);
  });

  it("only the chosen products", async () => {
    const r = await restoreRun(restoreDeps("upload1", "y"), { only: "oslo 3 seater sofa" });
    expect(r.report.map((x) => x.title)).toEqual(["Oslo 3 Seater Sofa"]);
  });

  it("an old backup without the record of changes puts back every saved field that differs", async () => {
    const { _backup, ...plain } = backups.items("upload1").find((b) => b.handle === "aria-king-size-bed")!;
    const r = await restoreRun({ ...restoreDeps("none", "z"), items: [{ ...plain, vendor: "Old Vendor" }] });
    expect(r.report[0].changes).toBe("vendor");
    expect(r.report[0].warnings).toMatch(/not known/);
  });
});

describe("plan limit", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    mock = await startMock();
  });
  afterAll(() => mock.server.close());

  it("stops saving when the month's allowance is used up", async () => {
    const mem = memoryStore(memoryBackups(), "u", 2);
    const r = await runJob("apply", {
      cfg: { ...cfg, options: { ...cfg.options, concurrency: 1 } },
      sheet: { kind: "file", name: "products-sample.csv", data: fs.readFileSync(path.join(FIXTURES, "products-sample.csv")) },
      uploadedImages: images,
      google: new Google(),
      shopify: new Shopify({ shop: "mock-store.myshopify.com", apiVersion: "2026-10", endpoint: mock.endpoint, accessToken: async () => "t" }),
      store: mem.store,
    });
    expect(r.report.map((x) => x.action)).toEqual(["Updated", "Updated", "Plan limit reached"]);
    expect(r.report[2].warnings).toMatch(/allowance of your plan is used up/);
    expect(mem.used()).toBe(2);
    expect(mock.products.some((p) => p.title === "Nordic Coffee Table")).toBe(false);
  });

  it("plans from Shopify subscription names", () => {
    expect(planKeyFromName("Pro")).toBe("pro");
    expect(planKeyFromName("UNLIMITED plan")).toBe("unlimited");
    expect(planKeyFromName("")).toBe("free");
    expect(planKeyFromName("Something else")).toBe("free");
    expect(remaining(planByKey("free"), 60)).toBe(0);
    expect(remaining(planByKey("pro"), 10)).toBe(1990);
    expect(remaining(planByKey("unlimited"), 10)).toBeNull();
    expect(monthOf(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
  });
});
