// The uploader page's form logic, the settings the server accepts, signed links, and a server render
// of the whole page to catch component errors.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanSettings } from "../app/.server/core/config";
import { signedUrl, verifySigned } from "../app/.server/signed";
import { autoFill, defaultRules, dropStaleColumns, nothingMapped, readiness, withDefaults } from "../app/lib/uploader";
import { Uploader } from "../app/components/uploader/Uploader";

// The column names of the downloadable template
const TEMPLATE = [
  "Product Key", "SKU", "Image Name", "Product Title", "Handle", "Vendor", "Product Type", "Status", "Description", "Tags",
  "Collections", "Meta Title", "Meta Description", "Image Alt Text", "Colour", "Size", "Price", "Compare At Price", "Barcode",
  "Material (custom.material)", "Dimensions (custom.dimensions)", "Warranty Years (custom.warranty_years)",
  "Assembly Required Yes/No (custom.assembly_required)", "Care Instructions (custom.care_instructions)",
  "Delivery Time (custom.delivery_time)",
];

describe("auto-fill from column names", () => {
  it("maps every template column by itself", () => {
    const s = autoFill(withDefaults({}), TEMPLATE);
    expect(s.columns).toMatchObject({
      product_key: "Product Key",
      sku: "SKU",
      image_key: "Image Name",
      title: "Product Title",
      handle: "Handle",
      vendor: "Vendor",
      product_type: "Product Type",
      status: "Status",
      description: "Description",
      tags: "Tags",
      collections: "Collections",
      seo_title: "Meta Title",
      seo_description: "Meta Description",
      image_alt: "Image Alt Text",
      price: "Price",
      compare_at_price: "Compare At Price",
      barcode: "Barcode",
      options: ["Colour", "Size"],
    });
    expect(s.metafields).toHaveLength(6);
    expect(s.metafields!.find((m) => m.key === "warranty_years")!.type).toBe("number_integer");
    expect(s.metafields!.find((m) => m.key === "assembly_required")!.type).toBe("boolean");
    expect(s.match!.rules).toEqual([
      { field: "sku", column: "SKU" },
      { field: "barcode", column: "Barcode" },
      { field: "handle", column: "Handle" },
      { field: "title", column: "Product Title" },
    ]);
  });

  it("never overwrites a column the merchant chose", () => {
    const start = withDefaults({ columns: { title: "Handle", options: [] } });
    expect(autoFill(start, TEMPLATE).columns!.title).toBe("Handle");
  });

  it("works on a sheet with only a title and a meta title", () => {
    const s = autoFill(withDefaults({}), ["Product Title", "Meta Title"]);
    expect(s.columns).toMatchObject({ title: "Product Title", seo_title: "Meta Title" });
    expect(s.match!.rules).toEqual([{ field: "title", column: "Product Title" }]);
    expect(defaultRules(s, ["Product Title"])).toEqual([{ field: "title", column: "Product Title" }]);
  });
});

describe("loading a different sheet", () => {
  it("clears links to columns that are gone, and counts them", () => {
    const s = autoFill(withDefaults({}), TEMPLATE);
    const { settings, dropped } = dropStaleColumns(s, ["SKU", "Product Title", "Price"]);
    expect(settings.columns).toEqual({ sku: "SKU", title: "Product Title", price: "Price", options: [] });
    expect(settings.metafields).toEqual([]);
    expect(settings.match!.rules).toEqual([
      { field: "sku", column: "SKU" },
      { field: "title", column: "Product Title" },
    ]);
    expect(dropped).toBeGreaterThan(10);
    expect(nothingMapped(settings)).toBe(false);
  });

  it("changes nothing when every column is still there", () => {
    const s = autoFill(withDefaults({}), TEMPLATE);
    const r = dropStaleColumns(s, TEMPLATE);
    expect(r.dropped).toBe(0);
    expect(r.settings).toBe(s);
  });
});

describe("readiness checklist", () => {
  it("blocks runs without a sheet or a way to find products", () => {
    expect(readiness(withDefaults({}), { sheetOk: false, imageCount: 0 }).canRun).toBe(false);
    const s = autoFill(withDefaults({}), ["SKU", "Price"]);
    const r = readiness(s, { sheetOk: true, imageCount: 0 });
    expect(r.canRun).toBe(true);
    expect(r.items.map((i) => i.text)).toEqual([
      "Product sheet loaded",
      'Products found by SKU from "SKU"',
      "1 fields will be updated where the sheet has a value",
      "Images: not changed",
    ]);
  });
  it("mentions uploaded images", () => {
    const s = withDefaults({ images: { source: "upload" } });
    expect(readiness(s, { sheetOk: true, imageCount: 12 }).items[3].text).toBe("12 images uploaded");
  });
});

