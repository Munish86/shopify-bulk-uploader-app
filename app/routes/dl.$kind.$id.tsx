// Signed downloads (see app/.server/signed.ts). No session here: the signature is the permission.
//   /dl/file/:fileId?shop&exp&sig        an uploaded image (thumbnail) or sheet
//   /dl/report-csv/:jobId?shop&exp&sig   a run's report as CSV
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifySigned } from "../.server/signed";
import { FileMissingError, getStorage } from "../.server/storage";
import { readReport } from "../.server/jobs/service";
import { reportCsv } from "../.server/core/runner";

const SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const kind = params.kind!;
  const id = params.id!;
  const shop = verifySigned(kind, id, new URL(request.url).searchParams);
  if (!shop) return new Response("This link has expired. Go back to the app and try again.", { status: 403 });

  if (kind === "file") {
    const file = await prisma.storedFile.findFirst({ where: { id, shop } });
    if (!file?.storageKey) return new Response("Not found", { status: 404 });
    try {
      const data = await getStorage().get(file.storageKey);
      const image = file.kind === "image";
      return new Response(new Uint8Array(data), {
        headers: {
          ...SAFE_HEADERS,
          "content-type": file.mime,
          "cache-control": "private, max-age=3600",
          "content-disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name.split("/").pop()!)}`,
        },
      });
    } catch (e) {
      if (e instanceof FileMissingError) return new Response("Not found", { status: 404 });
      throw e;
    }
  }

  if (kind === "report-csv") {
    const report = await readReport(shop, id);
    if (!report) return new Response("Not found", { status: 404 });
    return new Response(reportCsv(report.rows), {
      headers: {
        ...SAFE_HEADERS,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="report-${id}.csv"`,
      },
    });
  }

  return new Response("Not found", { status: 404 });
};
