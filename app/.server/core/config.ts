// A shop's saved settings, and turning them into a complete, validated run config.

export const IMAGE_MODES = ["append", "replace", "skip_if_has_images"] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];
// Shopify fields a product can be found by. Tried in the order the user lists them.
export const MATCH_FIELDS = ["sku", "barcode", "handle", "title", "tag", "id"] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export interface MatchRule {
  field: MatchField;
  column: string;
}
export interface OptionColumn {
  column: string;
  name: string;
}
export interface MetafieldMap {
  column: string;
  namespace: string;
  key: string;
  type: string;
}

// Sheet column names for each product field. Empty = do not use.
export interface Columns {
  product_key?: string;
  image_key?: string;
  image_alt?: string;
  title?: string;
  handle?: string;
  description?: string;
  seo_title?: string;
  seo_description?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  collections?: string;
  status?: string;
  price?: string;
  compare_at_price?: string;
  sku?: string;
  barcode?: string;
  options: OptionColumn[];
}

export interface Config {
  sheet: {
    source: "file" | "google";
    fileId: string; // StoredFile id when source = file
    google_sheet: string;
    worksheet: string;
    header_row: number; // 0 = find it automatically
  };
  images: {
    source: "none" | "upload" | "drive";
    drive_folder: string;
    mode: ImageMode;
    extensions: string[];
    skippedReason: string;
  };
  match: {
    rules: MatchRule[];
    create_missing: boolean;
    new_product_status: string;
  };
  columns: Columns;
  options: {
    tags_mode: "append" | "replace";
    create_missing_collections: boolean;
    keep_unlisted_variants: boolean;
    concurrency: number;
  };
  metafields: MetafieldMap[];
}

// What is stored in Shop.settings: everything optional, filled in by normalizeConfig
export type Settings = {
  sheet?: Partial<Config["sheet"]>;
  images?: Partial<Omit<Config["images"], "source">> & { source?: string };
  match?: Partial<Omit<Config["match"], "rules">> & {
    rules?: Partial<MatchRule>[];
    find_by?: string; // older settings had only this
  };
  columns?: Partial<Omit<Columns, "options">> & {
    options?: (string | Partial<OptionColumn> | null)[];
  };
  options?: Partial<Config["options"]>;
  metafields?: Partial<MetafieldMap>[];
};

export class SettingsError extends Error {
  constructor(public problems: string[]) {
    super("Settings need attention:\n - " + problems.join("\n - "));
  }
}

const isMatchField = (f: unknown): f is MatchField => MATCH_FIELDS.includes(f as MatchField);

// Turns saved settings into a complete, validated config.
// requireAll = false skips validation (used to read the sheet before mapping is finished).
export function normalizeConfig(raw: Settings = {}, { requireAll = true } = {}): Config {
  const rawColumns = { ...raw.columns };
  // An empty dropdown means "do not use this column"
  for (const [k, v] of Object.entries(rawColumns)) if (v === "" || v == null) delete (rawColumns as Record<string, unknown>)[k];

  const c: Config = {
    sheet: { source: "file", fileId: "", google_sheet: "", worksheet: "", header_row: 0, ...raw.sheet },
    images: {
      drive_folder: "",
      mode: "append",
      extensions: ["jpg", "jpeg", "png", "webp", "gif"],
      ...raw.images,
      source: raw.images?.source === "local" ? "upload" : ((raw.images?.source as Config["images"]["source"]) ?? "none"),
      skippedReason: "",
    },
    match: {
      create_missing: false,
      new_product_status: "DRAFT",
      ...raw.match,
      rules: [],
    },
    columns: { ...(rawColumns as Omit<Columns, "options">), options: [] },
    options: {
      tags_mode: "append",
      create_missing_collections: false,
      keep_unlisted_variants: true,
      concurrency: 4,
      ...raw.options,
    },
    metafields: [],
  };

  c.sheet.header_row = Number(c.sheet.header_row) || 0;
  c.options.concurrency = Math.min(8, Math.max(1, Number(c.options.concurrency) || 4));
  c.match.new_product_status = String(c.match.new_product_status || "DRAFT").toUpperCase();

  // Drop half-filled metafield rows (added in the form but left empty)
  c.metafields = (raw.metafields || [])
    .filter((m) => m && (m.column || m.key))
    .map((m) => ({ column: m.column || "", namespace: m.namespace || "", key: m.key || "", type: m.type || "" }));
  // options can be ["Colour"] or [{column: "Colour", name: "Color"}]
  c.columns.options = (rawColumns.options || [])
    .filter((o): o is string | Partial<OptionColumn> => !!o)
    .map((o) => (typeof o === "string" ? { column: o, name: o } : { column: o.column || "", name: o.name || o.column || "" }))
    .filter((o) => o.column);

  // How to find each product in Shopify: an ordered list of { field, column }. The first rule that finds
  // exactly one product wins. Older settings only had find_by; turn that into rules, then add the
  // other identifier columns as fallbacks so a product can still be found if one of them is empty.
  let rules = (raw.match?.rules || []).filter(
    (r): r is MatchRule => !!r && isMatchField(r.field) && !!r.column,
  );
  if (!rules.length) {
    const order = [raw.match?.find_by || "sku", "sku", "handle", "title"].filter(
      (f, i, a): f is MatchField => isMatchField(f) && a.indexOf(f) === i,
    );
    const cols = c.columns as unknown as Record<string, string | undefined>;
    rules = order.filter((f) => cols[f]).map((f) => ({ field: f, column: cols[f]! }));
  }
  c.match.rules = rules
    .map((r) => ({ field: r.field, column: r.column }))
    .filter((r, i, a) => a.findIndex((x) => x.field === r.field && x.column === r.column) === i);

  // No image source given = simply do not touch images
  if (c.images.source === "drive" && !c.images.drive_folder) {
    c.images.source = "none";
    c.images.skippedReason = "Images are set to Google Drive but no folder link was given, so images are skipped.";
  }

  if (!requireAll) return c;

  const errors: string[] = [];
  if (c.sheet.source === "file" ? !c.sheet.fileId : !c.sheet.google_sheet) {
    errors.push("Add a product sheet (a file or a Google Sheet link).");
  }
  if (!c.match.rules.length) {
    errors.push('Choose at least one column to find products in Shopify with (for example SKU, Handle or Title) in "Find products in Shopify".');
  }
  if (!IMAGE_MODES.includes(c.images.mode)) errors.push(`Image mode must be one of: ${IMAGE_MODES.join(", ")}`);
  if (!["upload", "drive", "none"].includes(c.images.source)) errors.push('Image source must be "upload", "drive" or "none".');
  if (!["append", "replace"].includes(c.options.tags_mode)) errors.push('Tags mode must be "append" or "replace".');
  if (!["ACTIVE", "DRAFT", "ARCHIVED"].includes(c.match.new_product_status)) {
    errors.push("New product status must be ACTIVE, DRAFT or ARCHIVED.");
  }
  for (const [i, m] of c.metafields.entries()) {
    if (!m.column || !m.namespace || !m.key || !m.type) errors.push(`Metafield ${i + 1} needs a column, namespace, key and type.`);
  }
  if (errors.length) throw new SettingsError(errors);
  return c;
}

