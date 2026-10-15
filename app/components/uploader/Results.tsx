import { useMemo, useState } from "react";
import { Segmented, TextField } from "../polaris";
import type { JobInfo, Report } from "./api";
import { LABEL } from "./RunSection";
import styles from "./uploader.module.css";

const PAGE = 50;
const TONE: Record<string, "success" | "info" | "warning" | "critical"> = {
  "Images found": "success",
  Updated: "success",
  Created: "success",
  "Will update": "info",
  "Will create": "info",
  "No images found": "warning",
  "Not found in Shopify": "warning",
  "Plan limit reached": "warning",
  Restored: "success",
  "Will restore": "info",
  Skipped: "warning",
  Error: "critical",
};

// "https://admin.shopify.com/store/x/products/123" -> "shopify:admin/products/123", which App Bridge
// opens inside Shopify Admin instead of a new browser tab
const adminLink = (url?: string) => {
  const id = url?.match(/\/products\/(\d+)/)?.[1];
  return id ? `shopify:admin/products/${id}` : "";
};

export function Results({ job, report }: { job: JobInfo; report: Report }) {
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const restore = job.command.startsWith("restore");
  const shopCols = job.command !== "check" && !restore;
  const sheetCols = !restore; // sheet rows and matched images belong to uploads only

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return report.report.filter(
      (x) =>
        (!filter || x.action === filter) &&
        (!needle || [x.product_key, x.title, x.image_files].some((v) => String(v || "").toLowerCase().includes(needle))),
    );
  }, [report, filter, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const slice = rows.slice(current * PAGE, current * PAGE + PAGE);
  const counts = job.counts || {};

  return (
    <s-section heading={`${LABEL[job.command]} results${job.status === "stopped" ? " (stopped early)" : ""}`}>
      <s-stack direction="block" gap="base">
        <Segmented
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
          options={[
            { value: "", label: `All ${report.report.length}` },
            ...Object.entries(counts).map(([a, n]) => ({ value: a, label: `${a} ${n}` })),
          ]}
        />

        <s-stack direction="inline" gap="base" alignItems="end">
          <div style={{ minWidth: 280 }}>
            <TextField
              label="Search"
              placeholder="Product key, title or file name"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(0);
              }}
            />
          </div>
          <a href={report.csvUrl} download>
            Download report (CSV)
          </a>
        </s-stack>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {sheetCols && <th>Row</th>}
                <th>Product key</th>
                <th>Title</th>
                <th>Result</th>
                {sheetCols && <th>Images</th>}
                {restore && <th>What is put back</th>}
                {shopCols && (
                  <>
                    <th>New images</th>
                    <th>Changes</th>
                    <th>Variants</th>
                    <th>Tags added</th>
                    <th>Collections</th>
                  </>
                )}
                <th>Notes</th>
                {(shopCols || restore) && <th>Shopify</th>}
              </tr>
            </thead>
            <tbody>
              {slice.map((x) => {
                const link = adminLink(x.shopify_link);
                return (
                  <tr key={x.product_key}>
                    {sheetCols && <td>{x.sheet_rows}</td>}
                    <td>{x.product_key}</td>
                    <td className={styles.wrap}>{x.title}</td>
                    <td>
                      <s-badge tone={TONE[x.action || ""] || "neutral"}>{x.action}</s-badge>
                      {x.found_by && <div className={styles.muted}>{x.found_by}</div>}
                    </td>
                    {sheetCols && (
                      <td>
                        <div className={styles.thumbs}>
                          {(report.images[x.product_key] || []).map((im) =>
                            im.url ? (
                              <img key={im.where} loading="lazy" src={im.url} title={im.name} alt={im.name} />
                            ) : (
                              <span key={im.where}>{im.name}</span>
                            ),
                          )}
                        </div>
                      </td>
                    )}
                    {restore && <td className={styles.wrap}>{x.changes}</td>}
                    {shopCols && (
                      <>
                        <td>{x.images_new ?? ""}</td>
                        <td className={styles.wrap}>
                          {[x.changes, x.metafields && `metafields: ${x.metafields}`].filter(Boolean).join(" · ")}
                        </td>
                        <td>{x.variants}</td>
                        <td className={styles.wrap}>{x.tags_added}</td>
                        <td className={styles.wrap}>{x.collections}</td>
                      </>
                    )}
                    <td className={styles.wrap}>
                      {x.error && <span className={styles.err}>{x.error} </span>}
                      {x.warnings}
                    </td>
                    {(shopCols || restore) && <td>{link && <s-link href={link}>Open</s-link>}</td>}
                  </tr>
                );
              })}
              {!slice.length && (
                <tr>
                  <td colSpan={12} className={styles.muted}>
                    No products match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
          {rows.length > PAGE && (
            <s-button onClick={() => setPage(current - 1)} {...(current ? {} : { disabled: true })}>
              Previous
            </s-button>
          )}
          <s-text color="subdued">
            {rows.length > PAGE ? `Page ${current + 1} of ${pages} · ` : ""}
            {rows.length} {rows.length === 1 ? "product" : "products"}
          </s-text>
          {rows.length > PAGE && (
            <s-button onClick={() => setPage(current + 1)} {...(current < pages - 1 ? {} : { disabled: true })}>
              Next
            </s-button>
          )}
        </s-stack>

        {report.unmatched.length > 0 && (
          <s-stack direction="block" gap="small-200">
            <s-heading>Images that match no product</s-heading>
            <s-text color="subdued">Their names do not match any value in the image column. Rename them and upload again.</s-text>
            <div className={styles.gallery}>
              {report.unmatched.slice(0, 200).map((u) => (
                <figure key={u.where}>
                  {u.url && <img loading="lazy" src={u.url} alt={u.name} />}
                  <figcaption>{u.where}</figcaption>
                </figure>
              ))}
            </div>
            {report.unmatched.length > 200 && (
              <s-text color="subdued">...and {report.unmatched.length - 200} more.</s-text>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
