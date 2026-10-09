// The job system without a database or Redis: processJob with an in-memory job table,
// local-disk storage in a temp folder and the simulated Shopify store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../app/.server/core/config";
import { Google } from "../app/.server/core/google";
import { describeImage } from "../app/.server/core/images";
import type { RunStore } from "../app/.server/core/runner";
import { Shopify } from "../app/.server/core/shopify";
import { processJob, MAX_ATTEMPTS, type ClaimedJob, type JobRepo, type ProcessDeps } from "../app/.server/jobs/process";
import { InProcessQueue } from "../app/.server/jobs/queue";
import { parseJobRequest } from "../app/.server/jobs/service";
import { checkUpload, cleanName } from "../app/.server/files";
import { readBody } from "../app/.server/http";
import { FileMissingError, LocalDiskStorage } from "../app/.server/storage";
import { startMock } from "./mock-shopify";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const SHOP = "mock-store.myshopify.com";

const SETTINGS: Settings = {
  sheet: { source: "file", fileId: "sheet1" },
  images: { source: "upload" },
  match: { find_by: "sku", create_missing: true },
  columns: {
    product_key: "AMC Name",
    image_key: "Meta Name",
    title: "Product Name",
    tags: "Tags",
    options: ["Colour", "Size"],
    price: "Price",
    sku: "SKU",
  },
  options: { concurrency: 1 },
};

interface MemJob extends ClaimedJob {
  status: string;
  stopAsked: boolean;
  log: string;
  error?: string;
  counts?: Record<string, number>;
  reportKey?: string;
  progress?: unknown;
}

// The Job table, in memory, with the same rules as the Prisma repo
function memoryRepo() {
  const jobs = new Map<string, MemJob>();
  const requeued: string[] = [];
  let heartbeats = 0;
  const repo: JobRepo = {
    async claim(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "queued" || j.stopAsked) return null;
      j.status = "running";
      j.attempts++;
      return { id: j.id, shop: j.shop, command: j.command, options: j.options, attempts: j.attempts };
    },
    async heartbeat(id, d) {
      heartbeats++;
      const j = jobs.get(id)!;
      Object.assign(j, d);
      return { stopAsked: j.stopAsked };
    },
    async finish(id, d) {
      const j = jobs.get(id)!;
      if (j.status === "running") Object.assign(j, d);
    },
    async requeue(id, log) {
      const j = jobs.get(id)!;
      if (j.status === "running") Object.assign(j, { status: "queued", log });
      requeued.push(id);
    },
  };
  const add = (id: string, command: string, extra: Partial<MemJob> = {}) => {
    jobs.set(id, { id, shop: SHOP, command, options: null, attempts: 0, status: "queued", stopAsked: false, log: "", ...extra });
    return jobs.get(id)!;
  };
  return { repo, jobs, add, requeued, heartbeats: () => heartbeats };
}

const noStore: RunStore = {
  getFingerprint: async () => null,
  setFingerprint: async () => {},
  getUploaded: async () => [],
  addUploaded: async () => {},
  saveBackup: async () => {},
};

describe("processJob", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let dir: string;
  let mem: ReturnType<typeof memoryRepo>;
  let deps: ProcessDeps;
  let settings: Settings;
  let shuttingDown = false;

  beforeAll(async () => {
    mock = await startMock();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploader-test-"));
  });
  afterAll(() => {
    mock.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    mock.state.delayMs = 0;
    shuttingDown = false;
    settings = structuredClone(SETTINGS);
    mem = memoryRepo();
    deps = {
      repo: mem.repo,
      storage: new LocalDiskStorage(dir),
      google: new Google(),
      loadSettings: async () => settings,
      sheetSource: async () => ({
        kind: "file",
        name: "products-sample.csv",
        data: fs.readFileSync(path.join(FIXTURES, "products-sample.csv")),
      }),
      uploadedImages: async () =>
        fs.readdirSync(path.join(FIXTURES, "images")).map((name) =>
          describeImage(name, { uid: `upload:${name}`, size: 70, read: async () => fs.readFileSync(path.join(FIXTURES, "images", name)) }),
        ),
      shopifyFor: (shop) => new Shopify({ shop, apiVersion: "2026-10", endpoint: mock.endpoint, accessToken: async () => "t" }),
      runStore: () => noStore,
      heartbeatMs: 5,
      shuttingDown: () => shuttingDown,
    };
  });

  it("runs a check and saves the report to storage", async () => {
    mem.add("j1", "check");
    expect(await processJob("j1", deps)).toBe("done");
    const j = mem.jobs.get("j1")!;
    expect(j.status).toBe("done");
    expect(j.counts).toEqual({ "Images found": 3 });
    expect(j.reportKey).toBe(`${SHOP}/files/report-j1.json`);
    const saved = JSON.parse((await deps.storage.get(j.reportKey!)).toString());
    expect(saved.rows.map((r: { product_key: string }) => r.product_key)).toEqual(["AMC-SOFA-001", "AMC-BED-014", "AMC-TBL-007"]);
    // Images matched to each product, with the id the thumbnails are served by
    expect(saved.details["AMC-SOFA-001"].map((i: { uid: string }) => i.uid)).toEqual([
      "upload:Oslo 3 Seater Sofa_1.png",
      "upload:Oslo 3 Seater Sofa_2.png",
      "upload:Oslo 3 Seater Sofa_3.png",
    ]);
    expect(j.log).toMatch(/=== CHECK started ===/);
  });

  it("runs a plan against Shopify", async () => {
    mem.add("j2", "plan", { options: { limit: 1 } });
    expect(await processJob("j2", deps)).toBe("done");
    expect(mem.jobs.get("j2")!.counts).toEqual({ "Will update": 1 });
  });

  it("a job that is not queued is skipped (taken by another worker, or stopped)", async () => {
    mem.add("j3", "check", { status: "running" });
    mem.add("j4", "check", { stopAsked: true });
    expect(await processJob("j3", deps)).toBe("skipped");
    expect(await processJob("j4", deps)).toBe("skipped");
    expect(await processJob("missing", deps)).toBe("skipped");
  });

  it("settings problems fail the job with the reason", async () => {
    settings = { sheet: { fileId: "x" } };
    mem.add("j5", "plan");
    expect(await processJob("j5", deps)).toBe("failed");
    expect(mem.jobs.get("j5")!.error).toMatch(/Choose at least one column/);
  });

  it("a missing sheet fails the job with the reason", async () => {
    deps.sheetSource = async () => {
      throw new Error("The uploaded sheet is no longer available");
    };
    mem.add("j6", "check");
    expect(await processJob("j6", deps)).toBe("failed");
    expect(mem.jobs.get("j6")!.error).toMatch(/no longer available/);
  });

  it("stops when the merchant asks, keeping the partial report", async () => {
    mock.state.delayMs = 40;
    const job = mem.add("j7", "plan");
    const running = processJob("j7", deps);
    await new Promise((r) => setTimeout(r, 30));
    job.stopAsked = true;
    expect(await running).toBe("stopped");
    expect(mem.jobs.get("j7")!.status).toBe("stopped");
    expect(mem.jobs.get("j7")!.log).toMatch(/Stopped\. \d products were not processed/);
    expect(mem.heartbeats()).toBeGreaterThan(0);
  });

  it("goes back to the queue when the worker shuts down", async () => {
    mock.state.delayMs = 40;
    mem.add("j8", "plan");
    const running = processJob("j8", deps);
    await new Promise((r) => setTimeout(r, 30));
    shuttingDown = true;
    expect(await running).toBe("requeued");
    expect(mem.jobs.get("j8")!.status).toBe("queued");
    expect(mem.requeued).toEqual(["j8"]);
  });

  it(`gives up after ${MAX_ATTEMPTS} interruptions`, async () => {
    mem.add("j9", "check", { attempts: MAX_ATTEMPTS });
    expect(await processJob("j9", deps)).toBe("failed");
    expect(mem.jobs.get("j9")!.error).toMatch(/kept stopping/);
  });
});