// Settings sent by the browser, reduced to known fields of the right type and size before they are
// saved. Half-filled rows (a rule without a column yet) are kept so the form shows them again.
const COLUMN_KEYS = [
  "product_key", "image_key", "image_alt", "title", "handle", "description", "seo_title", "seo_description",
  "vendor", "product_type", "tags", "collections", "status", "price", "compare_at_price", "sku", "barcode",
] as const;

export function cleanSettings(raw: unknown): Settings {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
  const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
  const r = obj(raw);
  const sheet = obj(r.sheet);
  const images = obj(r.images);
  const match = obj(r.match);
  const columns = obj(r.columns);
  const options = obj(r.options);

  const cols: NonNullable<Settings["columns"]> = {};
  for (const k of COLUMN_KEYS) if (str(columns[k])) cols[k] = str(columns[k]);
  cols.options = list(columns.options, 20)
    .map((o) => (typeof o === "string" ? { column: str(o), name: str(o) } : { column: str(obj(o).column), name: str(obj(o).name) || str(obj(o).column) }))
    .filter((o) => o.column);

  return {
    sheet: {
      source: oneOf(sheet.source, ["file", "google"] as const, "file"),
      fileId: str(sheet.fileId, 50),
      google_sheet: str(sheet.google_sheet, 500),
      worksheet: str(sheet.worksheet),
      header_row: Math.min(1000, Math.max(0, Math.floor(Number(sheet.header_row) || 0))),
    },
    images: {
      source: oneOf(images.source, ["none", "upload", "drive"] as const, "none"),
      drive_folder: str(images.drive_folder, 500),
      mode: oneOf(images.mode, IMAGE_MODES, "append"),
    },
    match: {
      rules: list(match.rules, 10).map((x) => ({
        field: oneOf(obj(x).field, MATCH_FIELDS, "sku"),
        column: str(obj(x).column),
      })),
      create_missing: match.create_missing === true,
      new_product_status: oneOf(match.new_product_status, ["DRAFT", "ACTIVE"] as const, "DRAFT"),
    },
    columns: cols,
    options: {
      tags_mode: oneOf(options.tags_mode, ["append", "replace"] as const, "append"),
      create_missing_collections: options.create_missing_collections === true,
      keep_unlisted_variants: options.keep_unlisted_variants !== false,
      concurrency: Math.min(8, Math.max(1, Math.floor(Number(options.concurrency) || 4))),
    },
    metafields: list(r.metafields, 50).map((m) => ({
      column: str(obj(m).column),
      namespace: str(obj(m).namespace, 100),
      key: str(obj(m).key, 100),
      type: str(obj(m).type, 100),
    })),
  };
}

// Every sheet column the config refers to (used to check they exist in the sheet)
export function mappedColumns(c: Config): string[] {
  const cols = new Set<string>();
  for (const [k, v] of Object.entries(c.columns)) {
    if (k === "options") continue;
    if (typeof v === "string" && v) cols.add(v);
  }
  c.columns.options.forEach((o) => cols.add(o.column));
  c.metafields.forEach((m) => cols.add(m.column));
  c.match.rules.forEach((r) => cols.add(r.column));
  return [...cols];
}
