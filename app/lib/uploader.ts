// Form logic for the uploader page that runs in the browser: field list, auto-fill from column names,
// default "find product" rules and the readiness checklist. Ported from the desktop tool's web page.
import type { MatchField, Settings } from "../.server/core/config";

export type { Settings };

// [key, label, hint, auto-fill pattern]
export const FIELDS: [string, string, string, RegExp][] = [
  ["product_key", "Product key (optional)", "Groups variant rows into one product. Not needed for one row per product", /amc|product.?key|product.?code|item.?code/],
  ["image_key", "Image name", "Image file names are matched to this column", /meta.?name|image.?name|file.?name|photo.?name/],
  ["title", "Title", "", /product.?(name|title)|^title$|^name$/],
  ["description", "Description", "Plain text or HTML", /^(product.?)?desc|body|detail/],
  ["seo_title", "Meta title (SEO)", "Title shown in Google results; about 60 characters", /meta.?title|seo.?title|page.?title/],
  ["seo_description", "Meta description (SEO)", "Text shown under the title in Google; about 155 characters", /meta.?desc|seo.?desc/],
  ["vendor", "Vendor / Supplier", "", /supplier|vendor|brand|manufacturer/],
  ["product_type", "Product type / Category", "", /category|product.?type|^type$/],
  ["tags", "Tags", "Comma separated", /tag/],
  ["collections", "Collections", "Collection names, comma separated", /collection/],
  ["sku", "SKU", "", /sku/],
  ["price", "Price", "Currency symbols and commas are fine", /^price|selling|sale.?price|^rate/],
  ["compare_at_price", "Compare-at price", 'The crossed-out "was" price', /compare|rrp|mrp|was.?price|original.?price/],
  ["barcode", "Barcode", "", /barcode|ean|upc|gtin/],
  ["status", "Status", "ACTIVE, DRAFT or ARCHIVED", /status/],
  ["image_alt", "Image alt text", "Empty uses the product title", /alt/],
  ["handle", "Handle (new products only)", "The URL of an existing product is never changed", /handle|slug/],
];

export const MF_TYPES = [
  "single_line_text_field",
  "multi_line_text_field",
  "rich_text_field",
  "number_integer",
  "number_decimal",
  "boolean",
  "list.single_line_text_field",
  "json",
  "url",
  "color",
  "date",
];

export const RULE_FIELDS: [MatchField, string][] = [
  ["sku", "SKU"],
  ["barcode", "Barcode"],
  ["handle", "Handle (URL)"],
  ["title", "Title"],
  ["tag", "Tag"],
  ["id", "Shopify product ID or admin link"],
];
const RULE_GUESS: Partial<Record<MatchField, RegExp>> = {
  sku: /sku/,
  barcode: /barcode|ean|upc|gtin/,
  handle: /handle|slug/,
  title: /product.?(name|title)|^title$|^name$/,
};

export const DEFAULT_SETTINGS: Settings = {
  sheet: { source: "file", fileId: "", google_sheet: "", worksheet: "", header_row: 0 },
  images: { source: "none", drive_folder: "", mode: "append" },
  match: { rules: [], create_missing: false, new_product_status: "DRAFT" },
  columns: { options: [] },
  options: { tags_mode: "append", create_missing_collections: false, keep_unlisted_variants: true, concurrency: 4 },
  metafields: [],
};

// Saved settings with every section present, so the form can read any field
export function withDefaults(s: Settings | null | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  const v = s || {};
  return {
    sheet: { ...d.sheet, ...v.sheet },
    images: { ...d.images, ...v.images },
    match: { ...d.match, ...v.match, rules: v.match?.rules ?? [] },
    columns: { ...v.columns, options: v.columns?.options ?? [] },
    options: { ...d.options, ...v.options },
    metafields: v.metafields ?? [],
  };
}

type Columns = NonNullable<Settings["columns"]>;
const col = (s: Settings, k: string) => (s.columns as Record<string, unknown> | undefined)?.[k] as string | undefined;
const optionColumns = (s: Settings) =>
  (s.columns?.options || []).map((o) => (typeof o === "string" ? o : o?.column || "")).filter(Boolean);

// Use the identifier columns that exist, most precise first
export function defaultRules(s: Settings, headers: string[]) {
  const out: { field: MatchField; column: string }[] = [];
  for (const [f] of RULE_FIELDS) {
    const guess = RULE_GUESS[f];
    const c = col(s, f) || (guess ? headers.find((h) => guess.test(h.toLowerCase())) : "");
    if (c && headers.includes(c)) out.push({ field: f, column: c });
  }
  return out;
}

