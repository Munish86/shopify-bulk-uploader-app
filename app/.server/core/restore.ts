// Undo a run: puts products back the way the backup taken before that run saved them.
// Only what the run changed is put back (for example only the description and meta title), so later
// edits to other fields (price, stock...) are kept. Before saving, the current state is backed up again
// (through deps.saveUndo), so a restore can be undone the same way.
//   preview (apply: false) -> report what would be put back, save nothing
//   apply                  -> save
import { RESTORABLE, isRestorable, type BackupData, type BackupInfo } from "./backup";
import type { ReportRow, RunResult, Progress } from "./runner";
import type { MetafieldValue, Shopify, ShopifyProduct } from "./shopify";
import { formatDuration, norm, pool } from "./util";

export const RESTORE_ACTIONS = {
  WILL: "Will restore",
  DONE: "Restored",
  SAME: "Already same as backup",
  GONE: "Not found in Shopify",
  SKIPPED: "Skipped",
  ERROR: "Error",
} as const;

const FIELD_LABEL: Record<string, string> = {
  title: "title",
  descriptionHtml: "description",
  vendor: "vendor",
  productType: "type",
  status: "status",
  seo: "meta title/description",
  tags: "tags",
  variants: "variants",
};
// Backups without `_backup` (taken before it existed): what the run changed is not known
const GUESS_FIELDS = RESTORABLE.filter((f) => f !== "variants");

export interface RestoreDeps {
  shopify: Shopify;
  items: BackupData[]; // the backup of one run
  finishedAt: Date; // when that run ended; products changed after it get a note
  saveUndo(product: ShopifyProduct, info: BackupInfo): Promise<void>;
  // After a product is restored: forget that its sheet row was uploaded, and the images that were removed
  afterRestore(key: string | undefined, productId: string, imagesRemoved: boolean): Promise<void>;
}

export interface RestoreOptions {
  apply?: boolean;
  only?: string; // titles, handles or product keys, comma separated
  skipEdited?: boolean;
  concurrency?: number;
  log?: (m: string) => void;
  progress?: (p: Progress) => void;
  shouldStop?: () => boolean;
}

type Meta = Omit<BackupInfo, "version" | "kind" | "key"> & { key?: string; guessed?: boolean };

const sameMoney = (a: unknown, b: unknown) =>
  (a == null || a === "" ? null : Number(a)) === (b == null || b === "" ? null : Number(b));
const tagKey = (tags?: string[]) => (tags || []).map((t) => t.toLowerCase()).sort().join("|");
const s = (v: unknown) => (v == null ? "" : String(v));

export interface ProductDiff {
  input: Record<string, unknown>;
  variants: Record<string, unknown>[];
  mfSet: { namespace: string; key: string; type: string; value: string }[];
  mfDelete: { namespace: string; key: string; type: string }[];
  colAdd: { id: string; title: string }[];
  colRemove: { id: string; title: string }[];
  mediaDelete: string[];
  mediaReadd: { url: string; alt: string }[];
  changes: string[];
  warnings: string[];
}

