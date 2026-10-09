// Database-backed memory of earlier runs for one shop (what was uploaded, backups), used by runJob.
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { RunStore } from "./core/runner";
import { describeImage, type ImageFile } from "./core/images";
import { getStorage } from "./storage";

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
    async saveBackup(product) {
      await prisma.productBackup.create({
        data: {
          shop,
          jobId: jobId ?? null,
          productId: product.id,
          handle: product.handle,
          data: product as unknown as Prisma.InputJsonValue,
        },
      });
    },
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
