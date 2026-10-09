# Project progress and handoff

Read this first when starting a new session. It records the decisions made, what is done, and what comes next.
The owner's checklist up to App Store launch (who does what, costs, timeline) is in `docs/ROADMAP.md`.
Last updated: 2026-10-09 (end of Phase 3).

## Goal

Turn the desktop tool in `../shopify-bulk-uploader` (Node.js, runs only on one computer, no login) into a
**public Shopify App Store app** that many merchants install on their own stores.

The desktop tool stays as it is and keeps working. All new work happens in `shopify-bulk-uploader-app/`.

## Decisions (made with the owner, do not reopen)

| Topic | Decision |
|---|---|
| Distribution | Public, listed on the **Shopify App Store** (review required) |
| Billing | **Monthly plans through Shopify Billing API** (e.g. Free with a monthly product limit, Pro, Unlimited). Prices not decided yet |
| Hosting | **Railway**: web + worker + PostgreSQL + Redis in one place |
| File storage | **Cloudflare R2**, files auto-deleted after about 7 days |
| Framework | Shopify's official React Router app template, TypeScript, Polaris web components (`<s-page>` etc.) |
| Database | PostgreSQL via Prisma |
| Jobs | Redis + BullMQ, separate worker process |
| Google | One app-wide service account (`GOOGLE_SERVICE_ACCOUNT_JSON`). Merchants share their Sheet / Drive folder with its email. Public "anyone with the link" sheets also work |

## Phases

| # | Work | Estimate | State |
|---|---|---|---|
| 1 | Template, OAuth install, DB schema, core logic ported to TS, privacy webhooks | 1 week | **Done (code). Not yet run on a real store** |
| 2 | BullMQ job queue + worker, R2 storage, per-store isolation, rate limits | 1 week | **Done (code). Not yet run against real Postgres / Redis / R2** |
| 3 | Polaris UI: sheet upload, column mapping, images, preview table, progress, reports | 1.5-2 weeks | **Done (code). Checked in a real browser with a fake API; not yet inside Shopify Admin** |
| 4 | Billing plans + monthly product limits, uninstall cleanup | 3-4 days | Next |
| 5 | Testing on dev stores, performance, listing (screenshots, privacy policy, support page) | 1 week | |
| 6 | App Store review and fixes | 1-4 weeks | |

## Phase 1: what was built

- Cloned the official template (`Shopify/shopify-app-template-react-router`), removed its repo-only files and demo pages.
- `shopify.app.toml`: name "Bulk Product Uploader", scopes `write_products,write_files`, webhooks
  `app/uninstalled`, `app/scopes_update`, and the three compliance topics on `/webhooks/compliance`.
  `client_id` is still empty: filled by `npm run config:link`.
- API version **2026-10** (`ApiVersion.October26`) in `app/shopify.server.ts` and `.graphqlrc.ts`, same as the webhooks version.
- `afterAuth` hook records the install in the `Shop` table.
- Core logic ported 1:1 from the desktop tool's `src/*.js` into `app/.server/core/*.ts`:
  `util`, `config`, `google`, `sheet`, `images`, `build`, `shopify`, `runner`.
  Differences from the desktop tool:
  - No file system access in core. The runner gets `sheet` (bytes or Google link), `uploadedImages()`,
    `google`, `shopify` and a `RunStore` (fingerprints, uploaded images, backups) from the caller.
  - Shopify client takes `accessToken(refresh?)`; on a 401 it refreshes once (expiring offline tokens).
    Store-domain lookup and client-credentials login were removed (OAuth replaces them).
  - Settings use `sheet.source: file|google` + `sheet.fileId`, and `images.source: none|upload|drive`
    (`local` is accepted as an alias of `upload`).
  - Limits: sheet 25 MB, 50,000 rows; images over 20 MB skipped (as before).
  - Google IDs from merchant links are validated (`^[\w-]{10,200}$`) before they reach any URL.
