// GET /app/api/sheet: the current sheet's column names, row count, tabs and the first 5 rows,
// read the same way a run reads it. { sheet: null } when no sheet is set; { error } when it cannot be read.
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { normalizeConfig } from "../.server/core/config";
import { listWorksheets, loadRows } from "../.server/core/sheet";
import { sheetSource } from "../.server/files";
import { getGoogle } from "../.server/clients";
import { getSettings } from "../.server/shops";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const cfg = normalizeConfig(await getSettings(session.shop), { requireAll: false });
    if (cfg.sheet.source === "file" ? !cfg.sheet.fileId : !cfg.sheet.google_sheet) return Response.json({ sheet: null });
    try {
      const google = getGoogle();
      const src = await sheetSource(session.shop, cfg);
      const { headers, rows, headerRow } = await loadRows(src, cfg.sheet, google);
      const worksheets = await listWorksheets(src, google).catch(() => []);
      return Response.json({
        sheet: {
          name: src.kind === "file" ? src.name : "Google Sheet",
          worksheets,
          headers: headers.filter(Boolean),
          headerRow,
          rowCount: rows.length,
          preview: rows.slice(0, 5),
        },
      });
    } catch (e) {
      return Response.json({ sheet: null, error: (e as Error).message });
    }
  } catch (e) {
    return apiError(e);
  }
};
