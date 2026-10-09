// Runs.
//   GET  /app/api/jobs   the latest runs of this store
//   POST /app/api/jobs   { command: "check" | "plan" | "apply", only?, limit?, force? } starts a run
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { enqueueJob, JobError, listJobs, parseJobRequest } from "../.server/jobs/service";
import { normalizeConfig } from "../.server/core/config";
import { getSettings } from "../.server/shops";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json({ jobs: await listJobs(session.shop) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const body = await request.json().catch(() => {
      throw new JobError("Send the run as JSON.");
    });
    const { command, options } = parseJobRequest(body);
    // Settings problems are reported now, not after the job has queued
    normalizeConfig(await getSettings(session.shop));
    const job = await enqueueJob(session.shop, command, options);
    return Response.json({ job: { id: job.id, status: job.status, command: job.command } }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
};
