// Uploaded sheets and images.
//   GET    /app/api/files?kind=image             list
//   POST   /app/api/files?kind=image&name=a.jpg  upload one file (raw body). A folder path in name is kept for display
//   DELETE /app/api/files?kind=image[&id=...]     delete one, or all of that kind
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { checkUpload, deleteFiles, LIMITS, listFiles, saveUpload, UploadError, type FileKind } from "../.server/files";
import { apiError, readBody } from "../.server/http";
import { ACTIVE } from "../.server/jobs/service";
import prisma from "../db.server";

const kindOf = (url: URL): FileKind => {
  const kind = url.searchParams.get("kind");
  if (kind !== "sheet" && kind !== "image") throw new UploadError('kind must be "sheet" or "image".');
  return kind;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const files = await listFiles(session.shop, kindOf(new URL(request.url)));
    return Response.json({ files, limits: LIMITS });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const kind = kindOf(url);

    // Files must not change under a run that is reading them
    const busy = await prisma.job.findFirst({ where: { shop: session.shop, status: { in: ACTIVE } }, select: { id: true } });
    if (busy) throw new UploadError("A run is in progress. Change files after it finishes.", 409);

    if (request.method === "POST" || request.method === "PUT") {
      const name = url.searchParams.get("name") || "";
      // Check name and declared size before reading the body
      checkUpload(kind, name, Number(request.headers.get("content-length") || 1));
      const data = await readBody(request, kind === "sheet" ? LIMITS.sheetBytes : LIMITS.imageBytes);
      return Response.json({ file: await saveUpload(session.shop, kind, name, data) });
    }
    if (request.method === "DELETE") {
      const deleted = await deleteFiles(session.shop, kind, url.searchParams.get("id") || undefined);
      return Response.json({ deleted });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (e) {
    return apiError(e);
  }
};