// Works out what to send so that the things the run changed look like the backup again
export function diffProduct(b: BackupData, cur: ShopifyProduct, meta: Meta, curMf: MetafieldValue[]): ProductDiff {
  const fields: string[] = meta.fields;
  const input: Record<string, unknown> = {};
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const f of ["title", "descriptionHtml", "vendor", "productType", "status"] as const) {
    if (fields.includes(f) && s(b[f]) !== s(cur[f])) {
      input[f] = s(b[f]);
      changes.push(FIELD_LABEL[f]);
    }
  }
  if (fields.includes("seo")) {
    const seo = { title: s(b.seo?.title), description: s(b.seo?.description) };
    if (seo.title !== s(cur.seo?.title) || seo.description !== s(cur.seo?.description)) {
      input.seo = seo;
      changes.push(FIELD_LABEL.seo);
    }
  }
  if (fields.includes("tags") && tagKey(b.tags) !== tagKey(cur.tags)) {
    input.tags = b.tags || [];
    changes.push("tags");
  }

  const variants: Record<string, unknown>[] = [];
  if (fields.includes("variants")) {
    const curById = new Map(cur.variants.map((v) => [v.id, v]));
    const opt = (v: ShopifyProduct["variants"][number]) => v.selectedOptions.map((o) => `${o.name}=${o.value}`).join("|");
    let missing = 0;
    for (const bv of b.variants || []) {
      const cv = curById.get(bv.id);
      if (!cv) {
        missing++;
        continue;
      }
      const u: Record<string, unknown> = { id: bv.id };
      if (!sameMoney(bv.price, cv.price)) u.price = bv.price;
      if (!sameMoney(bv.compareAtPrice, cv.compareAtPrice)) u.compareAtPrice = bv.compareAtPrice ?? null;
      if (s(bv.barcode) !== s(cv.barcode)) u.barcode = s(bv.barcode);
      if (s(bv.sku) !== s(cv.sku)) u.inventoryItem = { sku: s(bv.sku) };
      if (Object.keys(u).length > 1) variants.push(u);
      if (opt(bv) !== opt(cv)) warnings.push(`Variant ${bv.sku || bv.id} has different options now (${opt(cv)}); options are not changed back`);
    }
    if (variants.length) changes.push(`${variants.length} variants (price, SKU, barcode)`);
    const added = cur.variants.filter((v) => !(b.variants || []).some((x) => x.id === v.id));
    if (added.length) {
      warnings.push(
        `${added.length} variants added since the backup were kept (${added.map((v) => v.sku || v.id).join(", ")}); delete them in Shopify if they are not wanted`,
      );
    }
    if (missing) warnings.push(`${missing} variants from the backup no longer exist and cannot be brought back`);
  }

  const mfSet: ProductDiff["mfSet"] = [];
  const mfDelete: ProductDiff["mfDelete"] = [];
  for (const m of meta.metafields || []) {
    const now = curMf.find((x) => x.namespace === m.namespace && x.key === m.key);
    if (m.value === null && now) mfDelete.push(m);
    else if (m.value !== null && now?.value !== m.value) mfSet.push({ namespace: m.namespace, key: m.key, type: m.type, value: m.value });
  }
  if (mfSet.length || mfDelete.length) {
    changes.push(`metafields: ${[...mfSet, ...mfDelete].map((m) => `${m.namespace}.${m.key}`).join(", ")}`);
  }

  const touched = new Set((meta.collections || []).map(norm));
  const manual = (c: { ruleSet: unknown }) => !c.ruleSet;
  const colAdd = (b.collections || []).filter(
    (c) => manual(c) && touched.has(norm(c.title)) && !cur.collections.some((x) => x.id === c.id),
  );
  const colRemove = cur.collections.filter(
    (c) => manual(c) && touched.has(norm(c.title)) && !(b.collections || []).some((x) => x.id === c.id),
  );
  if (colAdd.length) changes.push(`added back to: ${colAdd.map((c) => c.title).join(", ")}`);
  if (colRemove.length) changes.push(`removed from: ${colRemove.map((c) => c.title).join(", ")}`);

  let mediaDelete: string[] = [];
  let mediaReadd: ProductDiff["mediaReadd"] = [];
  const isImg = (m: { mediaContentType: string }) => m.mediaContentType === "IMAGE";
  if (meta.imagesAdded) {
    const extra = cur.media.filter((m) => isImg(m) && !(b.media || []).some((x) => x.id === m.id));
    if (extra.length && extra.length <= meta.imagesAdded) {
      mediaDelete = extra.map((m) => m.id);
      changes.push(`${extra.length} images added by the upload removed`);
    } else if (extra.length) {
      warnings.push(
        `The product has ${extra.length} images that are not in the backup, but the upload added ${meta.imagesAdded}; images were not touched, check them in Shopify`,
      );
    }
  }
  if (meta.imagesReplaced) {
    mediaReadd = (b.media || [])
      .filter((m) => isImg(m) && m.image?.url && !cur.media.some((x) => x.id === m.id))
      .map((m) => ({ url: m.image!.url, alt: m.alt || b.title }));
    if (mediaReadd.length) changes.push(`${mediaReadd.length} old images put back from their old links (check them: Shopify may have deleted the files)`);
  }

  return {
    input,
    variants,
    mfSet,
    mfDelete,
    colAdd: colAdd.map((c) => ({ id: c.id, title: c.title })),
    colRemove: colRemove.map((c) => ({ id: c.id, title: c.title })),
    mediaDelete,
    mediaReadd,
    changes,
    warnings,
  };
}