- App services in `app/.server/`:
  - `storage.ts`: `FileStorage` interface + `LocalDiskStorage` (`STORAGE_DIR`). Keys are
    `<shop>.myshopify.com/files/<id>`, checked by `checkKey`. **R2 implementation goes here in Phase 2.**
  - `run-store.ts`: Prisma-backed `RunStore`, and `uploadedImages(shop)` from `StoredFile` rows.
  - `clients.ts`: `shopifyFor(shop)` (offline session via `unauthenticated.admin`, token cached 5 min), `getGoogle()`.
  - `shops.ts`: `recordInstall`, `recordUninstall` (deletes sessions, stops queued/running jobs),
    `getSettings` / `saveSettings`, `deleteShopData` (shop/redact: storage + all rows).
- Prisma schema (PostgreSQL): `Session`, `Shop`, `Job`, `StoredFile`, `ProductState`, `UploadedImage`,
  `ProductBackup`. All shop tables cascade-delete with `Shop`. Migration `prisma/migrations/20261009000000_init`.
- Routes: `app._index.tsx` home page (store name, missing-permission banner, Google email, counts),
  `webhooks.app.uninstalled.tsx`, `webhooks.compliance.tsx`, landing page copy in `_index/route.tsx`.
- Tests (vitest, `test/`): 27 tests. Ported desktop tests + settings, input safety, sheets (header
  detection, BOM, size limit) and a full check -> plan -> apply run against `test/mock-shopify.ts`.

### Verified
`npm test` (27 passed), `npm run typecheck`, `npm run build`, `npm run lint` all clean on 2026-10-09.

### Not verified yet
- Installing on a real development store (OAuth, `afterAuth`, home page, webhooks).
- The migration against a real PostgreSQL database.
Both need the owner's Partner account and a database URL (see below).

## Real setup (2026-10-09)

Done by the owner: Partner org "ZingwithCloude", dev store `bulk-uploader-test.myshopify.com`, Neon
database (us-east-2, direct connection, in `.env`), app "Bulk Product Uploader" linked
(`client_id` 291468f078a529c283ad1a2e1213d750 in `shopify.app.toml`), installed on the dev store.

Verified on the real setup: both migrations applied on Neon; scopes `write_files, write_products`
granted; the app loads in Admin through the dev tunnel and a session is stored in Postgres.
In progress: the owner testing the upload form (check / preview / upload) in the dev store.

