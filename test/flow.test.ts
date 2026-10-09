// The full check -> plan -> apply flow against a simulated Shopify store (never a real one)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeConfig } from "../app/.server/core/config";
import { Google } from "../app/.server/core/google";
import { describeImage, type ImageFile } from "../app/.server/core/images";
import { runJob, type RunDeps, type RunStore, type RunResult } from "../app/.server/core/runner";
import { Shopify } from "../app/.server/core/shopify";
import { startMock } from "./mock-shopify";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

// Same settings as the desktop tool's config.example.yaml, with "create products that are not in Shopify" on
const cfg = normalizeConfig({
  sheet: { source: "file", fileId: "sample" },
  images: { source: "upload", mode: "append" },
  match: { find_by: "sku", create_missing: true, new_product_status: "DRAFT" },
  columns: {
    product_key: "AMC Name",
    image_key: "Meta Name",
    image_alt: "Product Name",
    title: "Product Name",
    description: "Description",
    vendor: "Supplier",
    product_type: "Category",
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

// In-memory version of the database store
function memoryStore() {
  const fingerprints = new Map<string, string>();
  const uploaded = new Map<string, string[]>();
  const backups: unknown[] = [];
  const store: RunStore = {
    getFingerprint: async (k) => fingerprints.get(k) ?? null,
    setFingerprint: async (k, fp) => void fingerprints.set(k, fp),
    getUploaded: async (id) => uploaded.get(id) ?? [],
    addUploaded: async (id, uids) => void uploaded.set(id, [...(uploaded.get(id) ?? []), ...uids]),
    saveBackup: async (p) => void backups.push(p),
  };
  return { store, backups };
}

const images = async (): Promise<ImageFile[]> =>
  fs.readdirSync(path.join(FIXTURES, "images")).map((name) => {
    const file = path.join(FIXTURES, "images", name);
    return describeImage(name, { uid: `upload:${name}`, size: fs.statSync(file).size, read: async () => fs.readFileSync(file) });
  });

describe("check, plan and apply", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let deps: RunDeps;
  let mem: ReturnType<typeof memoryStore>;
  let tokenRefreshes = 0;
  const byKey = (r: RunResult) => Object.fromEntries(r.report.map((x) => [x.product_key, x]));

  beforeAll(async () => {
    mock = await startMock();
    mem = memoryStore();
    deps = {
      cfg,
      sheet: { kind: "file", name: "products-sample.csv", data: fs.readFileSync(path.join(FIXTURES, "products-sample.csv")) },
      uploadedImages: images,
      google: new Google(),
      store: mem.store,
      shopify: new Shopify({
        shop: "mock-store.myshopify.com",
        apiVersion: "2025-10",
        endpoint: mock.endpoint,
        accessToken: async (refresh) => {
          if (refresh) tokenRefreshes++;
          return "test-token";
        },
      }),
    };
  });
  afterAll(() => mock.server.close());

  it("check: every sample product has images, Shopify not contacted", async () => {
    const r = await runJob("check", { ...deps, shopify: undefined });
    expect(r.report.map((x) => x.action)).toEqual(["Images found", "Images found", "Images found"]);
    expect(r.unmatched.map((u) => u.name)).toEqual(["old-banner.png"]);
    expect(mock.calls).toHaveLength(0);
  });

  it("plan: compares with Shopify and saves nothing", async () => {
    const logs: string[] = [];
    const pr = byKey(await runJob("plan", deps, { log: (m) => logs.push(m) }));
    // Oslo will update with 3 new images and 1 new variant
    expect(pr["AMC-SOFA-001"]).toMatchObject({ action: "Will update", images_new: 3, tags_added: "living room" });
    expect(pr["AMC-SOFA-001"].variants).toMatch(/1 updated, 1 new/);
    // The Aria image is already on the product, so it is not re-uploaded
    expect(pr["AMC-BED-014"]).toMatchObject({ images_new: 0, collections: "Beds" });
    expect(pr["AMC-BED-014"].warnings).toMatch(/smart/);
    // Nordic will be created, with a missing-collection warning
    expect(pr["AMC-TBL-007"].action).toBe("Will create");
    expect(pr["AMC-TBL-007"].warnings).toMatch(/Tables/);
    expect(mock.calls.some((c) => /mutation/.test(c.query))).toBe(false);
    expect(logs[0]).toBe("=== PLAN started ===");
  });

  it("apply: saves everything in sheet order", async () => {
    const progress: number[] = [];
    const r = await runJob("apply", deps, { progress: (p) => progress.push(p.done) });
    expect(r.report.filter((x) => x.action === "Error")).toEqual([]);
    expect(r.report.map((x) => x.product_key)).toEqual(["AMC-SOFA-001", "AMC-BED-014", "AMC-TBL-007"]);
    expect(r.store).toBe("mock-store.myshopify.com");
    expect(progress.at(-1)).toBe(3);

    const sets = mock.calls.filter((c) => /productSet/.test(c.query)).map((c) => c.variables.input);
    const oslo = sets.find((s) => s.id === "gid://shopify/Product/1");
    expect(oslo.productOptions).toEqual([
      { name: "Colour", values: [{ name: "Grey" }, { name: "Blue" }] },
      { name: "Size", values: [{ name: "3 Seater" }] },
    ]);
    expect(oslo.variants).toHaveLength(2);
    expect(oslo.variants[0]).toMatchObject({ id: "gid://shopify/ProductVariant/11", compareAtPrice: "1499" });
    expect(oslo.variants[1].sku).toBe("OSLO-3S-BLU");
    expect(oslo.files).toBeUndefined(); // in append mode, images for an existing product are added with productUpdate

    const up = mock.calls.find((c) => /productUpdate/.test(c.query))!;
    expect(up.variables.media).toHaveLength(3);
    expect(up.variables.media[0].alt).toBe("Oslo 3 Seater Sofa");

    // New Nordic product created as Draft with its image
    const nordic = sets.find((s) => !s.id);
    expect(nordic).toMatchObject({ title: "Nordic Coffee Table", status: "DRAFT" });
    expect(nordic.files).toHaveLength(1);
    expect(nordic.variants[0]).toMatchObject({ optionValues: [{ optionName: "Title", name: "Default Title" }], price: "199" });

    const mfs = mock.calls.filter((c) => /metafieldsSet/.test(c.query)).flatMap((c) => c.variables.m);
    expect(mfs.some((m: { key: string; value: string }) => m.key === "warranty_years" && m.value === "5")).toBe(true);
    expect(mock.calls.filter((c) => /collectionAddProducts/.test(c.query))).toHaveLength(2);

    expect(mock.uploads).toHaveLength(4);
    expect(mem.backups.length).toBeGreaterThan(0);
    expect(mem.backups[0]).not.toHaveProperty("foundBy");
  });

  it("second apply: everything is already done, nothing duplicated", async () => {
    const r = await runJob("apply", deps);
    expect(r.report.map((x) => x.action)).toEqual(["Already done", "Already done", "Already done"]);
    expect(mock.uploads).toHaveLength(4);
  });

  it("an expired token is refreshed once and the run carries on", async () => {
    mock.state.unauthorizedLeft = 1;
    const r = await runJob("plan", deps, { only: "AMC-BED-014" });
    expect(tokenRefreshes).toBe(1);
    expect(r.report).toHaveLength(1);
    expect(r.report[0].action).not.toBe("Error");
  });

  it("a missing column stops the run before anything happens", async () => {
    const bad = { ...deps, cfg: { ...cfg, columns: { ...cfg.columns, vendor: "Brand" } } };
    await expect(runJob("plan", bad)).rejects.toThrow(/not found in the sheet: Brand/);
  });
});
