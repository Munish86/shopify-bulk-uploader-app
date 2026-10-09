import { driveFolderId, type Google } from "./google";
import type { Config } from "./config";
import { norm } from "./util";

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
};

export interface ImageFile {
  name: string; // file name only: "Oslo Sofa_1.jpg"
  stem: string; // without extension: "Oslo Sofa_1"
  ext: string;
  mime: string;
  uid: string; // stable id, used to remember what was already uploaded
  size: number;
  where: string; // shown to the merchant: "Sofas/Oslo Sofa_1.jpg"
  read: () => Promise<Buffer>;
}

// path may include folders ("Sofas/Oslo Sofa_1.jpg"); only the last part is the file name
export function describeImage(
  path: string,
  extra: Pick<ImageFile, "uid" | "size" | "read"> & { where?: string },
): ImageFile {
  const name = path.split(/[\\/]/).pop() || path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return { name, stem, ext, mime: MIME[ext] || "application/octet-stream", where: path, ...extra };
}

async function walkDrive(google: Google, folderId: string, where: string, out: ImageFile[] = []) {
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,size)");
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await google.get(url);
    for (const f of body.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        await walkDrive(google, f.id, `${where}/${f.name}`, out);
      } else {
        out.push(
          describeImage(`${where}/${f.name}`, {
            uid: `drive:${f.id}`,
            size: Number(f.size || 0),
            read: () =>
              google.getBuffer(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`),
          }),
        );
      }
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return out;
}

// uploaded = the merchant's uploaded image files (from the database / file storage)
export async function listImages(
  cfg: Config,
  google: Google,
  uploaded: () => Promise<ImageFile[]>,
): Promise<ImageFile[]> {
  const exts = new Set(cfg.images.extensions.map((e) => String(e).toLowerCase().replace(/^\./, "")));
  let files: ImageFile[] = [];
  if (cfg.images.source === "upload") {
    files = await uploaded();
  } else if (cfg.images.source === "drive") {
    if (!google.enabled) throw new Error("Reading images from Google Drive is not set up on this app yet.");
    files = await walkDrive(google, driveFolderId(cfg.images.drive_folder), "Drive");
  }
  return files.filter((f) => exts.has(f.ext));
}

export interface ImageIndex {
  exact: Map<string, { f: Pick<ImageFile, "name" | "stem" | "uid">; num: number }[]>;
  numbered: Map<string, { f: Pick<ImageFile, "name" | "stem" | "uid">; num: number }[]>;
}

// Builds a lookup from file names.
//  "Meta Name.jpg"      -> exact "meta name"
//  "Meta Name_1.jpg", "Meta Name-2.png", "Meta Name (3).jpg" -> image number 1, 2, 3 of "meta name"
export function buildIndex<F extends Pick<ImageFile, "name" | "stem" | "uid">>(files: F[]) {
  const exact = new Map<string, { f: F; num: number }[]>();
  const numbered = new Map<string, { f: F; num: number }[]>();
  const push = (m: typeof exact, k: string, v: { f: F; num: number }) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(v);
  };
  for (const f of files) {
    const n = norm(f.stem);
    if (!n) continue;
    push(exact, n, { f, num: 0 });
    const m = n.match(/^(.*\S)\s(\d{1,3})$/);
    if (m) push(numbered, m[1], { f, num: Number(m[2]) });
  }
  return { exact, numbered };
}

export function findImages<F extends Pick<ImageFile, "name" | "stem" | "uid">>(
  index: { exact: Map<string, { f: F; num: number }[]>; numbered: Map<string, { f: F; num: number }[]> },
  key: unknown,
): F[] {
  const n = norm(key);
  if (!n) return [];
  const hits = [...(index.exact.get(n) || []), ...(index.numbered.get(n) || [])];
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.num - b.num || a.f.name.localeCompare(b.f.name, undefined, { numeric: true }))
    .filter(({ f }) => (seen.has(f.uid) ? false : (seen.add(f.uid), true)))
    .map(({ f }) => f);
}

// Is an image with this file name already on the product?
// Shopify sometimes appends "_<uuid>" to the file name, which is recognised too.
export function alreadyOnProduct(file: Pick<ImageFile, "stem">, existingUrls: string[]): boolean {
  const want = norm(file.stem);
  return existingUrls.some((u) => {
    let base = String(u).split("?")[0].split("/").pop() || "";
    try {
      base = decodeURIComponent(base);
    } catch {
      /* keep it as it is */
    }
    const have = norm(base.replace(/\.[a-z0-9]+$/i, ""));
    if (have === want) return true;
    if (!have.startsWith(want + " ")) return false;
    return /^[0-9a-f]{8}\b/.test(have.slice(want.length + 1));
  });
}
