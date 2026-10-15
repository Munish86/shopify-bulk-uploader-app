// Backups, one per run: every upload saves each product before changing it, every restore saves the
// products before putting them back. Listed newest first; hidden after BACKUP_HIDE_MONTHS, deleted after
// BACKUP_KEEP_MONTHS (by cleanupOldData).
import prisma from "../db.server";
import type { BackupData } from "./core/backup";
import { BACKUP_HIDE_MONTHS, BACKUP_KEEP_MONTHS } from "../lib/plans";

export const addMonths = (date: Date, n: number) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};

export interface BackupSummary {
  id: string; // the job id of the run that took it
  kind: "upload" | "restore";
  at: string; // when the run started
  products: number;
  of: string | null; // for a restore: the backup it put back
  hidden: boolean;
  expiresAt: string;
}

export async function listBackups(shop: string, now = new Date()): Promise<BackupSummary[]> {
  const groups = await prisma.productBackup.groupBy({
    by: ["jobId"],
    where: { shop, jobId: { not: null } },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  const ids = groups.map((g) => g.jobId!);
  const jobs = await prisma.job.findMany({
    where: { shop, id: { in: ids } },
    select: { id: true, command: true, options: true, createdAt: true },
  });
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return groups
    .map((g) => {
      const job = byId.get(g.jobId!);
      const at = job?.createdAt ?? g._min.createdAt!;
      return {
        id: g.jobId!,
        kind: job?.command === "restore" ? ("restore" as const) : ("upload" as const),
        at: at.toISOString(),
        products: g._count._all,
        of: ((job?.options as { backup?: string } | null)?.backup as string | undefined) ?? null,
        hidden: addMonths(at, BACKUP_HIDE_MONTHS) < now,
        expiresAt: addMonths(g._min.createdAt!, BACKUP_KEEP_MONTHS).toISOString(),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function backupExists(shop: string, backupId: string) {
  return (await prisma.productBackup.count({ where: { shop, jobId: backupId } })) > 0;
}

// The products of one backup, and when that run ended (products changed after it get a note)
export async function loadBackup(shop: string, backupId: string): Promise<{ items: BackupData[]; finishedAt: Date } | null> {
  const rows = await prisma.productBackup.findMany({ where: { shop, jobId: backupId }, select: { data: true, createdAt: true } });
  if (!rows.length) return null;
  const job = await prisma.job.findFirst({ where: { shop, id: backupId }, select: { finishedAt: true } });
  const last = rows.reduce((t, r) => (r.createdAt > t ? r.createdAt : t), rows[0].createdAt);
  return { items: rows.map((r) => r.data as unknown as BackupData), finishedAt: job?.finishedAt ?? last };
}

export async function deleteExpiredBackups(now = new Date()) {
  const r = await prisma.productBackup.deleteMany({ where: { createdAt: { lt: addMonths(now, -BACKUP_KEEP_MONTHS) } } });
  return r.count;
}
