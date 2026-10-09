// The real work happens here. The background worker calls runJob for each queued job.
//   check -> match sheet rows to image files only (does not touch Shopify)
//   plan  -> compare with Shopify and report what would change (saves nothing)
//   apply -> save the changes to Shopify
// runJob does not touch files or the database itself: the caller passes in where the sheet and images
// come from (`sources`) and where to remember progress (`store`), so it runs the same in the app and in tests.
import crypto from "node:crypto";
import { groupRows, buildProduct, lookupValues, firstVal, type ExistingProduct, type Group } from "./build";
import { mappedColumns, type Config } from "./config";
import type { Google } from "./google";
import { buildIndex, findImages, listImages, alreadyOnProduct, type ImageFile } from "./images";
import { loadRows, type SheetSource } from "./sheet";
import type { Collection, Shopify, ShopifyProduct } from "./shopify";
import { norm, pool, formatDuration, toCsv } from "./util";

export const COMMANDS = ["check", "plan", "apply"] as const;
export type Command = (typeof COMMANDS)[number];

export const ACTIONS = {
  IMAGES_FOUND: "Images found",
  NO_IMAGES: "No images found",
  OK: "OK",
  NOT_FOUND: "Not found in Shopify",
  DONE_BEFORE: "Already done",
  NO_CHANGE: "No changes",
  WILL_UPDATE: "Will update",
  WILL_CREATE: "Will create",
  UPDATED: "Updated",
  CREATED: "Created",
  ERROR: "Error",
} as const;

export const REPORT_HEADERS = [
  "sheet_rows", "product_key", "title", "action", "found_by", "shopify_link", "images_found", "images_new", "image_files",
  "changes", "tags_added", "collections", "metafields", "variants", "warnings", "error",
] as const;

export type ReportRow = Partial<Record<(typeof REPORT_HEADERS)[number], string | number>> & {
  product_key: string;
  action?: string;
};

export const reportCsv = (report: ReportRow[]) => toCsv(report, REPORT_HEADERS);

// Remembers what was done in earlier runs, per shop. Backed by the database in the app.
export interface RunStore {
  getFingerprint(productKey: string): Promise<string | null>;
  setFingerprint(productKey: string, fingerprint: string): Promise<void>;
  getUploaded(productId: string): Promise<string[]>;
  addUploaded(productId: string, imageUids: string[]): Promise<void>;
  saveBackup(product: ShopifyProduct): Promise<void>;
}

export interface Progress {
  done: number;
  total: number;
  elapsedMs: number;
  etaMs: number;
}

export interface RunOptions {
  log?: (msg: string) => void;
  progress?: (p: Progress) => void;
  shouldStop?: () => boolean;
  only?: string; // comma separated product keys
  limit?: number;
  force?: boolean; // re-send products that were already uploaded
}

export interface RunDeps {
  cfg: Config;
  sheet: SheetSource;
  uploadedImages: () => Promise<ImageFile[]>;
  google: Google;
  shopify?: Shopify; // not needed for "check"
  store: RunStore;
}

// An image in the report: uid is "upload:<StoredFile id>" for uploaded files, "drive:<id>" for Drive
export interface ImageRef {
  name: string;
  where: string;
  uid: string;
}
const imageRef = (f: ImageFile): ImageRef => ({ name: f.name, where: f.where, uid: f.uid });

