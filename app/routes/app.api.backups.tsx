// GET /app/api/backups   this store's backups, newest first (one per upload or restore)
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { listBackups } from "../.server/backups";
import { BACKUP_HIDE_MONTHS, BACKUP_KEEP_MONTHS } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json({ backups: await listBackups(session.shop), hideMonths: BACKUP_HIDE_MONTHS, keepMonths: BACKUP_KEEP_MONTHS });
  } catch (e) {
    return apiError(e);
  }
};