export async function restoreRun(deps: RestoreDeps, opts: RestoreOptions = {}): Promise<RunResult> {
  const { shopify: shop } = deps;
  const apply = !!opts.apply;
  const log = opts.log || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  log(`=== ${apply ? "RESTORE" : "RESTORE PREVIEW"} started ===`);
  if (!apply) log("(This step does not save anything to Shopify)");

  const metaOf = (b: BackupData): Meta =>
    b._backup || { fields: [...GUESS_FIELDS], metafields: [], collections: [], imagesAdded: 0, imagesReplaced: false, guessed: true };
  let items = [...deps.items];
  if (opts.only) {
    const wanted = opts.only.split(",").map(norm).filter(Boolean);
    items = items.filter((b) => [b.title, b.handle, metaOf(b).key].some((v) => wanted.includes(norm(v))));
  }
  items.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  log(`Products in this backup: ${items.length}`);
  const info = await shop.shopInfo();
  log(`Shopify store: ${info.name} (${info.myshopifyDomain})`);

  const results: ReportRow[] = new Array(items.length);
  const total = items.length;
  const started = Date.now();
  let done = 0;
  opts.progress?.({ done: 0, total, elapsedMs: 0, etaMs: 0 });

  async function one(b: BackupData, i: number) {
    const meta = metaOf(b);
    const row: ReportRow = { product_key: meta.key || b.handle, title: b.title, shopify_link: shop.adminUrl(b.id) };
    const tag = `[${i + 1}/${total}] ${b.title}`;
    try {
      const cur = await shop.getProduct(b.id);
      if (!cur) {
        results[i] = { ...row, action: RESTORE_ACTIONS.GONE, warnings: "The product was deleted from Shopify" };
        log(`${tag}: not found in Shopify`);
        return;
      }
      const curMf = meta.metafields?.length ? await shop.getMetafields(b.id) : [];
      const d = diffProduct(b, cur, meta, curMf);
      if (meta.guessed) d.warnings.unshift("What this upload changed is not known, so every saved field that differs is put back");
      const editedLater = !!cur.updatedAt && new Date(cur.updatedAt).getTime() > deps.finishedAt.getTime() + 5000;
      if (editedLater) d.warnings.unshift(`Changed in Shopify after this upload (${cur.updatedAt!.slice(0, 16).replace("T", " ")} UTC)`);
      Object.assign(row, { changes: d.changes.join(", "), warnings: d.warnings.join(" ; ") });

      if (!d.changes.length) row.action = RESTORE_ACTIONS.SAME;
      else if (editedLater && opts.skipEdited) row.action = RESTORE_ACTIONS.SKIPPED;
      else row.action = apply ? RESTORE_ACTIONS.DONE : RESTORE_ACTIONS.WILL;
      if (!apply || row.action !== RESTORE_ACTIONS.DONE) {
        results[i] = row;
        log(`${tag}: ${row.action}${d.changes.length ? ` (${row.changes})` : ""}`);
        return;
      }

      // Back up what is there now, so this restore can be undone too
      await deps.saveUndo(cur, {
        version: 2,
        kind: "restore",
        key: meta.key || b.handle,
        fields: [...Object.keys(d.input), ...(d.variants.length ? ["variants"] : [])].filter(isRestorable),
        metafields: [...d.mfSet, ...d.mfDelete].map((m) => {
          const now = curMf.find((x) => x.namespace === m.namespace && x.key === m.key);
          return { namespace: m.namespace, key: m.key, type: now?.type || m.type, value: now ? now.value : null };
        }),
        collections: [...d.colAdd, ...d.colRemove].map((c) => c.title),
        imagesAdded: 0,
        imagesReplaced: false,
      });
      if (Object.keys(d.input).length) await shop.productUpdate({ id: b.id, ...d.input });
      if (d.variants.length) await shop.variantsBulkUpdate(b.id, d.variants);
      if (d.mfSet.length) await shop.metafieldsSet(b.id, d.mfSet);
      if (d.mfDelete.length) await shop.metafieldsDelete(b.id, d.mfDelete);
      for (const c of d.colAdd) await shop.addToCollection(c.id, b.id);
      for (const c of d.colRemove) await shop.removeFromCollection(c.id, b.id);
      if (d.mediaDelete.length) await shop.deleteFiles(d.mediaDelete);
      if (d.mediaReadd.length) {
        await shop.productUpdate(
          { id: b.id },
          d.mediaReadd.map((m) => ({ originalSource: m.url, alt: m.alt, mediaContentType: "IMAGE" as const })),
        );
      }
      await deps.afterRestore(meta.key, b.id, d.mediaDelete.length > 0);
      results[i] = row;
      log(`${tag}: Restored (${row.changes})`);
    } catch (e) {
      results[i] = { ...row, action: RESTORE_ACTIONS.ERROR, error: (e as Error).message };
      log(`${tag}: ERROR - ${(e as Error).message}`);
    }
  }

  await pool(
    items,
    opts.concurrency || 4,
    async (b, i) => {
      await one(b, i);
      done++;
      const elapsedMs = Date.now() - started;
      opts.progress?.({ done, total, elapsedMs, etaMs: (elapsedMs / done) * (total - done) });
    },
    shouldStop,
  );

  const stopped = shouldStop() && done < total;
  if (stopped) log(`Stopped. ${total - done} products were not processed.`);
  log(`Time taken: ${formatDuration(Date.now() - started)}`);
  const report = results.filter(Boolean);
  const counts: Record<string, number> = {};
  for (const r of report) counts[r.action!] = (counts[r.action!] || 0) + 1;
  log("--- Summary ---");
  for (const [k, v] of Object.entries(counts)) log(`  ${k}: ${v}`);
  return { report, counts, unmatched: [], details: {}, stopped, store: info.myshopifyDomain };
}
