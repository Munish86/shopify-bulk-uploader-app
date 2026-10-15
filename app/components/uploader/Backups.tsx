// The Backups page: every upload (and every restore) saved the products before changing them. Listed by
// day; a backup can be previewed and put back. Only what that run changed is put back.
import { useEffect, useState, type ReactNode } from "react";
import { formatDuration } from "../../lib/uploader";
import { Button, Checkbox, TextField } from "../polaris";
import { api, ApiError, isActive, type BackupSummary, type JobInfo, type Report } from "./api";
import { Results } from "./Results";
import { LABEL } from "./RunSection";
import styles from "./uploader.module.css";

const POLL_MS = 2000;

export interface BackupList {
  backups: BackupSummary[];
  hideMonths: number;
  keepMonths: number;
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtWhen = (iso: string) => `${fmtDate(iso)}, ${fmtTime(iso)}`;

async function fetchReport(jobId: string): Promise<Report | null> {
  try {
    return await api<Report>(`/app/api/jobs/${jobId}?report=json`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export function Backups({ initial, latestJob }: { initial: BackupList; latestJob: JobInfo | null }) {
  const [list, setList] = useState(initial);
  const [showOlder, setShowOlder] = useState(false);
  const [only, setOnly] = useState("");
  const [skipEdited, setSkipEdited] = useState(false);
  const [confirm, setConfirm] = useState<BackupSummary | null>(null);
  const [job, setJob] = useState<JobInfo | null>(latestJob && latestJob.command.startsWith("restore") ? latestJob : null);
  const [report, setReport] = useState<{ jobId: string; data: Report } | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  // Follow the restore until it ends, then load its report and the backup list (a restore adds a backup)
  const jobId = job?.id;
  const active = isActive(job);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api<{ job: JobInfo }>(`/app/api/jobs/${jobId}`)
        .then((r) => {
          if (stop) return;
          setJob(r.job);
          if (isActive(r.job)) timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(poll, POLL_MS * 3);
        });
    if (active) timer = setTimeout(poll, POLL_MS);
    else
      void Promise.all([fetchReport(jobId), api<BackupList>("/app/api/backups")])
        .then(([data, l]) => {
          if (stop) return;
          if (data) setReport({ jobId, data });
          setList(l);
        })
        .catch(() => {});
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // Only a new job, or the job starting or ending, restarts the loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, active]);

  // The finished restore preview on screen: the restore confirmation quotes it
  const preview =
    job?.command === "restore-plan" && job.status === "done" && job.options?.backup
      ? { backup: job.options.backup, count: job.counts?.["Will restore"] ?? 0 }
      : null;

  async function start(b: BackupSummary, apply: boolean) {
    setError("");
    setConfirm(null);
    setStarting(true);
    try {
      const res = await api<{ job: { id: string } }>("/app/api/jobs", {
        json: {
          command: apply ? "restore" : "restore-plan",
          backup: b.id,
          ...(only.trim() ? { only: only.trim() } : {}),
          ...(skipEdited ? { skipEdited: true } : {}),
        },
      });
      const created = await api<{ job: JobInfo }>(`/app/api/jobs/${res.job.id}`);
      setReport(null);
      setJob(created.job);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const backups = list.backups;
  const older = backups.filter((b) => b.hidden).length;
  const shown = showOlder ? backups : backups.filter((b) => !b.hidden);
  const whenOf = (id: string | null) => backups.find((b) => b.id === id)?.at;
  const busy = active || starting;

  // Rows grouped by day (in the viewer's time zone), newest first
  const rows: ReactNode[] = [];
  let day = "";
  for (const b of shown) {
    const d = fmtDay(b.at);
    if (d !== day) {
      rows.push(
        <tr key={`day-${b.id}`} className={styles.day}>
          <td colSpan={5}>{d}</td>
        </tr>,
      );
      day = d;
    }
    const of = whenOf(b.of);
    rows.push(
      <tr key={b.id} className={b.hidden ? styles.old : undefined}>
        <td>{fmtTime(b.at)}</td>
        <td className={styles.wrap}>
          {b.kind === "restore" ? (
            <>
              Restore{of ? ` of the ${fmtWhen(of)} upload` : ""}
              <div className={styles.muted}>Restoring this undoes that restore</div>
            </>
          ) : (
            "Upload"
          )}
        </td>
        <td>{b.products}</td>
        <td>{fmtDate(b.expiresAt)}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <s-stack direction="inline" gap="small-200">
            <Button onClick={() => void start(b, false)} disabled={busy}>
              Preview restore
            </Button>
            <Button variant="primary" onClick={() => setConfirm(b)} disabled={busy}>
              Restore
            </Button>
          </s-stack>
        </td>
      </tr>,
    );
  }

  const p = job?.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : job && !active ? 100 : 0;
  const took = job?.finishedAt && job.startedAt ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime() : 0;
  const confirmPreview = confirm && preview?.backup === confirm.id ? preview : null;

  return (
    <>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Before every upload the app saves each product exactly as it was. To undo an upload, preview the restore, then
            restore. Only what that upload changed is put back (for example only the description and meta title), so later
            changes to other fields such as price or stock are kept. Every restore is backed up first, so it can be undone
            the same way.
          </s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(260px, 1fr))" gap="base">
            <TextField
              label="Only these products (titles or product keys, comma separated)"
              placeholder="All products in the backup"
              value={only}
              onChange={setOnly}
            />
          </s-grid>
          <Checkbox
            label="Skip products that were changed in Shopify after the upload (someone may have fixed them by hand)"
            checked={skipEdited}
            onChange={setSkipEdited}
          />
          <s-text color="subdued">
            Backups older than {list.hideMonths} months are hidden here but still saved, and can still be restored with
            &quot;Show older backups&quot;. Backups are deleted automatically after {list.keepMonths} months.
          </s-text>

          {shown.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>What</th>
                    <th>Products backed up</th>
                    <th>Kept until</th>
                    <th />
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
          ) : (
            <s-text color="subdued">
              {older
                ? `No backups from the last ${list.hideMonths} months.`
                : "No backups yet. One is saved automatically before every upload."}
            </s-text>
          )}
          {older > 0 && (
            <div>
              <Button onClick={() => setShowOlder(!showOlder)}>
                {showOlder ? "Hide older backups" : `Show older backups (${older})`}
              </Button>
            </div>
          )}

          {confirm && (
            <s-banner tone="warning" heading="Restore these products?">
              <s-stack direction="block" gap="small-200">
                <s-text>
                  {confirmPreview
                    ? `The preview shows ${confirmPreview.count} products will be put back as they were before the ${fmtWhen(confirm.at)} upload.`
                    : `You have not previewed this restore. Put back ${only.trim() ? "the chosen products" : `up to ${confirm.products} products`} as they were before the ${fmtWhen(confirm.at)} upload?`}
                </s-text>
                <s-stack direction="inline" gap="small-200">
                  <Button variant="primary" onClick={() => void start(confirm, true)} disabled={confirmPreview?.count === 0}>
                    Start the restore
                  </Button>
                  <Button onClick={() => setConfirm(null)}>Cancel</Button>
                </s-stack>
              </s-stack>
            </s-banner>
          )}
          {error && <s-banner tone="critical">{error}</s-banner>}

          {job && (
            <s-stack direction="block" gap="small-200">
              <div className={styles.bar}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <s-stack direction="inline" gap="base" justifyContent="space-between">
                <s-text>{statusText(job)}</s-text>
                <s-text color="subdued">
                  {active && p?.done
                    ? `${formatDuration(p.elapsedMs)} elapsed · about ${formatDuration(p.etaMs)} left`
                    : took
                      ? `Took ${formatDuration(took)}`
                      : ""}
                </s-text>
              </s-stack>
              {job.status === "failed" && job.error && <s-banner tone="critical">{job.error}</s-banner>}
              {active && (
                <div>
                  <Button
                    tone="critical"
                    disabled={job.stopAsked}
                    onClick={() =>
                      void api<{ job: JobInfo }>(`/app/api/jobs/${job.id}`, { json: { stop: true } }).then((r) => setJob({ ...job, ...r.job }))
                    }
                  >
                    Stop
                  </Button>
                </div>
              )}
              {job.log && (
                <details open={job.status === "failed"}>
                  <summary>Show log</summary>
                  <pre className={styles.log}>{job.log}</pre>
                </details>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>
      {job && report?.jobId === job.id && <Results job={job} report={report.data} />}
    </>
  );
}

function statusText(job: JobInfo) {
  const label = LABEL[job.command] || job.command;
  const p = job.progress;
  switch (job.status) {
    case "queued":
      return `${label}: waiting to start...`;
    case "running":
      if (job.stopAsked) return `${label}: stopping after the products in progress...`;
      return p?.total ? `${label}: ${p.done} of ${p.total} products` : `${label}: reading the backup...`;
    case "done":
      return job.command === "restore"
        ? `✓ Restore finished. To undo it, use the new "Restore" row at the top of the list.`
        : `✓ ${label} finished${p?.total ? ` (${p.total} products)` : ""}.`;
    case "stopped":
      return `${label} stopped${p?.total ? ` after ${p.done} of ${p.total} products` : ""}.`;
    case "failed":
      return `${label} could not finish.`;
  }
}
