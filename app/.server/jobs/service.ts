// Starting, stopping and reading jobs, plus the worker's housekeeping. Database side of the job system.
import type { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { COMMANDS, type ReportRow } from "../core/runner";
import { planByKey, remaining } from "../../lib/plans";
import { backupExists, deleteExpiredBackups } from "../backups";
import { usageThisMonth } from "../run-store";
import { FileMissingError, getStorage } from "../storage";
import type { ClaimedJob, JobRepo, SavedReport } from "./process";
import { getQueue, type JobQueue } from "./queue";

export const ACTIVE = ["queued", "running"];

export class JobError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// Uploads (check / plan / apply) plus putting a backup back (preview, then restore)
export const RESTORE_COMMANDS = ["restore-plan", "restore"] as const;
export const JOB_COMMANDS = [...COMMANDS, ...RESTORE_COMMANDS] as const;
export type JobCommand = (typeof JOB_COMMANDS)[number];
export const isRestoreCommand = (c: string): c is (typeof RESTORE_COMMANDS)[number] =>
  (RESTORE_COMMANDS as readonly string[]).includes(c);

export interface JobOptions {
  only?: string;
  limit?: number;
  force?: boolean;
  backup?: string; // restore: the backup (job id of the run that took it)
  skipEdited?: boolean; // restore: leave products changed in Shopify after that run
}

// Checks what the browser sent. Never trust it to be well-formed.
export function parseJobRequest(body: unknown): { command: JobCommand; options: JobOptions } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!JOB_COMMANDS.includes(b.command as JobCommand)) {
    throw new JobError('command must be "check", "plan", "apply", "restore-plan" or "restore".');
  }
  const options: JobOptions = {};
  if (isRestoreCommand(b.command as string)) {
    if (typeof b.backup !== "string" || !/^[a-z0-9]{10,40}$/i.test(b.backup)) throw new JobError("Choose a backup to restore.");
    options.backup = b.backup;
    if (b.skipEdited === true) options.skipEdited = true;
  }
  if (b.only != null && b.only !== "") {
    if (typeof b.only !== "string" || b.only.length > 5000) throw new JobError("only must be a list of product keys.");
    options.only = b.only;
  }
  if (b.limit != null && b.limit !== "" && b.limit !== 0) {
    const n = Number(b.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50_000) throw new JobError("limit must be a whole number from 1 to 50000.");
    options.limit = n;
  }
  if (b.force === true && !isRestoreCommand(b.command as string)) options.force = true;
  return { command: b.command as JobCommand, options };
}

// Refuses a run that cannot do anything: an upload with this month's allowance used up, or a restore of
// a backup that does not exist (any more).
export async function checkCanStart(shop: string, command: JobCommand, options: JobOptions) {
  if (isRestoreCommand(command)) {
    if (!(await backupExists(shop, options.backup!))) throw new JobError("This backup no longer exists.", 404);
    return;
  }
  if (command !== "apply") return;
  const row = await prisma.shop.findUnique({ where: { shop }, select: { plan: true } });
  const plan = planByKey(row?.plan);
  if (remaining(plan, await usageThisMonth(shop)) === 0) {
    throw new JobError(
      `Your ${plan.name} plan allows ${plan.productsPerMonth} products per month, and they are used up. Upgrade the plan on the Plans page, or wait until next month. Check and preview still work.`,
      402,
    );
  }
}

// One active job per shop. The Shop row is locked while checking, so two clicks cannot start two runs.
export async function enqueueJob(shop: string, command: JobCommand, options: JobOptions, queue: JobQueue = getQueue()) {
  const job = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Shop" WHERE "shop" = ${shop} FOR UPDATE`;
    const active = await tx.job.findFirst({ where: { shop, status: { in: ACTIVE } }, select: { id: true } });
    if (active) throw new JobError("A run is already in progress. Wait for it to finish or stop it first.", 409);
    return tx.job.create({ data: { shop, command, options: options as Prisma.InputJsonValue } });
    // Prisma's defaults (2 s to get a connection, 5 s to finish) fail busy servers with an error instead of
    // waiting; clicks queued behind the lock then get a clear 409.
  }, { maxWait: 15_000, timeout: 20_000 });
  try {
    await queue.add(job.id, job.id);
  } catch (e) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "failed", error: "The run could not be started. Try again in a minute.", finishedAt: new Date() },
    });
    throw e;
  }
  return job;
}

// A queued job stops at once; a running job stops after the products in progress
export async function requestStop(shop: string, jobId: string) {
  await prisma.job.updateMany({
    where: { id: jobId, shop, status: "queued" },
    data: { status: "stopped", stopAsked: true, finishedAt: new Date() },
  });
  const r = await prisma.job.updateMany({ where: { id: jobId, shop, status: "running" }, data: { stopAsked: true } });
  return r.count > 0;
}

