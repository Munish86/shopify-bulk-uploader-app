// Shop records: created on install, settings saved per shop, everything removed on shop/redact.
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Settings } from "./core/config";
import { getStorage, shopPrefix } from "./storage";

// Called after every successful OAuth (install and re-install)
export async function recordInstall(shop: string) {
  await prisma.shop.upsert({
    where: { shop },
    create: { shop },
    update: { uninstalledAt: null },
  });
}

export async function recordUninstall(shop: string) {
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.shop.updateMany({ where: { shop }, data: { uninstalledAt: new Date() } });
  // Stop anything still waiting to run; the store no longer accepts our requests
  await prisma.job.updateMany({
    where: { shop, status: { in: ["queued", "running"] } },
    data: { status: "stopped", stopAsked: true, error: "The app was uninstalled." },
  });
}

export async function getSettings(shop: string): Promise<Settings> {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { settings: true } });
  return (row?.settings as Settings | null) ?? {};
}

export async function saveSettings(shop: string, settings: Settings) {
  await prisma.shop.update({
    where: { shop },
    data: { settings: settings as Prisma.InputJsonValue },
  });
}

// shop/redact: Shopify asks us to delete everything about a store 48 hours after it uninstalls the app.
// Rows in other tables go with the Shop row (onDelete: Cascade).
export async function deleteShopData(shop: string) {
  await getStorage().deletePrefix(shopPrefix(shop));
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.shop.deleteMany({ where: { shop } });
}