export interface RunResult {
  report: ReportRow[];
  counts: Record<string, number>;
  unmatched: ImageRef[];
  details: Record<string, ImageRef[]>; // images matched to each product key
  stopped?: boolean;
  store?: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type RunGroup = Group & { images: ImageFile[] };

export async function runJob(cmd: Command, deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
  const { cfg, google, store } = deps;
  const log = opts.log || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  if (!COMMANDS.includes(cmd)) throw new Error(`Unknown command "${cmd}". Use check, plan or apply.`);

  log(`=== ${cmd.toUpperCase()} started ===`);
  if (cmd !== "apply") log("(This step does not save anything to Shopify)");

  // 1. Sheet
  const { headers, rows, headerRow, duplicateHeaders } = await loadRows(deps.sheet, cfg.sheet, google);
  log(`Sheet: ${rows.length} rows read (column names taken from row ${headerRow})`);
  if (duplicateHeaders.length) log(`Note: these column names appear twice, the first one is used: ${duplicateHeaders.join(", ")}`);
  const missing = mappedColumns(cfg).filter((c) => !headers.includes(c));
  if (missing.length) {
    throw new Error(
      `These columns were not found in the sheet: ${missing.join(", ")}\nSheet columns: ${headers.filter(Boolean).join(", ")}`,
    );
  }

  const grouped = groupRows(rows, cfg);
  let groups = grouped.groups as RunGroup[];
  const skipped = grouped.skipped;
  const findWith = cfg.match.rules.map((r) => `${r.field.toUpperCase()} from "${r.column}"`).join(", then ");
  log(`Finding products by ${findWith}`);
  if (skipped.length) {
    const cols = [cfg.columns.product_key, ...cfg.match.rules.map((r) => r.column)].filter(Boolean);
    log(
      `${skipped.length} rows were skipped because ${cols.map((c) => `"${c}"`).join(" and ")} ${cols.length > 1 ? "are all" : "is"} empty ` +
        `(rows ${skipped.slice(0, 15).join(", ")}${skipped.length > 15 ? "..." : ""})`,
    );
  }
  if (opts.only) groups = groups.filter((g) => String(opts.only).split(",").some((o) => norm(o) === norm(g.key)));
  if (opts.limit) groups = groups.slice(0, Number(opts.limit));
  log(`Products: ${groups.length}`);

  // 2. Images
  let files: ImageFile[] = [];
  if (cfg.images.skippedReason) log(cfg.images.skippedReason);
  else if (cfg.images.source === "none") log("Images: none added, so product images are not changed");
  if (cfg.images.source !== "none") {
    files = await listImages(cfg, google, deps.uploadedImages);
    log(`Images: ${files.length} files found (${cfg.images.source === "drive" ? "Google Drive" : "uploaded files"})`);
  }
  const index = buildIndex(files);
  const imageCol = cfg.columns.image_key || cfg.columns.product_key;
  const usedBy = new Map<string, string[]>();
  for (const g of groups) {
    const seen = new Set<string>();
    g.images = [];
    for (const r of g.rows) {
      for (const f of findImages(index, imageCol ? r[imageCol] : "")) {
        if (seen.has(f.uid)) continue;
        seen.add(f.uid);
        g.images.push(f);
        if (!usedBy.has(f.uid)) usedBy.set(f.uid, []);
        usedBy.get(f.uid)!.push(g.key);
      }
    }
  }
  const unmatched = files.filter((f) => !usedBy.has(f.uid)).map((f) => imageRef(f));
  const shared = [...usedBy.entries()].filter(([, keys]) => keys.length > 1);
  if (cfg.images.source !== "none") {
    const noImg = groups.filter((g) => !g.images.length).length;
    log(`${groups.length - noImg} products have images, ${noImg} have none, ${unmatched.length} image files match no product`);
    if (shared.length) log(`Note: ${shared.length} image files match more than one product`);
  }
  const details: RunResult["details"] = {};
  for (const g of groups) details[g.key] = g.images.map((f) => imageRef(f));

  const results: ReportRow[] = new Array(groups.length);
  const base = (g: RunGroup): ReportRow => ({
    sheet_rows: g.rows.map((r) => r.__row).join(" "),
    product_key: g.key,
    title: firstVal(g.rows, cfg.columns.title),
    images_found: g.images.length,
    image_files: g.images.map((f) => f.name).join(" | "),
  });
  const finish = (extra: Partial<RunResult> = {}): RunResult => {
    const report = results.filter(Boolean);
    const counts: Record<string, number> = {};
    for (const r of report) counts[r.action!] = (counts[r.action!] || 0) + 1;
    log("--- Summary ---");
    for (const [k, v] of Object.entries(counts)) log(`  ${k}: ${v}`);
    return { report, counts, unmatched, details, ...extra };
  };

  if (cmd === "check") {
    groups.forEach((g, i) => {
      const sh = g.images.filter((f) => usedBy.get(f.uid)!.length > 1).map((f) => f.name);
      results[i] = {
        ...base(g),
        action: cfg.images.source === "none" ? ACTIONS.OK : g.images.length ? ACTIONS.IMAGES_FOUND : ACTIONS.NO_IMAGES,
        warnings: sh.length ? `These images also match other products: ${sh.join(", ")}` : "",
      };
    });
    return finish();
  }

  // 3. Shopify
  const shop = deps.shopify;
  if (!shop) throw new Error("Not connected to Shopify.");
  const info = await shop.shopInfo();
  log(`Shopify store: ${info.name} (${info.myshopifyDomain})`);
  const collections = cfg.columns.collections ? await shop.loadCollections() : new Map<string, Collection>();
  const creatingCollections = new Map<string, Promise<Collection>>(); // so parallel workers create a collection once
  const locks = new Map<string, Promise<void>>(); // product id -> promise, so one product is never changed by two workers at once

  const total = groups.length;
  const started = Date.now();
  let done = 0;
  const tick = () => {
    done++;
    const elapsedMs = Date.now() - started;
    opts.progress?.({ done, total, elapsedMs, etaMs: done ? (elapsedMs / done) * (total - done) : 0 });
  };
  opts.progress?.({ done: 0, total, elapsedMs: 0, etaMs: 0 });
  const workers = cfg.options.concurrency;
  if (workers > 1) log(`Working on ${workers} products at a time`);

  const getCollection = async (title: string) => {
    const key = norm(title);
    const known = collections.get(key);
    if (known) return known;
    if (!creatingCollections.has(key)) {
      creatingCollections.set(
        key,
        shop.createCollection(title).then((col) => (collections.set(key, col), col)),
      );
    }
    return creatingCollections.get(key)!;
  };

  async function processOne(g: RunGroup, i: number) {
    const row = base(g);
    const tag = `[${i + 1}/${total}] ${g.key}`;
    const productKey = g.key.toLowerCase();
    const fp = crypto
      .createHash("sha1")
      .update(
        JSON.stringify({
          rows: g.rows.map(({ __row, ...r }) => r),
          img: g.images.map((f) => f.uid + ":" + f.size),
          mode: cfg.images.mode,
        }),
      )
      .digest("hex");
    let release = () => {};
    try {
      // Try each "find product" rule in order; the first one that finds a product wins
      let existing: ExistingProduct | null = null;
      let foundBy = "";
      const tried: string[] = [];
      for (const rule of cfg.match.rules) {
        const values = lookupValues(g, rule);
        if (!values.length) continue;
        tried.push(`${rule.field.toUpperCase()} "${values.join('", "')}"`);
        const found = await shop!.findProduct(rule.field, values);
        if (found.ambiguous) throw new Error(`Could not pick one product: ${found.ambiguous}`);
        if (found.product) {
          existing = { ...found.product, foundBy: rule };
          foundBy = `Found by ${rule.field.toUpperCase()}`;
          break;
        }
      }
      row.shopify_link = existing ? shop!.adminUrl(existing.id) : "";

      if (!existing && !cfg.match.create_missing) {
        results[i] = {
          ...row,
          action: ACTIONS.NOT_FOUND,
          warnings: tried.length
            ? `Searched by ${tried.join(", then ")}`
            : 'No value to search with: the "find product" columns are empty on this row',
        };
        log(`${tag}: not found in Shopify`);
        return;
      }

      // Two sheet groups can point at the same product: handle them one after the other
      if (existing) {
        const prev = locks.get(existing.id);
        let open!: () => void;
        const mine = new Promise<void>((r) => (open = r));
        locks.set(existing.id, (prev || Promise.resolve()).then(() => mine));
        release = open;
        if (prev) {
          await prev;
          const rule = existing.foundBy;
          const fresh = await shop!.getProduct(existing.id);
          if (fresh) existing = { ...fresh, foundBy: rule };
        }
      }
      if (cmd === "apply" && !opts.force && (await store.getFingerprint(productKey)) === fp) {
        results[i] = { ...row, action: ACTIONS.DONE_BEFORE, warnings: "The sheet row has not changed since the last upload" };
        return;
      }

      const plan = buildProduct(g, existing, cfg);

      // Images: which ones to upload
      const media = (existing?.media || []).filter((m) => m.mediaContentType === "IMAGE");
      const urls = media.map((m) => m.image?.url).filter((u): u is string => !!u);
      const uploadedBefore = new Set(existing ? await store.getUploaded(existing.id) : []);
      let upload: ImageFile[] = [];
      if (g.images.length) {
        if (cfg.images.mode === "skip_if_has_images" && media.length) {
          plan.warnings.push(`Product already has ${media.length} images, images skipped`);
        } else if (cfg.images.mode === "replace") upload = g.images;
        else upload = g.images.filter((f) => !uploadedBefore.has(f.uid) && !alreadyOnProduct(f, urls));
      }
      const tooBig = upload.filter((f) => f.size > MAX_IMAGE_BYTES);
      if (tooBig.length) {
        plan.warnings.push(`Images over 20 MB skipped: ${tooBig.map((f) => f.name).join(", ")}`);
        upload = upload.filter((f) => !tooBig.includes(f));
      }
      if (cfg.images.mode === "replace" && upload.length && media.length) plan.changes.push(`${media.length} old images removed`);

      // Collections
      const colAdd: { title: string; col: Collection | null }[] = [];
      for (const t of plan.collectionTitles) {
        const col = collections.get(norm(t));
        if (col?.smart) plan.warnings.push(`"${t}" is an automated (smart) collection; products join it through its rules`);
        else if (col && existing?.collections.some((x) => x.id === col.id)) continue;
        else if (col) colAdd.push({ title: t, col });
        else if (cfg.options.create_missing_collections) colAdd.push({ title: t, col: null });
        else plan.warnings.push(`Collection "${t}" does not exist in Shopify`);
      }

      const nothing = !plan.changes.length && !upload.length && !plan.metafields.length && !colAdd.length && !!existing;
      const action = !existing ? ACTIONS.WILL_CREATE : nothing ? ACTIONS.NO_CHANGE : ACTIONS.WILL_UPDATE;
      Object.assign(row, {
        action,
        images_new: upload.length,
        changes: plan.changes.join(", "),
        tags_added: plan.tagsAdded.join(", "),
        collections: colAdd.map((c) => (c.col ? c.title : `${c.title} (new)`)).join(", "),
        metafields: plan.metafields.map((m) => `${m.namespace}.${m.key}`).join(", "),
        variants: plan.variantSummary,
        warnings: plan.warnings.join(" ; "),
        found_by: foundBy,
      });

      if (cmd === "plan" || nothing) {
        if (cmd === "apply") await store.setFingerprint(productKey, fp);
        results[i] = row;
        log(`${tag}: ${action}${upload.length ? `, ${upload.length} images` : ""}`);
        return;
      }

      // ---- APPLY ----
      if (existing) {
        const { foundBy: _f, ...snapshot } = existing;
        await store.saveBackup(snapshot);
      }
      const alt = firstVal(g.rows, cfg.columns.image_alt) || plan.input.title || existing?.title || g.key;
      const staged: { f: ImageFile; url: string }[] = [];
      for (const f of upload) {
        const buf = await f.read();
        staged.push({ f, url: await shop!.stageImage(buf, f.name, f.mime) });
      }

      const input = { ...plan.input };
      const appendLater = !!existing && cfg.images.mode !== "replace";
      if (staged.length && !appendLater) {
        input.files = staged.map(({ f, url }) => ({ originalSource: url, alt, contentType: "IMAGE" as const, filename: f.name }));
      }
      let productId = existing?.id;
      if (!existing || Object.keys(input).some((k) => k !== "id")) {
        const saved = await shop!.productSet(input);
        productId = saved.id;
      }
      if (staged.length && appendLater) {
        await shop!.appendMedia(
          productId!,
          staged.map(({ url }) => ({ originalSource: url, alt, mediaContentType: "IMAGE" as const })),
        );
      }
      if (staged.length) await store.addUploaded(productId!, staged.map((s) => s.f.uid));
      if (plan.metafields.length) await shop!.metafieldsSet(productId!, plan.metafields);
      for (const c of colAdd) {
        const col = c.col || (await getCollection(c.title));
        await shop!.addToCollection(col.id, productId!);
      }
      await store.setFingerprint(productKey, fp);
      row.shopify_link = shop!.adminUrl(productId);
      row.action = existing ? ACTIONS.UPDATED : ACTIONS.CREATED;
      results[i] = row;
      log(`${tag}: ${row.action}${staged.length ? `, ${staged.length} images` : ""}`);
    } catch (e) {
      results[i] = { ...row, action: ACTIONS.ERROR, error: (e as Error).message };
      log(`${tag}: ERROR - ${(e as Error).message}`);
    } finally {
      release();
    }
  }

  await pool(
    groups,
    workers,
    async (g, i) => {
      await processOne(g, i);
      tick();
    },
    shouldStop,
  );

  const stopped = shouldStop() && done < total;
  if (stopped) log(`Stopped. ${total - done} products were not processed.`);
  log(`Time taken: ${formatDuration(Date.now() - started)}`);
  return finish({ stopped, store: info.myshopifyDomain });
}
