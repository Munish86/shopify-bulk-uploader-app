// The shop's form settings.
//   GET  /app/api/settings   settings
//   POST /app/api/settings   save (the whole settings object). Unknown fields are dropped.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { apiError } from "../.server/http";
import { cleanSettings } from "../.server/core/config";
import { getSettings, saveSettings } from "../.server/shops";
import { JobError } from "../.server/jobs/service";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    return Response.json({ settings: await getSettings(session.shop) });
  } catch (e) {
    return apiError(e);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const text = await request.text();
    if (text.length > 200_000) throw new JobError("Settings are too large.", 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JobError("Send the settings as JSON.");
    }
    const settings = cleanSettings(body);
    await saveSettings(session.shop, settings);
    return Response.json({ settings });
  } catch (e) {
    return apiError(e);
  }
};
