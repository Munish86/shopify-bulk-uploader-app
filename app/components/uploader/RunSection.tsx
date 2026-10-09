import { useState } from "react";
import { formatDuration, type ReadyItem } from "../../lib/uploader";
import { Button, Checkbox, NumberField, TextField } from "../polaris";
import { isActive, type JobInfo } from "./api";
import styles from "./uploader.module.css";

export const LABEL: Record<string, string> = { check: "Image check", plan: "Preview", apply: "Upload" };

export interface RunRequest {
  command: "check" | "plan" | "apply";
  limit?: number;
  only?: string;
  force?: boolean;
}

export function RunSection({
  ready,
  canRun,
  job,
  startError,
  starting,
  lastPreviewChanges,
  onRun,
  onStop,
}: {
  ready: ReadyItem[];
  canRun: boolean;
  job: JobInfo | null;
  startError: string;
  starting: boolean;
  lastPreviewChanges: number | null; // products the latest preview would change; null = no preview yet
  onRun: (r: RunRequest) => void;
  onStop: () => void;
}) {
  const [limit, setLimit] = useState<number | "">("");
  const [only, setOnly] = useState("");
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = isActive(job) || starting;
  const req = (command: RunRequest["command"]): RunRequest => ({
    command,
    ...(limit ? { limit } : {}),
    ...(only.trim() ? { only: only.trim() } : {}),
    ...(force ? { force } : {}),
  });

  const p = job?.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : job && !isActive(job) ? 100 : 0;
  const took = job?.finishedAt && job.startedAt ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime() : 0;

  return (
    <s-section heading="5. Run">
      <s-stack direction="block" gap="base">
        <s-unordered-list>
          {ready.map((r) => (
            <s-list-item key={r.text}>
              <s-text tone={r.ok ? "success" : r.blocking ? "critical" : "caution"}>
                {r.ok ? "✓" : r.blocking ? "✕" : "!"} {r.text}
              </s-text>
            </s-list-item>
          ))}
        </s-unordered-list>

        <s-grid gridTemplateColumns="repeat(auto-fill, minmax(230px, 1fr))" gap="base">
          <NumberField label="Only the first N products (for a test run)" placeholder="All" min={1} value={limit} onChange={setLimit} />
          <TextField label="Only these products (product keys, comma separated)" placeholder="All" value={only} onChange={setOnly} />
        </s-grid>
        <Checkbox label="Re-send products that were already uploaded" checked={force} onChange={setForce} />

        <s-stack direction="inline" gap="base">
          <Button onClick={() => onRun(req("check"))} disabled={busy || !canRun}>
            1 · Check image matches
          </Button>
          <Button onClick={() => onRun(req("plan"))} disabled={busy || !canRun}>
            2 · Preview changes
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy || !canRun || confirming}>
            3 · Upload to Shopify
          </Button>
          {isActive(job) && (
            <Button tone="critical" onClick={onStop} disabled={job?.stopAsked}>
              Stop
            </Button>
          )}
        </s-stack>
        <s-text color="subdued">Steps 1 and 2 never save anything to Shopify. Run step 3 only when the preview looks right.</s-text>

        {confirming && (
          <s-banner tone="warning" heading="Upload to Shopify?">
            <s-stack direction="block" gap="small-200">
              <s-text>
                {lastPreviewChanges == null
                  ? 'You have not run "Preview changes" yet. Upload without a preview?'
                  : `The latest preview shows ${lastPreviewChanges} products will change in Shopify.`}
                {limit ? ` Only the first ${limit} products are sent.` : ""}
              </s-text>
              <s-stack direction="inline" gap="small-200">
                <Button
                  variant="primary"
                  onClick={() => {
                    setConfirming(false);
                    onRun(req("apply"));
                  }}
                >
                  Start the upload
                </Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {startError && <s-banner tone="critical">{startError}</s-banner>}

        {job && (
          <s-stack direction="block" gap="small-200">
            <div className={styles.bar}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <s-stack direction="inline" gap="base" justifyContent="space-between">
              <s-text>{statusText(job)}</s-text>
              <s-text color="subdued">
                {isActive(job) && p?.done
                  ? `${formatDuration(p.elapsedMs)} elapsed · about ${formatDuration(p.etaMs)} left`
                  : took
                    ? `Took ${formatDuration(took)}`
                    : ""}
              </s-text>
            </s-stack>
            {job.status === "failed" && job.error && <s-banner tone="critical">{job.error}</s-banner>}
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
      return p?.total ? `${label}: ${p.done} of ${p.total} products` : `${label}: reading the sheet...`;
    case "done":
      return `✓ ${label} finished${p?.total ? ` (${p.total} products)` : ""}.`;
    case "stopped":
      return `${label} stopped${p?.total ? ` after ${p.done} of ${p.total} products` : ""}.`;
    case "failed":
      return `${label} could not finish.`;
  }
}
