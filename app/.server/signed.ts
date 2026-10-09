// Short-lived signed links for things the browser loads without the app's session token:
// image thumbnails (<img src>) and report downloads (<a href>). The signature covers the shop, the kind,
// the id and the expiry, so a link cannot be changed to point at another store's file.
import crypto from "node:crypto";

export type SignedKind = "file" | "report-csv";

const secret = () => {
  const s = process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET is not set");
  return s;
};

const mac = (kind: string, shop: string, id: string, exp: number) =>
  crypto.createHmac("sha256", secret()).update(`${kind}\n${shop}\n${id}\n${exp}`).digest("base64url");

export function signedUrl(kind: SignedKind, shop: string, id: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const q = new URLSearchParams({ shop, exp: String(exp), sig: mac(kind, shop, id, exp) });
  return `/dl/${kind}/${encodeURIComponent(id)}?${q}`;
}

// Returns the shop the link was made for, or null if it is forged or expired
export function verifySigned(kind: string, id: string, params: URLSearchParams): string | null {
  const shop = params.get("shop") || "";
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") || "";
  if (!shop || !Number.isInteger(exp) || exp < Date.now() / 1000) return null;
  const want = Buffer.from(mac(kind, shop, id, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? shop : null;
}