describe("settings sent by the browser", () => {
  it("keeps known fields, drops the rest, and bounds values", () => {
    // Parsed from JSON like a request body, so "__proto__" is an own key (the real attack shape)
    const body = JSON.parse(`{
      "sheet": { "source": "google", "google_sheet": "https://docs.google.com/x", "header_row": -5, "evil": 1 },
      "images": { "source": "ftp", "mode": "replace" },
      "match": { "rules": [{ "field": "sku", "column": "SKU" }, { "field": "drop table", "column": "X" }, { "column": "" }], "create_missing": "yes" },
      "columns": { "title": "Product Title", "__proto__": { "polluted": true }, "options": ["Colour", { "column": "Size", "name": "Größe" }, 5, null] },
      "options": { "concurrency": 99, "tags_mode": "replace" },
      "metafields": [{ "column": "Material", "namespace": "custom", "key": "material", "type": "single_line_text_field", "extra": 1 }],
      "somethingElse": true
    }`);
    const s = cleanSettings(body);
    expect(s).toEqual({
      sheet: { source: "google", fileId: "", google_sheet: "https://docs.google.com/x", worksheet: "", header_row: 0 },
      images: { source: "none", drive_folder: "", mode: "replace" },
      match: {
        rules: [
          { field: "sku", column: "SKU" },
          { field: "sku", column: "X" },
          { field: "sku", column: "" },
        ],
        create_missing: false,
        new_product_status: "DRAFT",
      },
      columns: { title: "Product Title", options: [{ column: "Colour", name: "Colour" }, { column: "Size", name: "Größe" }] },
      options: { tags_mode: "replace", create_missing_collections: false, keep_unlisted_variants: true, concurrency: 8 },
      metafields: [{ column: "Material", namespace: "custom", key: "material", type: "single_line_text_field" }],
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("anything that is not an object becomes the defaults", () => {
    expect(cleanSettings("nonsense").options).toEqual({
      tags_mode: "append",
      create_missing_collections: false,
      keep_unlisted_variants: true,
      concurrency: 4,
    });
  });
});

describe("signed links", () => {
  const saved = process.env.SHOPIFY_API_SECRET;
  beforeAll(() => {
    process.env.SHOPIFY_API_SECRET = "test-secret";
  });
  afterAll(() => {
    process.env.SHOPIFY_API_SECRET = saved;
  });
  const parse = (url: string) => new URL(url, "https://app.example.com");

  it("a link is accepted for its own shop, kind and id only", () => {
    const u = parse(signedUrl("file", "a.myshopify.com", "f1"));
    expect(u.pathname).toBe("/dl/file/f1");
    expect(verifySigned("file", "f1", u.searchParams)).toBe("a.myshopify.com");
    expect(verifySigned("file", "f2", u.searchParams)).toBeNull();
    expect(verifySigned("report-csv", "f1", u.searchParams)).toBeNull();
    const otherShop = new URLSearchParams(u.searchParams);
    otherShop.set("shop", "b.myshopify.com");
    expect(verifySigned("file", "f1", otherShop)).toBeNull();
  });
  it("an expired or extended link is refused", () => {
    const old = parse(signedUrl("file", "a.myshopify.com", "f1", -10));
    expect(verifySigned("file", "f1", old.searchParams)).toBeNull();
    const extended = new URLSearchParams(parse(signedUrl("file", "a.myshopify.com", "f1")).searchParams);
    extended.set("exp", String(Number(extended.get("exp")) + 3600));
    expect(verifySigned("file", "f1", extended)).toBeNull();
  });
});

describe("the uploader page", () => {
  it("renders with saved settings and a finished run", () => {
    const html = renderToString(
      createElement(Uploader, {
        initialSettings: autoFill(withDefaults({ images: { source: "upload" } }), TEMPLATE),
        imageCount: 3,
        googleEmail: "uploader@example.iam.gserviceaccount.com",
        templateUrl: "/templates/Shopify-Product-Template.xlsx",
        latestJob: {
          id: "j1",
          command: "plan",
          status: "done",
          options: null,
          progress: { done: 3, total: 3, elapsedMs: 4000, etaMs: 0 },
          counts: { "Will update": 3 },
          error: null,
          stopAsked: false,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
    );
    expect(html).toContain("1. Product sheet");
    expect(html).toContain("3 images uploaded");
    expect(html).toContain("5. Run");
    expect(html).toContain("Preview finished");
  });
});
