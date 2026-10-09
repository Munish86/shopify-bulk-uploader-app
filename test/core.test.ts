// Unit tests for the uploader's core logic (ported from the desktop tool)
import { describe, expect, it } from "vitest";
import { buildIndex, findImages, alreadyOnProduct, describeImage } from "../app/.server/core/images";
import { formatMetafield, buildProduct } from "../app/.server/core/build";
import { normalizeConfig, SettingsError } from "../app/.server/core/config";
import { loadRows } from "../app/.server/core/sheet";
import { Google, driveFolderId, sheetRef } from "../app/.server/core/google";
import { parseMoney, toHtml, pool } from "../app/.server/core/util";
import { checkKey } from "../app/.server/storage";

const f = (name: string) => ({ name, stem: name.replace(/\.[^.]+$/, ""), uid: name });

describe("image matching", () => {
  const idx = buildIndex(
    ["Oslo Sofa.jpg", "Oslo Sofa_2.jpg", "oslo-sofa (1).png", "Oslo Sofa_10.jpg", "Oslo Sofa Bed.jpg", "AMC-1234.jpg"].map(f),
  );

  it("numbered images come back in order", () => {
    expect(findImages(idx, "OSLO SOFA").map((x) => x.name)).toEqual([
      "Oslo Sofa.jpg",
      "oslo-sofa (1).png",
      "Oslo Sofa_2.jpg",
      "Oslo Sofa_10.jpg",
    ]);
  });
  it("a similarly named product does not match", () => {
    expect(findImages(idx, "Oslo Sofa").some((x) => x.name === "Oslo Sofa Bed.jpg")).toBe(false);
  });
  it("a 4-digit number in a name is not treated as an image number", () => {
    expect(findImages(idx, "AMC")).toHaveLength(0);
  });
  it("recognises an image already on the product", () => {
    expect(alreadyOnProduct(f("Oslo Sofa_2.jpg"), ["https://cdn/files/Oslo_Sofa_2_3f2a9c1e-aaaa-bbbb.jpg?v=1"])).toBe(true);
    expect(alreadyOnProduct(f("Oslo Sofa_1.jpg"), ["https://cdn/files/Oslo_Sofa_10.jpg?v=1"])).toBe(false);
  });
  it("a broken %-escape in a Shopify URL does not crash", () => {
    expect(alreadyOnProduct(f("Oslo.jpg"), ["https://cdn/files/100%_cotton.jpg"])).toBe(false);
  });
  it("uploaded files keep their folder for display but match on the file name", () => {
    const img = describeImage("Sofas/Oslo Sofa_1.JPG", { uid: "u1", size: 1, read: async () => Buffer.alloc(0) });
    expect(img).toMatchObject({ name: "Oslo Sofa_1.JPG", stem: "Oslo Sofa_1", ext: "jpg", mime: "image/jpeg", where: "Sofas/Oslo Sofa_1.JPG" });
  });
});

