/* eslint-disable @typescript-eslint/no-explicit-any -- loose simulated-store data */
// The app's database side against a real PostgreSQL (PGlite) and the simulated Shopify store: uploads,
// the job system as the worker runs it, backups, restore and undo, the plan limit, housekeeping and the
// uninstall / shop-redact path. Everything except Shopify itself is the production code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Google } from "../app/.server/core/google";
import { Shopify } from "../app/.server/core/shopify";
import type { ProcessDeps } from "../app/.server/jobs/process";
import { startMock } from "./mock-shopify";
import { startDb } from "./db";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const SHOP = "db-test.myshopify.com";
const OTHER = "other-store.myshopify.com";

const SETTINGS = {
  images: { source: "upload", mode: "append" },
  match: { find_by: "sku", create_missing: true, new_product_status: "DRAFT" },
  columns: {
    product_key: "AMC Name",
    image_key: "Meta Name",
    image_alt: "Product Name",
    title: "Product Name",
    description: "Description",
    tags: "Tags",
    collections: "Collections",
    options: ["Colour", "Size"],
    price: "Price",
    compare_at_price: "Compare Price",
    sku: "SKU",
  },
  metafields: [{ column: "Material", namespace: "custom", key: "material", type: "single_line_text_field" }],
  options: { concurrency: 2 },
};

