// One run.
//   GET  /app/api/jobs/:id                 status, progress, counts, log
//   GET  /app/api/jobs/:id?report=json     report rows, image thumbnails, unmatched images, CSV link
//   GET  /app/api/jobs/:id?report=csv      the report as a CSV download
//   POST /app/api/jobs/:id  { stop: true } stop the run
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { getJob, JobError, readReport, requestStop } from "../.server/jobs/service";
import { reportCsv, type ImageRef } from "../.server/core/runner";
import { signedUrl } from "../.server/signed";

// Uploaded images get a thumbnail link; Drive images are shown by name
const withThumb = (shop: string) => (img: ImageRef) => ({
  name: img.name,
  where: img.where,
  url: img.uid?.startsWith("upload:") ? signedUrl("file", shop, img.uid.slice(7)) : null,
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const id = params.id!;
    const report = new URL(request.url).searchParams.get("report");
    if (report) {
      const saved = await readReport(shop, id);
      if (!saved) throw new JobError("This run has no report (yet).", 404);
      if (report === "csv") {
        return new Response(reportCsv(saved.rows), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="report-${id}.csv"`,
          },
        });
      }
      const job = await getJob(shop, id, { withLog: true });
      const thumb = withThumb(shop);
      const images: Record<string, ReturnType<typeof thumb>[]> = {};
      for (const [key, list] of Object.entries(saved.details || {})) images[key] = list.map(thumb);
      const unmatched = ((job?.unmatched as ImageRef[] | null) || []).map(thumb);
      return Response.json({ report: saved.rows, images, unmatched, csvUrl: signedUrl("report-csv", shop, id) });
    }
    const job = await getJob(shop, id, { withLog: true });
    if (!job) throw new JobError("Run not found.", 404);
    const { unmatched: _u, ...rest } = job;
    return Response.json({ job: rest });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const body = await request.json().catch(() => ({}));
    if (body?.stop !== true) throw new JobError('Send { "stop": true } to stop the run.');
    const job = await getJob(session.shop, params.id!);
    if (!job) throw new JobError("Run not found.", 404);
    await requestStop(session.shop, job.id);
    return Response.json({ job: await getJob(session.shop, job.id) });
  } catch (e) {
    return apiError(e);
  }
};
