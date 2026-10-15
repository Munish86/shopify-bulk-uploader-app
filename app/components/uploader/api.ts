// Calls to the app's own endpoints. Inside Shopify Admin, App Bridge adds the session token to
// every fetch to the app's origin, so no auth code is needed here.
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public problems?: string[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      ...(json !== undefined
        ? { method: rest.method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }
        : {}),
    });
  } catch {
    throw new ApiError("Could not reach the app. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `Error ${res.status}`, res.status, body.problems);
  return body as T;
}

// Shapes returned by the endpoints
export interface SheetInfo {
  name: string;
  worksheets: string[];
  headers: string[];
  headerRow: number;
  rowCount: number;
  preview: Record<string, string>[];
}

// The plan's monthly product allowance, as of when the page loaded
export interface Allowance {
  plan: string;
  limit: number | null; // null = no limit
  used: number;
  remaining: number | null;
}

export interface BackupSummary {
  id: string;
  kind: "upload" | "restore";
  at: string;
  products: number;
  of: string | null;
  hidden: boolean;
  expiresAt: string;
}

export interface JobInfo {
  id: string;
  command: "check" | "plan" | "apply" | "restore-plan" | "restore";
  status: "queued" | "running" | "done" | "failed" | "stopped";
  options: { only?: string; limit?: number; force?: boolean; backup?: string; skipEdited?: boolean } | null;
  progress: { done: number; total: number; elapsedMs: number; etaMs: number } | null;
  counts: Record<string, number> | null;
  error: string | null;
  stopAsked: boolean;
  log?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Thumb {
  name: string;
  where: string;
  url: string | null;
}

export interface ReportRow {
  sheet_rows?: string;
  product_key: string;
  title?: string;
  action?: string;
  found_by?: string;
  shopify_link?: string;
  images_found?: number;
  images_new?: number;
  image_files?: string;
  changes?: string;
  tags_added?: string;
  collections?: string;
  metafields?: string;
  variants?: string;
  warnings?: string;
  error?: string;
}

export interface Report {
  report: ReportRow[];
  images: Record<string, Thumb[]>;
  unmatched: Thumb[];
  csvUrl: string;
}

export const isActive = (j?: JobInfo | null) => !!j && (j.status === "queued" || j.status === "running");
