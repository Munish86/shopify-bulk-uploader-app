// Production smoke test: the built server (npm run build) started the way Railway starts it, against an empty
// PostgreSQL (PGlite) migrated with `prisma migrate deploy`. Checks public pages, that app pages ask for Shopify
// login instead of failing, and that webhooks need Shopify's signature and do their job when signed.
// Run: npm run build && npm run test:smoke
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const SECRET = "smoke-secret";
const APP_PORT = 39000 + Math.floor(Math.random() * 900);
const DB_PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const SHOP = "smoke-store.myshopify.com";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
};

if (!fs.existsSync("build/server/index.js")) {
  console.error("Run npm run build first.");
  process.exit(1);
}

const db = await PGlite.create();
const dbServer = new PGLiteSocketServer({ db, port: DB_PORT, host: "127.0.0.1" });
await dbServer.start();
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable&connection_limit=1`;
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(APP_PORT),
  DATABASE_URL,
  SHOPIFY_API_KEY: "smoke-key",
  SHOPIFY_API_SECRET: SECRET,
  SHOPIFY_APP_URL: BASE,
  SCOPES: "write_products,write_files",
  SUPPORT_EMAIL: "help@smoke.example",
  STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "uploader-smoke-")),
  REDIS_URL: "",
};

// Runs a Node script and resolves with its output (stdout + stderr)
function runNode(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
  });
}

let server;
try {
  // 1. Migrations exactly as `npm run setup` runs them on Railway
  const prismaBin = path.resolve("node_modules/prisma/build/index.js");
  // Async: the database runs in this process, so it must keep answering while Prisma works
  const out = await runNode([prismaBin, "migrate", "deploy"], env);
  check("prisma migrate deploy on an empty database", /applied|No pending/i.test(out), out.slice(-200));
  const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const names = tables.rows.map((r) => r.table_name);
  check(
    "all tables created",
    ["Session", "Shop", "Job", "StoredFile", "ProductState", "UploadedImage", "ProductBackup", "Usage"].every((t) => names.includes(t)),
    names.join(","),
  );

  // 2. The production server
  const serve = path.resolve("node_modules/@react-router/serve/bin.js");
  server = spawn(process.execPath, [serve, "./build/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  let up = false;
  for (let i = 0; i < 360 && !up && server.exitCode == null; i++) {
    try {
      await fetch(BASE + "/");
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!up) throw new Error(`The server did not start:\n${serverLog}`);

  const get = (p, init) => fetch(BASE + p, { redirect: "manual", ...init });

  const home = await get("/");
  const homeHtml = await home.text();
  check("landing page 200", home.status === 200, String(home.status));
  check("landing page has no shop-domain login form", !/name="shop"/.test(homeHtml));
  check("landing page links privacy + support", /href="\/privacy"/.test(homeHtml) && /href="\/support"/.test(homeHtml));

  const privacy = await get("/privacy");
  const privacyHtml = await privacy.text();
  check("privacy page 200 with support email", privacy.status === 200 && privacyHtml.includes("help@smoke.example"));
  check("privacy page names service providers", /Railway/.test(privacyHtml) && /Cloudflare R2/.test(privacyHtml));
  const support = await get("/support");
  check("support page 200 with support email", support.status === 200 && (await support.text()).includes("help@smoke.example"));

  const template = await get("/templates/Shopify-Product-Template.xlsx");
  check("sheet template downloadable", template.status === 200 && (await template.arrayBuffer()).byteLength > 1000);

  const redirectShop = await get(`/?shop=${SHOP}&host=abc`);
  check("landing with ?shop= goes to the app", redirectShop.status >= 300 && redirectShop.status < 400 && /\/app\?/.test(redirectShop.headers.get("location") || ""));

  // App pages and API routes without a Shopify session: never a 500, never data
  for (const p of ["/app", "/app/backups", "/app/plans", `/app?shop=${SHOP}&embedded=1&host=abc`]) {
    const r = await get(p);
    check(`${p} asks for Shopify login (no error)`, r.status !== 500 && r.status < 500, String(r.status));
  }
  for (const p of ["/app/api/jobs", "/app/api/files?kind=image", "/app/api/backups"]) {
    const r = await get(p, { headers: { authorization: "Bearer not-a-real-token" } });
    check(`${p} refuses a fake session token`, r.status >= 300 && r.status < 500 && r.status !== 200, String(r.status));
  }
  const dl = await get("/dl/report/abc?exp=9999999999&sig=bad");
  check("signed download refuses a bad signature", dl.status === 403 || dl.status === 404 || dl.status === 400, String(dl.status));

  // 3. Webhooks
  const hook = async (topic, uri, payload, sign = true) => {
    const body = JSON.stringify(payload);
    const headers = {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-api-version": "2026-10",
      "x-shopify-webhook-id": crypto.randomUUID(),
      "x-shopify-event-id": crypto.randomUUID(),
      "x-shopify-triggered-at": new Date().toISOString(),
      "x-shopify-hmac-sha256": sign ? crypto.createHmac("sha256", SECRET).update(body).digest("base64") : "bad",
    };
    return fetch(BASE + uri, { method: "POST", headers, body });
  };

  await db.query(`INSERT INTO "Shop" ("shop", "updatedAt") VALUES ($1, now())`, [SHOP]);
  await db.query(`INSERT INTO "Job" ("id", "shop", "command", "status") VALUES ('smokejob00001', $1, 'apply', 'running')`, [SHOP]);

  const unsigned = await hook("shop/redact", "/webhooks/compliance", { shop_domain: SHOP }, false);
  check("compliance webhook without a valid signature -> 401", unsigned.status === 401, String(unsigned.status));
  check("unsigned webhook changed nothing", (await db.query(`SELECT 1 FROM "Shop" WHERE shop = $1`, [SHOP])).rows.length === 1);

  for (const topic of ["customers/data_request", "customers/redact"]) {
    const r = await hook(topic, "/webhooks/compliance", { shop_domain: SHOP, customer: { id: 1 } });
    check(`${topic} answered 200`, r.status === 200, String(r.status));
  }

  const uninstall = await hook("app/uninstalled", "/webhooks/app/uninstalled", { id: 1, domain: SHOP });
  check("app/uninstalled answered 200", uninstall.status === 200, String(uninstall.status));
  const job = (await db.query(`SELECT status FROM "Job" WHERE id = 'smokejob00001'`)).rows[0];
  check("uninstall stopped the running job", job?.status === "stopped", job?.status);

  const sub = await hook("app_subscriptions/update", "/webhooks/app/subscriptions_update", {
    app_subscription: { name: "Pro", status: "ACTIVE" },
  });
  check("app_subscriptions/update answered 200", sub.status === 200, String(sub.status));
  const plan = (await db.query(`SELECT plan FROM "Shop" WHERE shop = $1`, [SHOP])).rows[0];
  check("subscription webhook set the plan (no session: from the payload)", plan?.plan === "pro", plan?.plan);

  const redact = await hook("shop/redact", "/webhooks/compliance", { shop_id: 1, shop_domain: SHOP });
  check("shop/redact answered 200", redact.status === 200, String(redact.status));
  check("shop/redact deleted the store's rows", (await db.query(`SELECT 1 FROM "Shop" WHERE shop = $1`, [SHOP])).rows.length === 0);

  check("server logged no errors", !/Error:|TypeError|ReferenceError/.test(serverLog), serverLog.slice(-500));
} finally {
  server?.kill();
  await dbServer.stop();
  await db.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
