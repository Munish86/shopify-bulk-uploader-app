import { useRef, useState } from "react";
import type { Settings } from "../../lib/uploader";
import { Button, NumberField, Segmented, Select, TextField } from "../polaris";
import { api, type SheetInfo } from "./api";
import styles from "./uploader.module.css";

const SHEET_ACCEPT = ".xlsx,.xlsm,.xls,.csv";

export function SheetSection({
  s,
  update,
  sheet,
  sheetError,
  sheetLoading,
  staleNote,
  reloadSheet,
  googleEmail,
  templateUrl,
  locked,
}: {
  s: Settings;
  update: (fn: (d: Settings) => void) => void;
  sheet: SheetInfo | null;
  sheetError: string;
  sheetLoading: boolean;
  staleNote: string;
  reloadSheet: () => Promise<void>;
  googleEmail: string;
  templateUrl: string;
  locked: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const source = s.sheet?.source === "google" ? "google" : "file";

  async function upload(file: File) {
    setUploadError("");
    setUploading(true);
    try {
      const res = await api<{ file: { id: string } }>(`/app/api/files?kind=sheet&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      // The server made this the shop's sheet; keep the form in step
      update((d) => {
        d.sheet = { ...d.sheet, source: "file", fileId: res.file.id };
      });
      await reloadSheet();
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const tabOptions = [
    { value: "", label: source === "google" ? "Tab in the link" : "First tab" },
    ...(sheet?.worksheets || []).map((w) => ({ value: w, label: w })),
  ];

  return (
    <s-section heading="1. Product sheet">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          The first row holds the column names. For products with variants, add one row per variant with the same
          product key.{" "}
          <a href={templateUrl} download>
            Download the product template (Excel)
          </a>{" "}
          with a column for every field, a filled-in example and a guide.
        </s-paragraph>

        <Segmented
          value={source}
          onChange={(v) => {
            update((d) => {
              d.sheet = { ...d.sheet, source: v };
            });
            void reloadSheet();
          }}
          options={[
            { value: "file", label: "Excel or CSV file" },
            { value: "google", label: "Google Sheet link" },
          ]}
        />

        {source === "file" ? (
          <div
            className={`${styles.drop} ${over ? styles.dropOver : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f && !locked) void upload(f);
            }}
          >
            <s-stack direction="block" gap="small-200" alignItems="center">
              <s-text>Drag an Excel (.xlsx) or CSV file here</s-text>
              <input
                ref={input}
                type="file"
                accept={SHEET_ACCEPT}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(f);
                }}
              />
              <Button onClick={() => input.current?.click()} loading={uploading} disabled={locked}>
                Choose file
              </Button>
            </s-stack>
          </div>
        ) : (
          <s-stack direction="block" gap="small-200">
            <TextField
              label="Google Sheet link"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={s.sheet?.google_sheet || ""}
              onChange={(v) =>
                update((d) => {
                  d.sheet = { ...d.sheet, google_sheet: v };
                })
              }
            />
            <s-stack direction="inline" gap="base" alignItems="center">
              <Button onClick={() => void reloadSheet()} loading={sheetLoading}>
                Load sheet
              </Button>
              <s-text color="subdued">
                {googleEmail
                  ? `Share the sheet (Viewer) with ${googleEmail}, or as "Anyone with the link can view".`
                  : 'Share the sheet as "Anyone with the link can view".'}
              </s-text>
            </s-stack>
          </s-stack>
        )}

        {locked && <s-text color="subdued">The sheet cannot be changed while a run is in progress.</s-text>}
        {uploadError && <s-banner tone="critical">{uploadError}</s-banner>}
        {sheetError && <s-banner tone="critical">{sheetError}</s-banner>}
        {sheet && !sheetError && (
          <s-banner tone="success">
            {sheet.name}: {sheet.rowCount} rows, {sheet.headers.length} columns (column names from row {sheet.headerRow})
          </s-banner>
        )}
        {staleNote && <s-banner tone="warning">{staleNote}</s-banner>}

        {sheet && (
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="base">
            {sheet.worksheets.length > 1 && (
              <Select
                label="Tab"
                value={s.sheet?.worksheet || ""}
                options={tabOptions}
                onChange={(v) => {
                  update((d) => {
                    d.sheet = { ...d.sheet, worksheet: v };
                  });
                  void reloadSheet();
                }}
              />
            )}
            <NumberField
              label="Row with the column names"
              placeholder="Auto"
              min={0}
              value={s.sheet?.header_row ? s.sheet.header_row : ""}
              details="Leave on Auto, or type the row number if the sheet has notes above the column names"
              onChange={(v) =>
                update((d) => {
                  d.sheet = { ...d.sheet, header_row: v === "" ? 0 : v };
                })
              }
            />
          </s-grid>
        )}
        {sheet && (
          <s-stack direction="inline" gap="base">
            <Button variant="tertiary" onClick={() => void reloadSheet()} loading={sheetLoading}>
              Read the sheet again
            </Button>
          </s-stack>
        )}

        {sheet && sheet.preview.length > 0 && (
          <details>
            <summary>Preview the first {sheet.preview.length} rows</summary>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {sheet.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.preview.map((r, i) => (
                    <tr key={i}>
                      {sheet.headers.map((h) => (
                        <td key={h}>{String(r[h] ?? "").slice(0, 80)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </s-stack>
    </s-section>
  );
}
