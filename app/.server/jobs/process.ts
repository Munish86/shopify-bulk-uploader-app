// Runs one queued job: claims it, runs check / plan / apply, and keeps the Job row up to date
// (progress, log, stop requests) while it runs. Everything it touches comes in through `deps`, so the
// same code runs in the worker, in the in-process dev queue and in tests.
import { normalizeConfig, type Config, type Settings } from "../core/config";
import type { Google } from "../core/google";
import type { ImageFile } from "../core/images";
import type { BackupData, BackupInfo } from "../core/backup";
import { restoreRun } from "../core/restore";
import { runJob, COMMANDS, type Command, type Progress, type RunResult, type RunStore } from "../core/runner";
import type { SheetSource } from "../core/sheet";
import type { Shopify, ShopifyProduct } from "../core/shopify";
import type { FileStorage } from "../storage";
import { reportKey } from "../storage";

export interface ClaimedJob {
  id: string;
  shop: string;
  command: string;
  options: { only?: string; limit?: number; force?: boolean; backup?: string; skipEdited?: boolean } | null;
  attempts: number;
}

// Where a restore reads a backup from and writes its own backup to (the database in the app)
export interface BackupAccess {
  load(shop: string, backupId: string): Promise<{ items: BackupData[]; finishedAt: Date } | null>;
  saveUndo(shop: string, jobId: string, product: ShopifyProduct, info: BackupInfo): Promise<void>;
  afterRestore(shop: string, key: string | undefined, productId: string, imagesRemoved: boolean): Promise<void>;
}

export type FinalStatus = "done" | "failed" | "stopped";

export interface JobRepo {
  // queued -> running (attempts + 1). null if the job is not queued (already taken, stopped, deleted).
  claim(jobId: string): Promise<ClaimedJob | null>;
  // Saves progress and the latest log; tells whether the merchant asked to stop
  heartbeat(jobId: string, data: { progress?: Progress; log: string }): Promise<{ stopAsked: boolean }>;
  finish(
    jobId: string,
    data: {
      status: FinalStatus;
      log: string;
      progress?: Progress;
      counts?: Record<string, number>;
      reportKey?: string;
      unmatched?: RunResult["unmatched"];
      error?: string;
    },
  ): Promise<void>;
  // Back to queued, for a job cut off by a server restart
  requeue(jobId: string, log: string): Promise<void>;
}

export interface ProcessDeps {
  repo: JobRepo;
  storage: FileStorage;
  google: Google;
  loadSettings: (shop: string) => Promise<Settings>;
  sheetSource: (shop: string, cfg: Config) => Promise<SheetSource>;
  uploadedImages: (shop: string) => Promise<ImageFile[]>;
  shopifyFor: (shop: string) => Shopify;
  runStore: (shop: string, jobId: string) => RunStore;
  backups: BackupAccess;
  heartbeatMs?: number;
  // True when the worker is shutting down: the job stops after the products in progress and is re-queued
  shuttingDown?: () => boolean;
}

// What is kept in file storage for each finished run
export interface SavedReport {
  rows: RunResult["report"];
  details: RunResult["details"];
}

export const MAX_ATTEMPTS = 3;
const LOG_KEEP = 100_000; // characters of log kept on the Job row

export type ProcessOutcome = FinalStatus | "requeued" | "skipped";

