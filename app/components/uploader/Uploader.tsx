// The uploader page: settings are edited here and saved automatically; runs happen in the background
// worker and are followed by polling.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoFill,
  dropStaleColumns,
  nothingMapped,
  readiness,
  withDefaults,
  type Settings,
} from "../../lib/uploader";
import { Button } from "../polaris";
import { api, ApiError, isActive, type JobInfo, type Report, type SheetInfo } from "./api";
import { ColumnsSection } from "./ColumnsSection";
import { ImagesSection } from "./ImagesSection";
import { Results } from "./Results";
import { RulesSection } from "./RulesSection";
import { LABEL, RunSection, type RunRequest } from "./RunSection";
import { SheetSection } from "./SheetSection";

const POLL_MS = 2000;
const SAVE_DELAY_MS = 400;

const fetchHistory = () => api<{ jobs: JobInfo[] }>("/app/api/jobs").then((r) => r.jobs);

type SheetResponse = { sheet: SheetInfo | null; error?: string };

// The report of a finished run; null when it has none (failed, or older than the retention period)
async function fetchReport(jobId: string): Promise<Report | null> {
  try {
    return await api<Report>(`/app/api/jobs/${jobId}?report=json`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export interface UploaderProps {
  initialSettings: Settings;
  imageCount: number;
  googleEmail: string;
  latestJob: JobInfo | null;
  templateUrl: string;
}

export function Uploader(props: UploaderProps) {
  // ---- Settings, saved shortly after each change ----
  const [s, setS] = useState<Settings>(() => withDefaults(props.initialSettings));
  const sRef = useRef(s);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const [saveError, setSaveError] = useState("");

  const save = useCallback(async () => {
    clearTimeout(saveTimer.current);
    try {
      await api("/app/api/settings", { json: sRef.current });
      setSaveError("");
    } catch (e) {
      setSaveError(`Your changes were not saved: ${(e as Error).message}`);
      throw e;
    }
  }, []);
  const replace = useCallback(
    (next: Settings) => {
      sRef.current = next;
      setS(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save().catch(() => {}), SAVE_DELAY_MS);
    },
    [save],
  );
  const update = useCallback(
    (fn: (d: Settings) => void) => {
      const next = structuredClone(sRef.current);
      fn(next);
      replace(next);
    },
    [replace],
  );

  // ---- Sheet ----
  const [sheet, setSheet] = useState<SheetInfo | null>(null);
  const [sheetError, setSheetError] = useState("");
  const [sheetLoading, setSheetLoading] = useState(true);
  const [staleNote, setStaleNote] = useState("");

  const applySheet = useCallback(
    (r: SheetResponse) => {
      setSheet(r.sheet);
      setSheetError(r.error || "");
      setStaleNote("");
      if (!r.sheet) return;
      const { settings, dropped } = dropStaleColumns(sRef.current, r.sheet.headers);
      if (dropped) {
        setStaleNote(`${dropped} column links pointed to columns that are not in this sheet and were cleared. Check step 2.`);
      }
      if (dropped || nothingMapped(settings)) {
        replace(nothingMapped(settings) ? autoFill(settings, r.sheet.headers) : settings);
      }
    },
    [replace],
  );

  // Saves the form first, so the server reads the sheet with the current tab and header row
  const reloadSheet = useCallback(async () => {
    setSheetLoading(true);
    try {
      await save();
      applySheet(await api<SheetResponse>("/app/api/sheet"));
    } catch (e) {
      setSheetError((e as Error).message);
    } finally {
      setSheetLoading(false);
    }
  }, [save, applySheet]);

  useEffect(() => {
    let cancelled = false;
    api<SheetResponse>("/app/api/sheet")
      .then((r) => !cancelled && applySheet(r))
      .catch((e) => !cancelled && setSheetError((e as Error).message))
      .finally(() => !cancelled && setSheetLoading(false));
    return () => {
      cancelled = true;
    };
  }, [applySheet]);

  // A new header row number is read once typing stops
  const headerRow = s.sheet?.header_row || 0;
  const firstHeaderRow = useRef(headerRow);
  useEffect(() => {
    if (headerRow === firstHeaderRow.current) return;
    firstHeaderRow.current = headerRow;
    const t = setTimeout(() => void reloadSheet(), 800);
    return () => clearTimeout(t);
  }, [headerRow, reloadSheet]);

  // ---- Images ----
  const [imageCount, setImageCount] = useState(props.imageCount);
  const refreshImages = useCallback(async () => {
    const r = await api<{ files: unknown[] }>("/app/api/files?kind=image");
    setImageCount(r.files.length);
  }, []);

  // ---- Runs ----
  const [job, setJob] = useState<JobInfo | null>(props.latestJob);
  const [report, setReport] = useState<{ jobId: string; data: Report } | null>(null);
  const [startError, setStartError] = useState("");
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<JobInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchHistory()
      .then((jobs) => !cancelled && setHistory(jobs))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the current job until it ends, then load its report and the run list
  const jobId = job?.id;
  const jobStatus = job?.status;
  const active = isActive(job);
  useEffect(() => {
    if (!jobId || jobStatus === "failed") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const finished = (id: string) =>
      Promise.all([fetchReport(id), fetchHistory()]).then(([data, jobs]) => {
        if (stop) return;
        if (data) setReport({ jobId: id, data });
        setHistory(jobs);
      });
    const poll = () =>
      api<{ job: JobInfo }>(`/app/api/jobs/${jobId}`)
        .then((r) => {
          if (stop) return;
          // When the job ends, this state change re-runs the effect, which loads the report
          setJob(r.job);
          if (isActive(r.job)) timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (!stop) timer = setTimeout(poll, POLL_MS * 3);
        });
    if (jobStatus === "queued" || jobStatus === "running") timer = setTimeout(poll, POLL_MS);
    else void finished(jobId).catch(() => {});
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // Progress updates from poll() must not restart the loop: only a new job, or the job starting or
    // ending, does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, active]);

  async function run(r: RunRequest) {
    setStartError("");
    setStarting(true);
    try {
      await save();
      const res = await api<{ job: { id: string } }>("/app/api/jobs", { json: r });
      const created = await api<{ job: JobInfo }>(`/app/api/jobs/${res.job.id}`);
      setReport(null);
      setJob(created.job);
    } catch (e) {
      const err = e as ApiError;
      setStartError(err.problems?.length ? err.problems.join(" ") : err.message);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!job) return;
    try {
      const r = await api<{ job: JobInfo }>(`/app/api/jobs/${job.id}`, { json: { stop: true } });
      setJob({ ...job, ...r.job });
    } catch (e) {
      setStartError((e as Error).message);
    }
  }

  // Products the latest finished preview would change, for the upload confirmation
  const isPreview = (h?: JobInfo | null) => h?.command === "plan" && h.status === "done";
  const lastPreview = isPreview(job) ? job : history.find(isPreview);
  const lastPreviewChanges = lastPreview
    ? Object.entries(lastPreview.counts || {})
        .filter(([a]) => a.startsWith("Will "))
        .reduce((n, [, c]) => n + c, 0)
    : null;

  const headers = sheet?.headers || [];
  const { items, canRun } = readiness(s, { sheetOk: !!sheet && !sheetError, imageCount });
  const locked = active;

  return (
    <>
      {saveError && <s-banner tone="critical">{saveError}</s-banner>}
      <SheetSection
        s={s}
        update={update}
        sheet={sheet}
        sheetError={sheetError}
        sheetLoading={sheetLoading}
        staleNote={staleNote}
        reloadSheet={reloadSheet}
        googleEmail={props.googleEmail}
        templateUrl={props.templateUrl}
        locked={locked}
      />
      <ColumnsSection s={s} update={update} headers={headers} onAutoFill={() => replace(autoFill(sRef.current, headers))} />
      <ImagesSection
        s={s}
        update={update}
        imageCount={imageCount}
        refreshImages={refreshImages}
        googleEmail={props.googleEmail}
        locked={locked}
      />
      <RulesSection s={s} update={update} />
      <RunSection
        ready={items}
        canRun={canRun}
        job={job}
        startError={startError}
        starting={starting}
        lastPreviewChanges={lastPreviewChanges}
        onRun={(r) => void run(r)}
        onStop={() => void stop()}
      />
      {job && report?.jobId === job.id && <Results job={job} report={report.data} />}
      {history.length > 0 && (
        <s-section heading="Recent runs">
          <s-unordered-list>
            {history.map((h) => (
              <s-list-item key={h.id}>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text>
                    {LABEL[h.command]} · {new Date(h.createdAt).toLocaleString()} · {h.status}
                    {h.counts
                      ? ` · ${Object.entries(h.counts)
                          .map(([a, n]) => `${a}: ${n}`)
                          .join(", ")}`
                      : ""}
                  </s-text>
                  {h.id !== job?.id && !isActive(h) && h.status !== "failed" && (
                    <Button variant="tertiary" onClick={() => setJob(h)}>
                      View results
                    </Button>
                  )}
                </s-stack>
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      )}
    </>
  );
}