describe("in-process queue", () => {
  it("runs jobs a few at a time, and each waiting job once", async () => {
    let running = 0;
    let peak = 0;
    const ran: string[] = [];
    const q = new InProcessQueue(async (id) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      ran.push(id);
      running--;
    }, 2);
    for (const id of ["a", "b", "c", "d"]) await q.add(id, id);
    await q.add("d", "d"); // still waiting: not added twice
    await q.idle();
    expect(peak).toBe(2);
    expect(ran.sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("requests from the browser", () => {
  it("run requests are checked", () => {
    expect(parseJobRequest({ command: "apply", limit: "5", force: true })).toEqual({ command: "apply", options: { limit: 5, force: true } });
    expect(parseJobRequest({ command: "plan", limit: 0, only: "" })).toEqual({ command: "plan", options: {} });
    expect(() => parseJobRequest({ command: "delete" })).toThrow(/command/);
    expect(() => parseJobRequest({ command: "plan", limit: 2.5 })).toThrow(/limit/);
    expect(() => parseJobRequest(null)).toThrow(/command/);
  });

  it("file names are cleaned and checked", () => {
    expect(cleanName("C:\\photos\\Sofas\\Oslo_1.jpg")).toBe("C:/photos/Sofas/Oslo_1.jpg");
    expect(cleanName("../../etc/./passwd\u0000.jpg")).toBe("etc/passwd.jpg");
    expect(checkUpload("image", "Sofas/Oslo_1.JPG", 100)).toEqual({ kind: "image", name: "Sofas/Oslo_1.JPG", mime: "image/jpeg" });
    expect(checkUpload("sheet", "products.xlsx", 100).kind).toBe("sheet");
    expect(() => checkUpload("image", "notes.txt", 100)).toThrow(/not an image/);
    expect(() => checkUpload("sheet", "photo.jpg", 100)).toThrow(/not an Excel/);
    expect(() => checkUpload("image", "big.jpg", 21 * 1024 * 1024)).toThrow(/limit is 20 MB/);
    expect(() => checkUpload("other", "a.jpg", 1)).toThrow(/kind/);
    expect(() => checkUpload("image", "../..", 1)).toThrow(/no name/);
  });

  it("a request body over the limit is refused while reading", async () => {
    const big = new Request("http://x/", { method: "POST", body: new Uint8Array(2000) });
    await expect(readBody(big, 1000)).rejects.toThrow(/larger than/);
    const lying = new Request("http://x/", { method: "POST", body: new Uint8Array(10), headers: { "content-length": "999999" } });
    await expect(readBody(lying, 1000)).rejects.toThrow(/larger than/);
    const ok = new Request("http://x/", { method: "POST", body: new Uint8Array(10) });
    expect((await readBody(ok, 1000)).length).toBe(10);
  });
});

describe("local disk storage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploader-storage-"));
  const s = new LocalDiskStorage(dir);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stores, reads and deletes a shop's files", async () => {
    await s.put("a.myshopify.com/files/x1", Buffer.from("hello"));
    await s.put("b.myshopify.com/files/x1", Buffer.from("other shop"));
    expect((await s.get("a.myshopify.com/files/x1")).toString()).toBe("hello");
    await s.deletePrefix("a.myshopify.com/files");
    await expect(s.get("a.myshopify.com/files/x1")).rejects.toBeInstanceOf(FileMissingError);
    expect((await s.get("b.myshopify.com/files/x1")).toString()).toBe("other shop");
  });
});