export async function processJob(jobId: string, deps: ProcessDeps): Promise<ProcessOutcome> {
  const job = await deps.repo.claim(jobId);
  if (!job) return "skipped";

  const lines: string[] = [];
  let logSize = 0;
  const log = (m: string) => {
    const line = `${new Date().toISOString().slice(11, 19)}  ${m}`;
    lines.push(line);
    logSize += line.length + 1;
    // Keep memory bounded on very long runs: drop the oldest lines
    while (logSize > LOG_KEEP * 2 && lines.length > 1) logSize -= lines.shift()!.length + 1;
  };
  const logText = () => {
    const all = lines.join("\n");
    return all.length > LOG_KEEP ? "...\n" + all.slice(-LOG_KEEP) : all;
  };

  if (job.attempts > MAX_ATTEMPTS) {
    log(`This run was interrupted ${MAX_ATTEMPTS} times, so it was not started again.`);
    await deps.repo.finish(jobId, {
      status: "failed",
      log: logText(),
      error: "The run kept stopping unexpectedly. Try a smaller sheet, or contact support.",
    });
    return "failed";
  }
  if (job.attempts > 1) log(`Started again after an interruption (attempt ${job.attempts}). Products already saved are skipped.`);

  let progress: Progress | undefined;
  let stopAsked = false;
  const shuttingDown = deps.shuttingDown || (() => false);

  // Heartbeat: save progress and log, and pick up a stop request. One write at a time.
  let beating: Promise<void> | null = null;
  const beat = () => {
    beating ??= deps.repo
      .heartbeat(jobId, { progress, log: logText() })
      .then((r) => {
        if (r.stopAsked) stopAsked = true;
      })
      .catch((e) => console.error(`Heartbeat failed for job ${jobId}:`, e))
      .finally(() => {
        beating = null;
      });
    return beating;
  };
  const timer = setInterval(beat, deps.heartbeatMs ?? 2000);

  try {
    const common = { log, progress: (p: Progress) => (progress = p), shouldStop: () => stopAsked || shuttingDown() };
    let result: RunResult;
    if (job.command === "restore-plan" || job.command === "restore") {
      const backup = job.options?.backup ? await deps.backups.load(job.shop, job.options.backup) : null;
      if (!backup) throw new Error("This backup no longer exists.");
      const settings = await deps.loadSettings(job.shop);
      result = await restoreRun(
        {
          shopify: deps.shopifyFor(job.shop),
          items: backup.items,
          finishedAt: backup.finishedAt,
          saveUndo: (product, info) => deps.backups.saveUndo(job.shop, jobId, product, info),
          afterRestore: (key, productId, removed) => deps.backups.afterRestore(job.shop, key, productId, removed),
        },
        {
          ...common,
          apply: job.command === "restore",
          only: job.options?.only,
          skipEdited: job.options?.skipEdited,
          concurrency: Math.min(8, Math.max(1, Number(settings.options?.concurrency) || 4)),
        },
      );
    } else {
      if (!COMMANDS.includes(job.command as Command)) throw new Error(`Unknown command "${job.command}".`);
      const command = job.command as Command;
      const cfg = normalizeConfig(await deps.loadSettings(job.shop));
      result = await runJob(
        command,
        {
          cfg,
          sheet: await deps.sheetSource(job.shop, cfg),
          uploadedImages: () => deps.uploadedImages(job.shop),
          google: deps.google,
          shopify: command === "check" ? undefined : deps.shopifyFor(job.shop),
          store: deps.runStore(job.shop, jobId),
        },
        { ...common, only: job.options?.only, limit: job.options?.limit, force: job.options?.force },
      );
    }

    clearInterval(timer);
    await beating;
    if (result.stopped && !stopAsked && shuttingDown()) {
      log("The server is restarting. This run will continue shortly.");
      await deps.repo.requeue(jobId, logText());
      return "requeued";
    }

    const key = reportKey(job.shop, jobId);
    const saved: SavedReport = { rows: result.report, details: result.details };
    await deps.storage.put(key, Buffer.from(JSON.stringify(saved)), "application/json");
    const status: FinalStatus = result.stopped ? "stopped" : "done";
    await deps.repo.finish(jobId, {
      status,
      log: logText(),
      progress,
      counts: result.counts,
      reportKey: key,
      unmatched: result.unmatched,
    });
    return status;
  } catch (e) {
    clearInterval(timer);
    await beating;
    const message = (e as Error).message || String(e);
    log(`ERROR: ${message}`);
    await deps.repo.finish(jobId, { status: "failed", log: logText(), progress, error: message });
    return "failed";
  }
}
