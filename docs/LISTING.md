# App Store listing: Bulk Product Uploader

Draft text for Partner Dashboard > Apps > (production app) > Distribution > Manage listing.
Character limits shown in the dashboard win; counts below are approximate. Last updated: 2026-10-12.

Rules this text follows (App Store requirements 4.x): no pricing in images or text outside "Pricing details",
no keywords stuffed into the subtitle, screenshots show the real app UI, every image is different, English only.

---

## Basic app information

| Field | Text |
|---|---|
| App name (max 30) | Bulk Product Uploader |
| App icon | 1200 × 1200 px PNG/JPG, no text, no pricing, no Shopify logo |
| Category | Store management > Product management (closest bulk editor / import category offered) |
| Languages | English |
| Works with | Google Sheets, Google Drive |

Before saving: search the App Store for "Bulk Product Uploader" to make sure no other app uses the same name.

## App card subtitle (about 60)

Create and update products from a sheet and an image folder

## App introduction (max 100)

Update or create hundreds of products from Excel, CSV or Google Sheets, with images matched by name.

## App details (max 500, plain text)

Keep your catalogue in a spreadsheet and let the app do the clicking. Upload an Excel or CSV file or link a Google Sheet, map your own column names (or let the app fill them in), and add a folder of images. The app finds each product by SKU, handle or title, shows a preview of every change, then updates titles, descriptions, SEO, tags, collections, variants, prices, metafields and images. Every product is backed up first, so any upload can be undone.

## Feature list (max 80 each)

1. Excel, CSV or Google Sheets with your own column names, auto-mapped
2. Images matched to products by file name, from a folder or Google Drive
3. Preview every change before anything is saved in your store
4. Variants, prices, SEO, tags, collections and metafields in one run
5. Automatic backup of each product, with one-click restore and undo

## Search terms (5)

bulk edit, product import, csv import, bulk image upload, excel products

## Pricing details

Managed Pricing (set in the dashboard). Plan names must stay **Free**, **Pro** and **Unlimited**: the app reads
the plan from the name.

| Plan | Limit | Price |
|---|---|---|
| Free | 50 products created or updated per month | $0 |
| Pro | 2,000 products per month | owner to decide, monthly + free trial |
| Unlimited | no monthly limit, priority email support | owner to decide |

Every plan: image check and preview are free, backups and undo, backups kept 6 months.

## Screenshots (1600 × 900, real app UI only, each one different)

Take them from the production app on a development store with demo products (no real customer data):

1. Sheet step: a loaded sheet with its preview table.
2. Columns step after "Auto-fill from column names", metafields visible.
3. Images step: uploaded folder with image count.
4. Preview results: the table with "will update" / "will create" rows and thumbnails.
5. Upload running: progress bar, ETA and log.
6. Backups page: runs grouped by day, "Preview restore" open.

Alt text for each: one plain sentence saying what the screen shows.

## Demo screencast (required, English)

2-3 minutes, screen recording of the production app on a development store:

1. Install from the listing link (OAuth screen, then the app opens in Shopify Admin).
2. Download the template, show the example rows.
3. Upload the template, "Auto-fill from column names".
4. Upload the images folder from `docs/review-kit/images`.
5. Check images, then Preview: show the changes.
6. Upload with "Only the first N" = 3; open one product in Shopify Admin to show the result.
7. Backups > Preview restore > Restore; show the product back as it was.
8. Plans page and Shopify's plan picker.

## Testing instructions for the reviewer

> Bulk Product Uploader has no separate account or login: it uses Shopify OAuth only, and the full feature set
> is available on the Free plan (50 products per month) and on any development store.
>
> Files to test with: download the sample kit at <REVIEW_KIT_LINK> (product template with 3 example products,
> and 4 images named after them). Or use "Download template" inside the app.
>
> 1. Install the app and open it from Apps in the Shopify admin.
> 2. "1. Product sheet": choose Shopify-Product-Template.xlsx. The "Products" tab and its header row are found
>    automatically and a preview of the rows is shown.
> 3. "2. Map your columns": click "Auto-fill from column names". Products are found by SKU.
> 4. "3. Images": choose "Upload images", then drag the "images" folder from the kit (or "Choose folder").
> 5. "4. Update rules": tick "Create products that are not in Shopify" (and "Create collections that do not exist").
> 6. "5. Run": click "1 · Check image matches", then "2 · Preview changes". The results show what would change;
>    nothing is saved yet.
> 7. Click "3 · Upload to Shopify", then "Start the upload". Three products (one with two variants) are created
>    with images, SEO fields, tags, collections and metafields. Open any of them from the results table.
> 8. Undo: in the Shopify admin, change the title of "Oslo 3 Seater Fabric Sofa". Back in the app, tick
>    "Re-send products that were already uploaded" and upload again: the app sets the title from the sheet and
>    backs up your edited version first. Then open Backups (left menu), choose the latest upload, click
>    "Preview restore", then "Restore": your edited title is back.
> 9. Plans (left menu): shows usage this month; "Upgrade" opens Shopify's plan page.
>
> Google Sheets (optional): paste a link to any sheet set to "Anyone with the link can view".
>
> The app requests write_products (find, create and update products, variants, collections, metafields) and
> write_files (upload product images). It does not read customers or orders.

Replace `<REVIEW_KIT_LINK>` with a public link (Google Drive, "anyone with the link") to a zip of `docs/review-kit/`
(rebuild it with `node scripts/build-review-kit.cjs`).

## Contact and links

| Field | Value |
|---|---|
| App URL | `https://<production domain>` |
| Privacy policy URL | `https://<production domain>/privacy` |
| Support URL / FAQ | `https://<production domain>/support` |
| Support email | the `SUPPORT_EMAIL` address |
| Emergency developer contact (requirement 4.5.6) | owner's phone + email, in Partner Dashboard settings |
