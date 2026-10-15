// What is saved with each product backup, next to the product itself: what the run is about to change,
// so a restore can put back exactly that (and leave later edits to other fields alone).
import type { ShopifyProduct } from "./shopify";

// Product fields a run can change and a restore can put back (keys of the productSet input)
export const RESTORABLE = ["title", "descriptionHtml", "vendor", "productType", "status", "seo", "tags", "variants"] as const;
export type RestorableField = (typeof RESTORABLE)[number];

export interface BackupInfo {
  version: 2;
  kind: "upload" | "restore";
  key: string; // product key from the sheet (or the handle)
  fields: RestorableField[];
  // Metafields the run sets, with their value before it (null = the metafield did not exist)
  metafields: { namespace: string; key: string; type: string; value: string | null }[];
  collections: string[]; // titles of collections the run adds the product to (or a restore changes)
  imagesAdded: number;
  imagesReplaced: boolean;
}

export type BackupData = ShopifyProduct & { _backup?: BackupInfo };

export const isRestorable = (k: string): k is RestorableField => (RESTORABLE as readonly string[]).includes(k);

// Two sheet groups can change the same product in one run: the first snapshot (the original) is kept
// and the lists of changed things are merged.
export function mergeBackupInfo(a: BackupInfo, b: BackupInfo): BackupInfo {
  const union = <T>(x: T[], y: T[]) => [...new Set([...x, ...y])];
  const metafields = [...a.metafields];
  for (const m of b.metafields) if (!metafields.some((x) => x.namespace === m.namespace && x.key === m.key)) metafields.push(m);
  return {
    ...a,
    fields: union(a.fields, b.fields),
    metafields,
    collections: union(a.collections, b.collections),
    imagesAdded: a.imagesAdded + b.imagesAdded,
    imagesReplaced: a.imagesReplaced || b.imagesReplaced,
  };
}
