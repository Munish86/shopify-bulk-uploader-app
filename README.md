# Bulk Product Uploader (Shopify app)

A public Shopify app that bulk-updates or creates products from a sheet (Excel, CSV or Google Sheets) and a folder of images: titles, descriptions, meta titles, tags, collections, variants, prices, metafields and images matched by file name.

It is the multi-store version of the desktop tool in `../shopify-bulk-uploader`. The upload logic is the same code, ported to TypeScript.

Built on Shopify's official [React Router app template](https://github.com/Shopify/shopify-app-template-react-router): embedded in Shopify Admin, Polaris web components, OAuth and session tokens handled by `@shopify/shopify-app-react-router`.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Template, OAuth install, database, core logic ported, privacy webhooks | **Done** |
| 2 | Background job queue (Redis + BullMQ), Cloudflare R2 file storage, upload and run endpoints | **Done** |
| 3 | Upload form in Polaris: sheet, column mapping, images, preview, progress, reports | **Done** |
| 4 | Billing plans (Shopify Billing API), usage limits | Next |
| 5 | Testing on development stores, App Store listing | |
| 6 | App Store review | |

See `docs/PROGRESS.md` for decisions and details.

## Project layout

```
app/
  .server/core/      Upload logic, no database or file access (ported from the desktop tool)
    config.ts        Saved settings -> validated run config
    sheet.ts         Read Excel / CSV / Google Sheets
    images.ts        Match image files to products by file name
    build.ts         Work out what to change on each product
    shopify.ts       Admin GraphQL calls, retries, rate limits
    runner.ts        check / plan / apply
  .server/jobs/      Job queue (BullMQ or in-process), processJob, job service and housekeeping
  .server/           Files, file storage (R2 / disk), database store, Shopify + Google clients
  routes/            Pages, webhooks, JSON endpoints (app.api.*) and signed downloads (dl.*)
  components/        The uploader page (uploader/) and Polaris field wrappers (polaris.tsx)
  lib/uploader.ts    Form logic in the browser: auto-fill, default rules, checklist
public/templates/    The product template merchants download (built by scripts/build-template.cjs)
worker.ts            Background worker process (BullMQ)
prisma/              PostgreSQL schema and migrations
test/                Unit tests, job system tests, and full runs against a simulated Shopify store
```

`.server` folders are never sent to the browser.

## How a run works

1. The browser uploads files one at a time to `/app/api/files` (kept in file storage, listed in `StoredFile`).
2. `POST /app/api/jobs` checks the settings and creates a `Job` (one active job per store), then queues it.
3. The worker claims the job and runs check / plan / apply. Every 2 seconds it saves progress and the log,
   and picks up a stop request. The report goes to file storage.
4. The browser polls `GET /app/api/jobs/:id`, and downloads the report with `?report=csv`.

| Endpoint | |
|---|---|
| `GET/POST /app/api/settings` | Read / save the form settings |
| `GET /app/api/sheet` | Column names, row count, tabs and a preview of the current sheet |
| `GET /app/api/files?kind=sheet\|image` | List uploaded files |
| `POST /app/api/files?kind=image&name=Sofas/Oslo_1.jpg` | Upload one file (raw body) |
| `DELETE /app/api/files?kind=image[&id=...]` | Delete one file, or all of that kind |
| `GET /app/api/jobs` | Latest runs |
| `POST /app/api/jobs` `{ command, only?, limit?, force? }` | Start a run |
| `GET /app/api/jobs/:id` | Status, progress, counts, log |
| `GET /app/api/jobs/:id?report=json\|csv` | Report |
| `POST /app/api/jobs/:id` `{ stop: true }` | Stop a run |
| `GET /dl/file/:id`, `GET /dl/report-csv/:id` | Thumbnails and CSV downloads, through signed links that expire after an hour (`<img>` and plain links cannot send the session token) |

On a deploy, running jobs stop after the products in progress and go back to the queue. Products
already saved are skipped when they continue. A job whose worker crashed is re-queued after 2 minutes
without a heartbeat, at most 3 times. Every hour the worker deletes uploads older than 7 days,
backups older than 30 days and runs older than 90 days.

Without `REDIS_URL`, jobs run inside the web server, so local development needs no Redis.
Without `R2_BUCKET`, files are kept in `./storage`.

## Running it locally

You need Node.js 22.12 or newer, a [Shopify Partner account](https://partners.shopify.com) with a development store, and a PostgreSQL database (a free one from Neon, Supabase or Railway works).

1. `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL`.
3. `npm run config:link` to create or link the app in your Partner account. This fills in `client_id` in `shopify.app.toml`.
4. `npm run dev`. The Shopify CLI runs the database migrations, opens a tunnel and gives you a link to install the app on your development store.

## Deploying on Railway

One repository, one Docker image, two services:

| Service | Start command | Notes |
|---|---|---|
| web | default (`npm run docker-start`) | Runs database migrations, then the app. Public domain |
| worker | `npm run worker` | No public domain |

Add the PostgreSQL and Redis plugins, and give both services the same variables: `DATABASE_URL`,
`REDIS_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `R2_*` and
`GOOGLE_SERVICE_ACCOUNT_JSON`. In Cloudflare R2, add a lifecycle rule that deletes objects after 8 days,
as a safety net behind the worker's own cleanup.

## Tests

```
npm test            # unit tests, job system, and check/plan/apply against a simulated store (never a real one)
npm run test:browser  # the real uploader page in Chrome or Edge with a fake API (needs internet for Polaris)
npm run typecheck
npm run lint
```

## Data the app keeps

All tables are per store (`prisma/schema.prisma`):

- **Shop**: install state, billing plan, saved settings
- **Job**: each check / preview / upload run, with its progress, counts and log (the report is in file storage)
- **StoredFile**: uploaded sheets and images (the bytes are in file storage)
- **ProductState / UploadedImage**: what was already uploaded, so re-runs never duplicate anything
- **ProductBackup**: each product as it was before the app changed it

The app reads and writes products only. It never reads customer or order data.

- `app/uninstalled`: sessions are deleted and queued or running jobs stop.
- `shop/redact` (48 hours after uninstall): every row and file for the store is deleted.
- `customers/data_request`, `customers/redact`: nothing to do, since no customer data is stored.

## Permissions

`write_products` (products, variants, tags, collections, metafields) and `write_files` (image uploads).
