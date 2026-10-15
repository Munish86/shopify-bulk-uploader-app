import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listBackups } from "../.server/backups";
import { listJobs } from "../.server/jobs/service";
import { BACKUP_HIDE_MONTHS, BACKUP_KEEP_MONTHS } from "../lib/plans";
import { Backups } from "../components/uploader/Backups";
import type { BackupSummary, JobInfo } from "../components/uploader/api";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [backups, jobs] = await Promise.all([listBackups(session.shop), listJobs(session.shop, 1)]);
  return {
    list: { backups: backups as BackupSummary[], hideMonths: BACKUP_HIDE_MONTHS, keepMonths: BACKUP_KEEP_MONTHS },
    latestJob: (jobs[0] ?? null) as unknown as JobInfo | null,
  };
};

export default function BackupsPage() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Backups and undo">
      <Backups initial={d.list} latestJob={d.latestJob} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