describe("values", () => {
  it("prices are cleaned", () => {
    expect(parseMoney("£1,299")).toBe("1299");
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeUndefined();
  });
  it("metafield formats", () => {
    expect(formatMetafield("list.single_line_text_field", "a, b")).toBe('["a","b"]');
    expect(formatMetafield("boolean", "Yes")).toBe("true");
    expect(formatMetafield("list.number_integer", "1,2")).toBe("[1,2]");
    expect(() => formatMetafield("number_integer", "3.5")).toThrow();
  });
  it("description becomes HTML", () => {
    expect(toHtml("a\nb\n\nc")).toBe("<p>a<br>b</p>\n<p>c</p>");
  });
  it("meta title and description are sent, unchanged ones are not", () => {
    const cfg = normalizeConfig(
      { columns: { product_key: "K", seo_title: "MT", seo_description: "MD" }, match: { rules: [{ field: "title", column: "K" }] } },
      { requireAll: false },
    );
    const g = { key: "A", rows: [{ __row: 2, K: "A", MT: "Oslo Sofa | AMC Furniture", MD: "x".repeat(170) }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the fields buildProduct reads
    const existing: any = { id: "P1", title: "Oslo", tags: [], variants: [], options: [], seo: { title: "Old title", description: "x".repeat(170) } };
    const out = buildProduct(g, existing, cfg);
    expect(out.input.seo).toEqual({ title: "Oslo Sofa | AMC Furniture", description: "x".repeat(170) });
    expect(out.warnings.some((w) => /Meta description is 170/.test(w))).toBe(true);
    const same = buildProduct(g, { ...existing, seo: { title: "Oslo Sofa | AMC Furniture", description: "x".repeat(170) } }, cfg);
    expect(same.input.seo).toBeUndefined();
  });
});

describe("worker pool", () => {
  it("respects the limit and visits every item once", async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(x);
      running--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("stops picking new items when asked", async () => {
    let n = 0;
    await pool([1, 2, 3, 4, 5], 1, async () => void n++, () => n >= 2);
    expect(n).toBe(2);
  });
});

describe("settings", () => {
  it("lists every problem at once", () => {
    try {
      normalizeConfig({ metafields: [{ column: "Material" }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as SettingsError).problems).toHaveLength(3);
    }
  });
  it("older find_by settings become match rules, with fallbacks", () => {
    const c = normalizeConfig({
      sheet: { fileId: "f1" },
      match: { find_by: "handle" },
      columns: { sku: "SKU", handle: "Handle", title: "", options: ["Colour", null, { column: "Size", name: "" }] },
    });
    expect(c.match.rules).toEqual([
      { field: "handle", column: "Handle" },
      { field: "sku", column: "SKU" },
    ]);
    expect(c.columns.title).toBeUndefined();
    expect(c.columns.options).toEqual([
      { column: "Colour", name: "Colour" },
      { column: "Size", name: "Size" },
    ]);
  });
  it("a Drive source without a folder link skips images", () => {
    const c = normalizeConfig({ sheet: { fileId: "f1" }, images: { source: "drive" }, columns: { sku: "SKU" } });
    expect(c.images.source).toBe("none");
    expect(c.images.skippedReason).toMatch(/no folder link/);
  });
  it("concurrency is kept between 1 and 8", () => {
    expect(normalizeConfig({ options: { concurrency: 50 } }, { requireAll: false }).options.concurrency).toBe(8);
  });
});

describe("merchant input that must never reach a URL or a file path", () => {
  it("Google links are reduced to a plain ID", () => {
    expect(sheetRef("https://docs.google.com/spreadsheets/d/1AbC_dEf-1234567890/edit#gid=42")).toEqual({
      id: "1AbC_dEf-1234567890",
      gid: "42",
    });
    expect(driveFolderId("https://drive.google.com/drive/folders/1AbC_dEf-1234567890?usp=sharing")).toBe("1AbC_dEf-1234567890");
    expect(() => sheetRef("../../evil?x=1")).toThrow(/Google Sheet link/);
    expect(() => driveFolderId("x' or '1'='1")).toThrow(/Drive folder link/);
  });
  it("storage keys cannot leave the shop's folder", () => {
    expect(checkKey("my-store.myshopify.com/files/abc123")).toBeTruthy();
    expect(() => checkKey("my-store.myshopify.com/files/../../other-store.myshopify.com/files/x")).toThrow();
    expect(() => checkKey("/etc/passwd")).toThrow();
    expect(() => checkKey("my-store.myshopify.com")).toThrow();
  });
});

describe("sheets", () => {
  const google = new Google();
  it("finds the header row below a title row", async () => {
    const csv = "Product list,,\n,,\nSKU,Title,Price\nA1,Sofa,10\n,,\nA2,Bed,20\n";
    const out = await loadRows({ kind: "file", name: "x.csv", data: Buffer.from(csv) }, { worksheet: "", header_row: 0 }, google);
    expect(out.headerRow).toBe(3);
    expect(out.rows.map((r) => [r.__row, r.SKU])).toEqual([
      [4, "A1"],
      [6, "A2"],
    ]);
  });
  it("reads a CSV saved by Excel (starts with a byte-order mark)", async () => {
    const csv = String.fromCharCode(0xfeff) + "SKU,Title\nA1,Sofa\n";
    const out = await loadRows({ kind: "file", name: "x.csv", data: Buffer.from(csv) }, { worksheet: "", header_row: 0 }, google);
    expect(out.headers).toEqual(["SKU", "Title"]);
  });
  it("refuses a file that is too large", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 65);
    await expect(loadRows({ kind: "file", name: "x.csv", data: big }, { worksheet: "", header_row: 0 }, google)).rejects.toThrow(/limit/);
  });
});