Problems found and fixed:
- This PC's system PATH lacks `C:\Windows\System32`, so the Shopify CLI failed with `spawn taskkill
  ENOENT`. Workaround per terminal: `$env:Path += ";C:\Windows\System32;C:\Windows"` before
  `npm run dev`. The owner still has to add it to the system PATH permanently.
- `npm run config:link` overwrote `shopify.app.toml` from the new remote app: `scopes = ""` and webhook
  `api_version = "2027-01"`. Restored to `write_products,write_files` and `2026-10`. Check this after any
  future `config:link`.
- Neon's free compute suspends when idle; waking takes seconds and Prisma's 5 s default connect timeout
  made `session.upsert` fail with P1001 on the first page load. Fixed with `connect_timeout=30&pool_timeout=30`
  on `DATABASE_URL` (also needed in production if Neon is kept). Backup of the old `.env` was taken.

## Waiting on the owner

1. Finish the local test in the dev store (see `docs/ROADMAP.md`) and report bugs.
2. Add `C:\Windows\System32` and `C:\Windows` to the system PATH.
3. Plan names, prices, monthly product limits and free trial (blocks Phase 4).
4. Later: GitHub, Railway and Cloudflare accounts, a domain/subdomain, privacy policy + support email,
   app icon, demo video, $19 App Store registration.

## Phase 2: what was built

- **Storage** (`app/.server/storage.ts`): `R2Storage` (S3 API via `@aws-sdk/client-s3`) and
  `LocalDiskStorage`; R2 when `R2_BUCKET` is set. `FileMissingError` for expired/missing files.
  Keys: `<shop>/files/<StoredFile id>` and `<shop>/files/report-<jobId>.json`.
- **Uploads** (`app/.server/files.ts`): one file per request, raw body. Name cleaned (`cleanName`) and kept
  for display/matching only. Limits: image 20 MB, sheet 25 MB, 5000 images / 3 GB per shop. A new sheet
  replaces the old one and becomes `settings.sheet.fileId`; an image with the same name is replaced.
  Files cannot change while a run is active (409).
- **Jobs** (`app/.server/jobs/`):
  - `process.ts`: `processJob(jobId, deps)` with an injectable `JobRepo`. Claim (queued -> running,
    attempts + 1), heartbeat every 2 s (progress, last 100k chars of log, reads `stopAsked`), report to
    storage, finish `done|failed|stopped`. On worker shutdown: stops after products in progress and
    re-queues (`requeued`). More than 3 attempts -> failed.
  - `service.ts`: `parseJobRequest` (validates browser input), `enqueueJob` (locks the Shop row with
    `SELECT ... FOR UPDATE`, one active job per shop, 409 otherwise), `requestStop`, `getJob`, `listJobs`,
    `readReport`, `prismaJobRepo`, `sweepJobs` (stale heartbeat > 2 min -> re-queue; queued > 10 min ->
    re-add), `cleanupOldData` (files 7 days, backups 30, jobs 90; skips shops with an active run).
  - `queue.ts`: BullMQ queue when `REDIS_URL` is set (ioredis client built by us: BullMQ 6 needs a
    client instance in ESM), otherwise `InProcessQueue` inside the web server (local dev).
  - `deps.ts`: production wiring.
- **Worker** (`worker.ts`): checks env first, then BullMQ `Worker` (`WORKER_CONCURRENCY`, default 4),
  sweep every minute, cleanup hourly, graceful SIGTERM. Built by esbuild to `build/worker/index.js`
  (`npm run build` builds both). Start with `npm run worker`.
- **Endpoints** (resource routes, `authenticate.admin`): `app.api.files.tsx`, `app.api.jobs.tsx`,
  `app.api.jobs.$id.tsx` (status/log, `?report=json|csv`, `{ stop: true }`). Errors via `apiError` in
  `app/.server/http.ts`; `readBody` enforces size while streaming.
- **Schema**: `Job` gained `reportKey`, `heartbeatAt`, `attempts`; `report` column removed. Migration
  `20261009120000_job_worker`.
- **Dockerfile**: installs all deps, builds, then prunes dev deps (vite is a dev dep). Same image for the
  web and worker services on Railway. README has the Railway setup.
- Tests: 40 (13 new in `test/jobs.test.ts`: processJob done/plan/skip/settings error/missing sheet/stop/
  shutdown re-queue/attempt limit, in-process queue, request validation, file names, body limit, disk storage).

### Verified (2026-10-09)
`npm test` 40 passed; typecheck, lint, build (app + worker) clean. The worker bundle was started:
it refuses to start with a clear message when env is missing, and with env set it starts and keeps
retrying an unreachable Redis without crashing.

### Not verified yet
- `prismaJobRepo`, `enqueueJob` (row lock), `sweepJobs`, `cleanupOldData`, `files.ts` against a real
  PostgreSQL database.
- BullMQ against a real Redis; `R2Storage` against a real bucket.
- The endpoints through real App Bridge authentication (needs the dev store).

## Phase 3: what was built

The desktop tool's page (`../shopify-bulk-uploader/src/web/index.html`) rebuilt in React + Polaris web
components on `app/routes/app._index.tsx`, five steps on one page:
1. **Sheet**: upload Excel/CSV (drag or choose) or a Google Sheet link; tab and header-row choice; preview of
   the first rows; downloadable template.
2. **Columns**: "Auto-fill from column names", ordered "find products by" rules, every product field,
   variant option checkboxes, metafields (auto-created from headers like `Material (custom.material)`).
   Auto-fill runs by itself on a new sheet when nothing is mapped; links to columns missing from a newly
   loaded sheet are cleared with a warning.
3. **Images**: none / upload (folder drag with sub-folders, choose folder, choose files; 4 uploads at a
   time with progress; remove all) / Google Drive link; image mode.
4. **Update rules**: tags mode, new product status, speed, create products / collections, keep variants.
5. **Run**: readiness checklist, check / preview / upload (upload asks first, quoting the latest
   preview), only first N, only these keys, re-send; progress bar with ETA, log, stop.
Then **results** (filter buttons, search, 50 per page, thumbnails, admin links that open inside Admin via
`shopify:admin/products/<id>`, unmatched images, CSV download) and **recent runs** (view any past report).

Files:
- `app/components/polaris.tsx`: wrappers for `s-text-field`, `s-number-field`, `s-select`, `s-checkbox`,
  `s-button`, and `Segmented` (row of buttons). See the gotchas below for why they exist.
- `app/components/uploader/`: `Uploader.tsx` (state, autosave 400 ms after a change, sheet loading,
  polling every 2 s), `SheetSection`, `ColumnsSection`, `ImagesSection`, `RulesSection`, `RunSection`,
  `Results`, `api.ts` (fetch helper + response types), `uploader.module.css`.
- `app/lib/uploader.ts`: browser-side form logic (FIELDS with auto-fill patterns, RULE_FIELDS, MF_TYPES,
  `autoFill`, `defaultRules`, `dropStaleColumns`, `readiness`, `withDefaults`).
- Server: `app.api.settings.tsx` (saves `cleanSettings(body)`: known fields only, bounded, 200 KB max),
  `app.api.sheet.tsx` (headers, rows, tabs, preview), `app/.server/signed.ts` + `routes/dl.$kind.$id.tsx`
  (HMAC-signed links, 1 hour, for `<img>` thumbnails and the CSV; nosniff + sandbox CSP).
- The report saved per run is now `{ rows, details }` (`SavedReport`); `details` lists the images matched
  to each product with their uid, so thumbnails can be shown. `ImageRef` in `runner.ts`.
- `public/templates/Shopify-Product-Template.xlsx`: generic template (Product Key, Image Name; no client
  names), generated by `scripts/build-template.cjs` (adapted from the desktop tool; needs
  `npm install --no-save exceljs@4` to run).
- Tests: 52 vitest tests (`test/ui.test.ts` added: auto-fill on the template's columns, stale columns,
  checklist, `cleanSettings` incl. a `__proto__` body, signed links, server render of the page) and a
  browser test `npm run test:browser` (`test/browser/`): bundles the real `Uploader` with a fake API,
  loads Polaris from Shopify's CDN, drives it in local Chrome/Edge with playwright-core (23 checks:
  values shown and sent for select/checkbox/text/segmented, autosave, run with options, progress, results,
  thumbnails, filters, upload confirmation, no page errors). Screenshots in `test/browser/.out/`.

### Verified (2026-10-09)
`npm test` 52 passed; `npm run test:browser` all 23 checks passed; typecheck, lint, build clean.
The browser test found and fixed: chosen button hidden inside `s-button-group`, `s-clickable-chip`
clicks not reaching React, and the upload confirmation ignoring the preview that had just finished.

### Not verified yet
- The page inside Shopify Admin (App Bridge session token on fetch, `shopify:admin` links, iframe downloads).
- Everything listed under Phase 1 and 2 as not verified (real store, Postgres, Redis, R2).

## Next: Phase 4 plan (billing)

1. Decide plans with the owner (names, prices, monthly product limits, free trial days). Suggested:
   Free (e.g. 50 products updated per month), Pro, Unlimited.
2. Shopify Billing API through `shopifyApp({ billing: {...} })` in `app/shopify.server.ts`
   (recurring app subscriptions; `isTest` on development stores).
3. Plan page (`app.plans.tsx` + nav link): current plan, usage this month, upgrade / downgrade via
   `billing.request`, cancel via `billing.cancel`. Keep `Shop.plan` in sync (also from the
   `app_subscriptions/update` webhook).
4. Usage: count products actually created/updated per shop per calendar month (new table, written by the
   worker after each saved product). Check / preview stay free.
5. Enforce the limit: `enqueueJob` refuses an upload that cannot fit, and the worker stops a run when the
   limit is reached (report says why). Show remaining products in the Run section.
6. Tests for limits and plan changes; browser test for the plan page.

## Commands

```
npm install
npm test            # vitest
npm run typecheck
npm run lint
npm run build       # app + worker
npm run worker      # after build; needs REDIS_URL and the app's env
npm run dev         # Shopify CLI: migrations, tunnel, install link (needs Partner login + DATABASE_URL)
npx prisma migrate dev --name <change>   # after editing prisma/schema.prisma (needs a database)
```

To generate a migration without a database (as done so far): keep a copy of the previous schema and run
`npx prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel prisma/schema.prisma --script`.

## Gotchas learned

- Code under `app/.server/` never reaches the browser; keep Node-only code there.
- `xlsx` is installed from the SheetJS CDN (0.20.3). The npm registry version 0.18.5 has known
  vulnerabilities. Do not "upgrade" it back to the npm version.
- Template files have Windows CRLF line endings; regex replacements on them need `\r?\n`.
- Do not put a literal byte-order-mark character in source; use `String.fromCharCode(0xfeff)` /
  `charCodeAt(0) === 0xfeff` (ESLint `no-irregular-whitespace`).
- ESLint: `no-explicit-any` is an error. Raw Admin API JSON files use a file-level disable with a reason.
  Unused rest siblings (`{ a, ...rest }`) are allowed.
- `tsconfig.json` includes `@shopify/app-bridge-types` so `<s-app-nav>` type-checks.
- `vitest.config.ts` is separate from `vite.config.ts` so tests run without the React Router plugin.
- Prisma CLI suggests a v8 upgrade; stay on 6.x (the template's session storage targets it).
- BullMQ 6: `ioredis` is optional and connection options do not work in ESM; pass `new Redis(url,
  { maxRetriesPerRequest: null, family: 0 })`, one client per Queue / Worker (`redisConnection()`).
- `worker.ts` must check env before importing app code: `shopify.server.ts` throws on import without
  `SHOPIFY_APP_URL`. App modules are loaded with `await import()` after the check.
- On this Windows machine, `npm install` of large packages takes ~10 minutes and makes other shell
  commands time out meanwhile; run it in the background and wait.
- Inline `node -e '...'` scripts break on apostrophes in the text; use the Write/Edit tools for prose.
- Polaris web components with React 18 (the template's version): React does not attach `onChange` /
  `onInput` to custom elements and does not set `value` / `checked` as properties, so use the wrappers in
  `app/components/polaris.tsx`. React 18 also renders `disabled={false}` as `disabled="false"`, which still
  disables: add boolean attributes only when true (`flag()` or a conditional spread). `onClick` on
  `s-button` works; on `s-clickable-chip` it did not, so filters use buttons.
- `s-button-group` hides a `variant="primary"` button placed in `secondary-actions`; `Segmented` uses
  `s-stack` instead.
- Lint runs the React Compiler hook rules (`react-hooks/refs`, `set-state-in-effect`): no ref writes during
  render, and in effects call setState only inside `.then()` callbacks, not through a helper that sets
  state before its first await.
- `s-banner heading` renders the heading twice in the DOM; count banners, not heading text, in tests.
- Thumbnails and downloads cannot use the session token (plain `<img>` / `<a>`): use `signedUrl()`.
- When Claude runs `npm run dev` in the background for the owner, the owner must not start a second one
  (a new tunnel replaces the app URL). Stop the background task before the owner runs their own.
- For production: keep the dev app and create a separate production app config
  (`shopify.app.production.toml`), as Shopify recommends.