// "Auto-fill from column names": fills only what is still empty, never overwrites a choice
export function autoFill(input: Settings, headers: string[]): Settings {
  const s = withDefaults(structuredClone(input));
  const columns = s.columns as Columns & Record<string, unknown>;
  const used = new Set(Object.values(columns).filter((v): v is string => typeof v === "string" && !!v));
  for (const [k, , , re] of FIELDS) {
    if (columns[k]) continue;
    const h = headers.find((x) => !used.has(x) && re.test(x.toLowerCase()));
    if (h) {
      columns[k] = h;
      used.add(h);
    }
  }
  if (!columns.image_alt && columns.title) columns.image_alt = columns.title;
  if (!optionColumns(s).length) {
    columns.options = headers.filter((h) => /^(colou?r|size|finish|variant|option)/i.test(h) && !used.has(h));
  }
  // Headers written as "Material (custom.material)" become metafields
  for (const h of headers) {
    const m = h.match(/\(\s*([a-z0-9_]+)\.([a-z0-9_]+)\s*\)/i);
    if (!m || s.metafields!.some((x) => x.column === h)) continue;
    const type = /yes\s*\/\s*no/i.test(h)
      ? "boolean"
      : /\b(years?|qty|quantity|number)\b/i.test(h)
        ? "number_integer"
        : "single_line_text_field";
    s.metafields!.push({ column: h, namespace: m[1], key: m[2], type });
  }
  if (!(s.match!.rules || []).some((r) => r?.column)) s.match!.rules = defaultRules(s, headers);
  return s;
}

export const nothingMapped = (s: Settings) =>
  !Object.entries(s.columns || {}).some(([k, v]) => k !== "options" && v);

// Clears links to columns that are not in the sheet (after loading a different sheet)
export function dropStaleColumns(input: Settings, headers: string[]): { settings: Settings; dropped: number } {
  if (!headers.length) return { settings: input, dropped: 0 };
  const s = withDefaults(structuredClone(input));
  const has = (c?: string) => !!c && headers.includes(c);
  let n = 0;
  const columns = s.columns as Record<string, unknown>;
  for (const [k, v] of Object.entries(columns)) {
    if (k !== "options" && typeof v === "string" && v && !has(v)) {
      delete columns[k];
      n++;
    }
  }
  const opts = (s.columns!.options || []).filter((o) => has(typeof o === "string" ? o : o?.column));
  n += (s.columns!.options || []).length - opts.length;
  s.columns!.options = opts;
  const mfs = s.metafields!.filter((m) => !m.column || has(m.column));
  n += s.metafields!.length - mfs.length;
  s.metafields = mfs;
  const rules = (s.match!.rules || []).filter((r) => !r?.column || has(r.column));
  n += (s.match!.rules || []).length - rules.length;
  s.match!.rules = rules;
  return { settings: n ? s : input, dropped: n };
}

export interface ReadyItem {
  ok: boolean;
  text: string;
  blocking: boolean;
}

export function readiness(s: Settings, info: { sheetOk: boolean; imageCount: number }) {
  const rules = (s.match?.rules || []).filter((r) => r?.field && r.column);
  const label = (f?: string) => RULE_FIELDS.find(([x]) => x === f)?.[1] || f;
  const findText = rules.map((r) => `${label(r.field)} from "${r.column}"`).join(", then ");
  const keyCols = new Set([col(s, "product_key"), ...rules.map((r) => r.column)]);
  const updates =
    Object.entries(s.columns || {}).filter(
      ([k, v]) => k !== "options" && k !== "product_key" && typeof v === "string" && v && !keyCols.has(v),
    ).length +
    optionColumns(s).length +
    (s.metafields || []).filter((m) => m.column).length;
  const src = s.images?.source;
  const hasImages = src === "drive" ? !!s.images?.drive_folder : src === "upload" ? info.imageCount > 0 : false;

  const items: ReadyItem[] = [
    { ok: info.sheetOk, text: info.sheetOk ? "Product sheet loaded" : "Add a product sheet (step 1)", blocking: !info.sheetOk },
    {
      ok: !!rules.length,
      text: rules.length ? `Products found by ${findText}` : 'Choose how to find products in step 2 (for example Title from your "Product Title" column)',
      blocking: !rules.length,
    },
    {
      ok: updates > 0 || hasImages,
      text: updates > 0 ? `${updates} fields will be updated where the sheet has a value` : "Nothing mapped to update yet (step 2)",
      blocking: false,
    },
    {
      ok: true,
      text:
        src === "none" || !src
          ? "Images: not changed"
          : hasImages
            ? src === "drive"
              ? "Images from Google Drive"
              : `${info.imageCount} images uploaded`
            : "Images: none added yet, so they are skipped",
      blocking: false,
    },
  ];
  return { items, canRun: info.sheetOk && rules.length > 0 };
}

export const formatDuration = (ms: number) => {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
