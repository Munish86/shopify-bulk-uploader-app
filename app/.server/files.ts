// Sheets and images merchants upload. The bytes go to file storage, a StoredFile row keeps the
// original name. A file name is only ever shown and matched on; it never becomes a storage path.
import prisma from "../db.server";
import { MAX_SHEET_BYTES, type SheetSource } from "./core/sheet";
import type { Config } from "./core/config";
import { getSettings, saveSettings } from "./shops";
import { fileKey, FileMissingError, getStorage } from "./storage";

export type FileKind = "sheet" | "image";

export const LIMITS = {
  imageBytes: 20 * 1024 * 1024, // Shopify's own limit for product images
  sheetBytes: MAX_SHEET_BYTES,
  imagesPerShop: 5000,
  imageBytesPerShop: 3 * 1024 * 1024 * 1024,
};

const SHEET_EXT = /\.(xlsx|xlsm|xls|csv|txt)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic)$/i;
const MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  txt: "text/plain",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
};

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// "C:\\photos\\Sofas\\Oslo_1.jpg" or "photos/Sofas/Oslo_1.jpg" -> "photos/Sofas/Oslo_1.jpg" (kept for display only)
export function cleanName(raw: string): string {
  const parts = String(raw ?? "")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..");
  const name = parts.join("/");
  return name.length > 300 ? name.slice(-300) : name;
}

export function checkUpload(kind: string, rawName: string, size: number): { kind: FileKind; name: string; mime: string } {
  if (kind !== "sheet" && kind !== "image") throw new UploadError('kind must be "sheet" or "image".');
  const name = cleanName(rawName);
  if (!name) throw new UploadError("The file has no name.");
  const ext = name.split(".").pop()!.toLowerCase();
  if (kind === "sheet" && !SHEET_EXT.test(name)) throw new UploadError(`"${name}" is not an Excel or CSV file.`);
  if (kind === "image" && !IMAGE_EXT.test(name)) throw new UploadError(`"${name}" is not an image (jpg, png, webp, gif, avif, heic).`);
  if (!Number.isFinite(size) || size <= 0) throw new UploadError(`"${name}" is empty.`);
  const max = kind === "sheet" ? LIMITS.sheetBytes : LIMITS.imageBytes;
  if (size > max) throw new UploadError(`"${name}" is ${(size / 1024 / 1024).toFixed(1)} MB. The limit is ${max / 1024 / 1024} MB.`, 413);
  return { kind, name, mime: MIME[ext] || "application/octet-stream" };
}

export async function saveUpload(shop: string, kindRaw: string, rawName: string, data: Buffer) {
  const { kind, name, mime } = checkUpload(kindRaw, rawName, data.length);

  // Uploading again replaces: a new sheet replaces the old one, an image replaces one with the same name
  const replaced = await prisma.storedFile.findMany({
    where: kind === "sheet" ? { shop, kind } : { shop, kind, name },
    select: { id: true, storageKey: true, size: true },
  });

  if (kind === "image") {
    const totals = await prisma.storedFile.aggregate({ where: { shop, kind }, _count: true, _sum: { size: true } });
    const freed = replaced.reduce((n, r) => n + r.size, 0);
    if (totals._count - replaced.length + 1 > LIMITS.imagesPerShop) {
      throw new UploadError(`You can upload up to ${LIMITS.imagesPerShop} images. Remove some first.`, 413);
    }
    if ((totals._sum.size || 0) - freed + data.length > LIMITS.imageBytesPerShop) {
      throw new UploadError(`Uploaded images may total ${LIMITS.imageBytesPerShop / 1024 ** 3} GB. Remove some first.`, 413);
    }
  }

  const row = await prisma.storedFile.create({
    data: { shop, kind, name, size: data.length, mime, storageKey: "" },
  });
  const key = fileKey(shop, row.id);
  try {
    await getStorage().put(key, data, mime);
  } catch (e) {
    await prisma.storedFile.delete({ where: { id: row.id } });
    throw e;
  }
  const file = await prisma.storedFile.update({ where: { id: row.id }, data: { storageKey: key } });

  for (const r of replaced) await removeFile(shop, r.id, r.storageKey);

  // The uploaded sheet becomes the shop's sheet
  if (kind === "sheet") {
    const settings = await getSettings(shop);
    await saveSettings(shop, { ...settings, sheet: { ...settings.sheet, source: "file", fileId: file.id } });
  }
  return { id: file.id, kind, name: file.name, size: file.size };
}

async function removeFile(shop: string, id: string, storageKey: string) {
  await prisma.storedFile.deleteMany({ where: { id, shop } });
  if (storageKey) await getStorage().delete(storageKey);
}

export async function listFiles(shop: string, kind: FileKind) {
  return prisma.storedFile.findMany({
    where: { shop, kind },
    select: { id: true, name: true, size: true, createdAt: true },
    orderBy: { name: "asc" },
  });
}

// id = one file; no id = every file of that kind
export async function deleteFiles(shop: string, kind: FileKind, id?: string) {
  const rows = await prisma.storedFile.findMany({
    where: { shop, kind, ...(id ? { id } : {}) },
    select: { id: true, storageKey: true },
  });
  for (const r of rows) await removeFile(shop, r.id, r.storageKey);
  return rows.length;
}

// Where the run reads the sheet from: the uploaded file, or the Google Sheet link
export async function sheetSource(shop: string, cfg: Config): Promise<SheetSource> {
  if (cfg.sheet.source === "google") return { kind: "google", url: cfg.sheet.google_sheet };
  const row = await prisma.storedFile.findFirst({ where: { shop, kind: "sheet", id: cfg.sheet.fileId } });
  const again = "The uploaded sheet is no longer available (files are kept for a limited time). Upload it again.";
  if (!row?.storageKey) throw new Error(again);
  try {
    return { kind: "file", name: row.name, data: await getStorage().get(row.storageKey) };
  } catch (e) {
    if (e instanceof FileMissingError) throw new Error(again);
    throw e;
  }
}