describe("database: uploads, jobs, backups, plan limit (real Postgres)", () => {
  let dbh: Awaited<ReturnType<typeof startDb>>;
  let mock: Awaited<ReturnType<typeof startMock>>;
  let prisma: any;
  let m: {
    shops: typeof import("../app/.server/shops");
    files: typeof import("../app/.server/files");
    svc: typeof import("../app/.server/jobs/service");
    proc: typeof import("../app/.server/jobs/process");
    runStore: typeof import("../app/.server/run-store");
    backups: typeof import("../app/.server/backups");
    storage: typeof import("../app/.server/storage");
  };
  const queued: string[] = [];
  const queue = { add: async (id: string, dedupeId?: string) => void queued.push(dedupeId ?? id) };
  let deps: ProcessDeps;

  // Starts a job the way the API does and runs it the way the worker does
  async function run(command: string, extra: Record<string, unknown> = {}, shop = SHOP) {
    const { command: c, options } = m.svc.parseJobRequest({ command, ...extra });
    await m.svc.checkCanStart(shop, c, options);
    const job = await m.svc.enqueueJob(shop, c, options, queue);
    const outcome = await m.proc.processJob(job.id, deps);
    const row = await m.svc.getJob(shop, job.id, { withLog: true });
    const report = await m.svc.readReport(shop, job.id);
    return { id: job.id, outcome, row: row as any, report };
  }

  beforeAll(async () => {
    dbh = await startDb();
    mock = await startMock();
    // Imported only now: Prisma reads DATABASE_URL when the client is created
    m = {
      shops: await import("../app/.server/shops"),
      files: await import("../app/.server/files"),
      svc: await import("../app/.server/jobs/service"),
      proc: await import("../app/.server/jobs/process"),
      runStore: await import("../app/.server/run-store"),
      backups: await import("../app/.server/backups"),
      storage: await import("../app/.server/storage"),
    };
    prisma = (await import("../app/db.server")).default;
    deps = {
      repo: m.svc.prismaJobRepo(queue),
      storage: m.storage.getStorage(),
      google: new Google(),
      loadSettings: m.shops.getSettings,
      sheetSource: m.files.sheetSource,
      uploadedImages: m.runStore.uploadedImages,
      shopifyFor: (shop) =>
        new Shopify({ shop, apiVersion: "2026-10", endpoint: mock.endpoint, accessToken: async () => "t" }),
      runStore: m.runStore.prismaRunStore,
      backups: { load: m.backups.loadBackup, saveUndo: m.runStore.saveProductBackup, afterRestore: m.runStore.forgetUpload },
      heartbeatMs: 50,
    };
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    mock?.server.close();
    await dbh?.stop();
  });

  it("install, settings and uploads (sheet replaces sheet, image replaces same name)", async () => {
    await m.shops.recordInstall(SHOP);
    await m.shops.recordInstall(OTHER);
    await m.shops.saveSettings(SHOP, SETTINGS as any);

    const sheet = fs.readFileSync(path.join(FIXTURES, "products-sample.csv"));
    const first = await m.files.saveUpload(SHOP, "sheet", "old.csv", sheet);
    const second = await m.files.saveUpload(SHOP, "sheet", "C:\\Users\\me\\products-sample.csv", sheet);
    expect(second.name).toBe("C:/Users/me/products-sample.csv");
    expect((await m.files.listFiles(SHOP, "sheet")).map((f) => f.id)).toEqual([second.id]);
    const settings = await m.shops.getSettings(SHOP);
    expect(settings.sheet).toMatchObject({ source: "file", fileId: second.id });
    expect(settings.columns?.product_key).toBe("AMC Name");
    expect(first.id).not.toBe(second.id);

    for (const name of fs.readdirSync(path.join(FIXTURES, "images"))) {
      await m.files.saveUpload(SHOP, "image", `photos/${name}`, fs.readFileSync(path.join(FIXTURES, "images", name)));
    }
    await m.files.saveUpload(SHOP, "image", "photos/old-banner.png", fs.readFileSync(path.join(FIXTURES, "images", "old-banner.png")));
    expect(await prisma.storedFile.count({ where: { shop: SHOP, kind: "image" } })).toBe(6);
    expect((await m.runStore.uploadedImages(SHOP)).length).toBe(6);

    await expect(m.files.saveUpload(SHOP, "image", "evil.exe", Buffer.from("x"))).rejects.toThrow(/not an image/);
    // Another store sees none of it
    expect(await m.files.listFiles(OTHER, "image")).toEqual([]);
  });

  it("one active run per store, even with several clicks at once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => m.svc.enqueueJob(SHOP, "check", {}, queue)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").every((r: any) => r.reason.status === 409)).toBe(true);
    // Stopping a queued job ends it at once; the worker then skips it
    const id = (ok[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await m.svc.requestStop(SHOP, id);
    expect((await m.svc.getJob(SHOP, id))!.status).toBe("stopped");
    expect(await m.proc.processJob(id, deps)).toBe("skipped");
    // Another store is not blocked by this one
    const other = await m.svc.enqueueJob(OTHER, "check", {}, queue);
    await m.svc.requestStop(OTHER, other.id);
  });

  it("check, preview and upload as the worker runs them", async () => {
    const check = await run("check");
    expect(check.outcome).toBe("done");
    expect(check.row.status).toBe("done");
    expect(check.report!.rows.length).toBe(3);
    expect(check.row.unmatched).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringMatching(/old-banner/) })]));

    const before = mock.calls.length;
    const plan = await run("plan");
    expect(plan.outcome).toBe("done");
    expect(plan.report!.rows.map((r: any) => r.action).sort()).toEqual(["Will create", "Will update", "Will update"]);
    expect(mock.calls.slice(before).some((c) => /mutation/.test(c.query))).toBe(false);
    expect(await m.runStore.usageThisMonth(SHOP)).toBe(0);

    const apply = await run("apply");
    expect(apply.outcome).toBe("done");
    expect(apply.report!.rows.map((r: any) => r.action).sort()).toEqual(["Created", "Updated", "Updated"]);
    expect(apply.row.counts).toMatchObject({ Created: 1, Updated: 2 });
    expect(apply.row.log).toMatch(/\S/);
    expect(await m.runStore.usageThisMonth(SHOP)).toBe(3);
    expect(await prisma.productState.count({ where: { shop: SHOP } })).toBe(3);
    expect(await prisma.uploadedImage.count({ where: { shop: SHOP } })).toBeGreaterThan(0);
    // Created products have nothing to back up; the two updated ones do
    expect(await prisma.productBackup.count({ where: { shop: SHOP, jobId: apply.id } })).toBe(2);

    // Running the same sheet again skips unchanged products and uses no allowance
    const again = await run("apply");
    expect(again.report!.rows.every((r: any) => r.action === "Already done")).toBe(true);
    expect(await m.runStore.usageThisMonth(SHOP)).toBe(3);
  });

  it("backups are listed per run, restored, and the restore can be undone", async () => {
    const list = await m.backups.listBackups(SHOP);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ kind: "upload", products: 2, hidden: false });
    const backupId = list[0].id;

    const preview = await run("restore-plan", { backup: backupId });
    expect(preview.report!.rows.map((r: any) => r.action)).toEqual(["Will restore", "Will restore"]);

    const restore = await run("restore", { backup: backupId });
    expect(restore.outcome).toBe("done");
    expect(restore.report!.rows.map((r: any) => r.action)).toEqual(["Restored", "Restored"]);
    const oslo = mock.products.find((p: any) => p.id === "gid://shopify/Product/1");
    expect(oslo.descriptionHtml).toBe("<p>old</p>");
    // The restored products can be uploaded again without "Re-send"
    expect(await prisma.productState.count({ where: { shop: SHOP } })).toBe(1);

    const after = await m.backups.listBackups(SHOP);
    expect(after.map((b) => b.kind)).toEqual(["restore", "upload"]);
    expect(after[0].of).toBe(backupId);
    const undo = await run("restore", { backup: after[0].id });
    expect(undo.report!.rows.map((r: any) => r.action)).toEqual(["Restored", "Restored"]);
    expect(oslo.descriptionHtml).not.toBe("<p>old</p>");

    // A backup of another store cannot be restored from this one
    await expect(m.svc.checkCanStart(OTHER, "restore", { backup: backupId })).rejects.toMatchObject({ status: 404 });
  });

  it("the plan limit holds with parallel workers and refuses an upload when used up", async () => {
    await prisma.usage.update({ where: { shop_month: { shop: SHOP, month: (await import("../app/lib/plans")).monthOf() } }, data: { products: 45 } });
    const taken = await Promise.all(Array.from({ length: 10 }, () => m.runStore.useQuota(SHOP)));
    expect(taken.filter(Boolean).length).toBe(5);
    expect(await m.runStore.usageThisMonth(SHOP)).toBe(50);
    await expect(m.svc.checkCanStart(SHOP, "apply", {})).rejects.toMatchObject({ status: 402 });
    // Check and preview stay free
    await expect(m.svc.checkCanStart(SHOP, "plan", {})).resolves.toBeUndefined();

    // Upgrading lifts the limit
    await m.shops.setPlanFromSubscriptions(SHOP, [{ name: "Pro", status: "ACTIVE" }]);
    await expect(m.svc.checkCanStart(SHOP, "apply", {})).resolves.toBeUndefined();
    expect(await m.runStore.useQuota(SHOP)).toBe(true);
    await m.runStore.releaseQuota(SHOP);
    await m.shops.setPlanFromSubscriptions(SHOP, [{ name: "Pro", status: "CANCELLED" }]);
    expect((await prisma.shop.findUnique({ where: { shop: SHOP } })).plan).toBe("free");
  });

  it("a run whose worker died is put back in the queue; a finished one is not", async () => {
    const job = await m.svc.enqueueJob(SHOP, "check", {}, queue);
    await deps.repo.claim(job.id);
    await prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: new Date(Date.now() - 10 * 60 * 1000) } });
    queued.length = 0;
    const r = await m.svc.sweepJobs(queue);
    expect(r.requeued).toBe(1);
    expect(queued[0]).toMatch(new RegExp(`^${job.id}-`));
    expect((await m.svc.getJob(SHOP, job.id))!.status).toBe("queued");
    expect(await m.proc.processJob(job.id, deps)).toBe("done");
    expect((await m.svc.getJob(SHOP, job.id, { withLog: true }) as any).log).toMatch(/attempt 2/);
  });

  it("housekeeping deletes old files, jobs and backups but keeps recent ones", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const img = await prisma.storedFile.findFirst({ where: { shop: SHOP, kind: "image" } });
    await prisma.storedFile.update({ where: { id: img.id }, data: { createdAt: old } });
    const backup = await prisma.productBackup.findFirst({ where: { shop: SHOP } });
    await prisma.productBackup.update({ where: { id: backup.id }, data: { createdAt: old } });
    const job = await prisma.job.findFirst({ where: { shop: SHOP, status: "done" }, orderBy: { createdAt: "asc" } });
    await prisma.job.update({ where: { id: job.id }, data: { createdAt: old } });

    const r = await m.svc.cleanupOldData();
    expect(r).toEqual({ files: 1, jobs: 1, backups: 1 });
    expect(await prisma.storedFile.count({ where: { id: img.id } })).toBe(0);
    expect(await prisma.storedFile.count({ where: { shop: SHOP, kind: "image" } })).toBe(5);
  });

  it("uninstall stops runs; shop/redact removes every row and file of that store only", async () => {
    const job = await m.svc.enqueueJob(SHOP, "check", {}, queue);
    await m.shops.recordUninstall(SHOP);
    expect((await m.svc.getJob(SHOP, job.id))!.status).toBe("stopped");
    expect((await prisma.shop.findUnique({ where: { shop: SHOP } })).uninstalledAt).not.toBeNull();

    await m.shops.deleteShopData(SHOP);
    for (const t of ["shop", "job", "storedFile", "productState", "uploadedImage", "productBackup", "usage"]) {
      expect(await prisma[t].count({ where: { shop: SHOP } })).toBe(0);
    }
    expect(fs.existsSync(path.join(dbh.storageDir, SHOP, "files"))).toBe(false);
    expect(await prisma.shop.count({ where: { shop: OTHER } })).toBe(1);
  });
});