const JOB_FIELDS = {
  id: true,
  command: true,
  status: true,
  options: true,
  progress: true,
  counts: true,
  error: true,
  stopAsked: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.JobSelect;

export async function getJob(shop: string, jobId: string, { withLog = false } = {}) {
  return prisma.job.findFirst({
    where: { id: jobId, shop },
    select: { ...JOB_FIELDS, log: withLog, unmatched: withLog },
  });
}

export async function listJobs(shop: string, take = 20) {
  return prisma.job.findMany({ where: { shop }, select: JOB_FIELDS, orderBy: { createdAt: "desc" }, take });
}

export async function readReport(shop: string, jobId: string): Promise<SavedReport | null> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shop }, select: { reportKey: true } });
  if (!job?.reportKey) return null;
  try {
    const saved = JSON.parse((await getStorage().get(job.reportKey)).toString("utf8"));
    // Reports saved before images were listed per product were a plain array of rows
    return Array.isArray(saved) ? { rows: saved as ReportRow[], details: {} } : saved;
  } catch (e) {
    if (e instanceof FileMissingError) return null;
    throw e;
  }
}

// ---- Used by the worker ----

export function prismaJobRepo(queue: JobQueue = getQueue()): JobRepo {
  return {
    async claim(jobId) {
      const now = new Date();
      const r = await prisma.job.updateMany({
        where: { id: jobId, status: "queued", stopAsked: false },
        data: { status: "running", startedAt: now, heartbeatAt: now, attempts: { increment: 1 } },
      });
      if (!r.count) return null;
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, shop: true, command: true, options: true, attempts: true },
      });
      return job as ClaimedJob | null;
    },
    async heartbeat(jobId, { progress, log }) {
      try {
        const j = await prisma.job.update({
          where: { id: jobId },
          data: { progress: progress as Prisma.InputJsonValue | undefined, log, heartbeatAt: new Date() },
          select: { stopAsked: true },
        });
        return j;
      } catch (e) {
        // The job row is gone (the store's data was deleted): stop
        if ((e as { code?: string }).code === "P2025") return { stopAsked: true };
        throw e;
      }
    },
    async finish(jobId, d) {
      await prisma.job.updateMany({
        where: { id: jobId, status: "running" },
        data: {
          status: d.status,
          log: d.log,
          progress: d.progress as Prisma.InputJsonValue | undefined,
          counts: d.counts as Prisma.InputJsonValue | undefined,
          reportKey: d.reportKey,
          unmatched: d.unmatched as Prisma.InputJsonValue | undefined,
          error: d.error,
          finishedAt: new Date(),
        },
      });
    },
    async requeue(jobId, log) {
      const r = await prisma.job.updateMany({
        where: { id: jobId, status: "running" },
        data: { status: "queued", log, startedAt: null, heartbeatAt: null },
      });
      // A fresh queue id: the current queue entry is still active while this runs
      if (r.count) await queue.add(jobId, `${jobId}-${Date.now()}`);
    },
  };
}

const STALE_MS = 2 * 60 * 1000;

// Jobs whose worker died (no heartbeat) go back to the queue; queued jobs missing from the queue
// (for example after Redis was emptied) are added again. Queue ids make the second step harmless
// for jobs that are still waiting.
export async function sweepJobs(queue: JobQueue = getQueue()) {
  const stale = await prisma.job.findMany({
    where: { status: "running", heartbeatAt: { lt: new Date(Date.now() - STALE_MS) } },
    select: { id: true },
  });
  for (const { id } of stale) {
    const r = await prisma.job.updateMany({
      where: { id, status: "running" },
      data: { status: "queued", startedAt: null, heartbeatAt: null },
    });
    if (r.count) await queue.add(id, `${id}-${Date.now()}`);
  }
  const waiting = await prisma.job.findMany({
    where: { status: "queued", stopAsked: false, createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
    select: { id: true },
  });
  for (const { id } of waiting) await queue.add(id, id);
  return { requeued: stale.length, readded: waiting.length };
}

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = {
  fileDays: Number(process.env.FILE_RETENTION_DAYS || 7),
  // Kept as long as backups (6 months), so the backup list can say which run took each backup
  jobDays: 190,
};

// Deletes old uploads, reports, backups and jobs. Files of a shop with a run in progress are kept.
export async function cleanupOldData() {
  const storage = getStorage();
  const busy = (await prisma.job.findMany({ where: { status: { in: ACTIVE } }, select: { shop: true } })).map((j) => j.shop);

  const files = await prisma.storedFile.findMany({
    where: { createdAt: { lt: new Date(Date.now() - RETENTION.fileDays * DAY) }, shop: { notIn: busy } },
    select: { id: true, storageKey: true },
    take: 5000,
  });
  for (const f of files) {
    if (f.storageKey) await storage.delete(f.storageKey);
    await prisma.storedFile.delete({ where: { id: f.id } });
  }

  const jobs = await prisma.job.findMany({
    where: { createdAt: { lt: new Date(Date.now() - RETENTION.jobDays * DAY) }, status: { notIn: ACTIVE } },
    select: { id: true, reportKey: true },
    take: 5000,
  });
  for (const j of jobs) {
    if (j.reportKey) await storage.delete(j.reportKey);
    await prisma.job.delete({ where: { id: j.id } });
  }

  const backups = await deleteExpiredBackups();
  return { files: files.length, jobs: jobs.length, backups };
}
