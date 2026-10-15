// Database-backed memory of earlier runs for one shop (what was uploaded, backups, plan usage), used by runJob.
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { mergeBackupInfo, type BackupData, type BackupInfo } from "./core/backup";
import type { RunStore } from "./core/runner";
import type { ShopifyProduct } from "./core/shopify";
import { describeImage, type ImageFile } from "./core/images";
import { monthOf, planByKey } from "../lib/plans";
import { getStorage } from "./storage";

// Saves the product as it is now, with what the run is about to change. A second change to the same
// product in the same run keeps the first snapshot and merges the lists.
export async function saveProductBackup(shop: string, jobId: string | null, product: ShopifyProduct, info: BackupInfo) {
  const prev = jobId
    ? await prisma.productBackup.findFirst({ where: { shop, jobId, productId: product.id }, select: { id: true, data: true } })
    : null;
  const prevInfo = (prev?.data as BackupData | undefined)?._backup;
  if (prev && prevInfo) {
    const data = { ...(prev.data as object), _backup: mergeBackupInfo(prevInfo, info) };
    await prisma.productBackup.update({ where: { id: prev.id }, data: { data: data as unknown as Prisma.InputJsonValue } });
    return;
  }
  await prisma.productBackup.create({
    data: {
      shop,
      jobId,
      productId: product.id,
      handle: product.handle,
      data: { ...product, _backup: info } as unknown as Prisma.InputJsonValue,
    },
  });
}

// Takes one product from this month's allowance. A single conditional UPDATE, so parallel workers
// can never go over the limit.
export async function useQuota(shop: string): Promise<boolean> {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { plan: true } });
  const limit = planByKey(row?.plan).productsPerMonth;
  const month = monthOf();
  await prisma.usage.upsert({ where: { shop_month: { shop, month } }, create: { shop, month }, update: {} });
  if (limit == null) {
    await prisma.usage.update({ where: { shop_month: { shop, month } }, data: { products: { increment: 1 } } });
    return true;
  }
  const n = await prisma.$executeRaw`
    UPDATE "Usage" SET "products" = "products" + 1
    WHERE "shop" = ${shop} AND "month" = ${month} AND "products" < ${limit}`;
  return n > 0;
}

export async function releaseQuota(shop: string) {
  await prisma.$executeRaw`
    UPDATE "Usage" SET "products" = "products" - 1
    WHERE "shop" = ${shop} AND "month" = ${monthOf()} AND "products" > 0`;
}

export async function usageThisMonth(shop: string): Promise<number> {
  const row = await prisma.usage.findUnique({ where: { shop_month: { shop, month: monthOf() } } });
  return row?.products ?? 0;
}

// After a product is restored, the same sheet row can be uploaded again without "Re-send"
export async function forgetUpload(shop: string, key: string | undefined, productId: string, imagesRemoved: boolean) {
  if (key) await prisma.productState.deleteMany({ where: { shop, productKey: key.toLowerCase() } });
  if (imagesRemoved) await prisma.uploadedImage.deleteMany({ where: { shop, productId } });
}

export function prismaRunStore(shop: string, jobId?: string): RunStore {
  return {
    async getFingerprint(productKey) {
      const row = await prisma.productState.findUnique({ where: { shop_productKey: { shop, productKey } } });
      return row?.fingerprint ?? null;
    },
    async setFingerprint(productKey, fingerprint) {
      await prisma.productState.upsert({
        where: { shop_productKey: { shop, productKey } },
        create: { shop, productKey, fingerprint },
        update: { fingerprint },
      });
    },
    async getUploaded(productId) {
      const rows = await prisma.uploadedImage.findMany({ where: { shop, productId }, select: { imageUid: true } });
      return rows.map((r) => r.imageUid);
    },
    async addUploaded(productId, imageUids) {
      await prisma.uploadedImage.createMany({
        data: imageUids.map((imageUid) => ({ shop, productId, imageUid })),
        skipDuplicates: true,
      });
    },
    saveBackup: (product, info) => saveProductBackup(shop, jobId ?? null, product, info),
    useQuota: () => useQuota(shop),
    releaseQuota: () => releaseQuota(shop),
  };
}

// The shop's uploaded image files, read from file storage only when an image is actually sent to Shopify
export async function uploadedImages(shop: string): Promise<ImageFile[]> {
  const rows = await prisma.storedFile.findMany({ where: { shop, kind: "image" }, orderBy: { name: "asc" } });
  const storage = getStorage();
  return rows.map((r) =>
    describeImage(r.name, { uid: `upload:${r.id}`, size: r.size, read: () => storage.get(r.storageKey) }),
  );
}
