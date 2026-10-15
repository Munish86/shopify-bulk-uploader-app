# Bulk Product Uploader: App Store pe live karne ke steps

Owner ke liye, shuru se aakhir tak, order mein. Har step ke aage likha hai kaun karega.
Last updated: 2026-10-12. Listing ka text: `docs/LISTING.md`. Technical details: `docs/PROGRESS.md`.

---

## Step 1: Dev store pe local test (Owner + Claude, 1-2 din)

1. PATH permanent theek karo: Start → "environment variables" → System variables → Path → New:
   `C:\Windows\System32` aur `C:\Windows` → OK → VS Code band karke dobara kholo.
2. Terminal mein `cd shopify-bulk-uploader-app` → `npm run dev` → "p" dabake app dev store mein kholo.
3. `docs/review-kit/` wali file aur images se `docs/LISTING.md` ke "Testing instructions" wale 9 steps khud karo.
   Yahi steps Shopify ka reviewer karega, to pehle aap karke dekho.
4. Jo bhi galat lage (error, galat text, kuch na chale) uska screenshot Claude ko bhejo. Claude theek karega.

## Step 2: Accounts banao (Owner, 1 din)

| Account | Kahan | Kharcha |
|---|---|---|
| GitHub (private repo) | github.com | Free |
| Railway | railway.com (GitHub se login) | ~$5-20/month |
| Cloudflare (R2 storage) | dash.cloudflare.com | 10 GB tak free |
| Support email | apne domain pe, jaise `support@perceptive-solutions.com` | domain wale plan mein |
| (Optional) Google Cloud service account | private Google Sheets ke liye | Free |

## Step 3: Production app Shopify pe (Owner + Claude, 30 min)

Testing wali app alag rahegi; App Store pe **nayi production app** jaati hai.

1. `npm run config:link` → "Create a new app" → naam "Bulk Product Uploader" → config file ka naam `production`.
   Isse `shopify.app.production.toml` banegi.
2. Claude us file mein scopes (`write_products,write_files`), webhooks (`2026-10`) aur Railway ka address
   (Step 4 ke baad) bharega, aur `automatically_update_urls_on_dev = false` karega.
3. Partner Dashboard → nayi app → "Client ID" aur "Client secret" copy karke rakho (Step 4 mein chahiye).

## Step 4: Live server, Railway (Owner + Claude, ~1 din)

1. Ho gaya (2026-10-15): code GitHub pe `Munish86/shopify-bulk-uploader-app` (`main`) mein push hai
   (`.env` nahi jaati, wo ignore list mein hai). Repo **private** hi rakhna.
2. Railway → New Project → Deploy from GitHub repo → ye repo. Ye **web** service hai.
   Settings → Networking → "Generate Domain" → address milega, jaise `bulk-uploader.up.railway.app`.
3. Same project mein: "+ New" → Database → **PostgreSQL**, phir "+ New" → Database → **Redis**.
4. Same repo se ek aur service: "+ New" → GitHub repo → naam **worker** → Settings → Start command: `npm run worker`
   (isko domain nahi chahiye).
5. Cloudflare → R2 → bucket banao (`bulk-uploader-files`). **Lifecycle rule mat lagao**: app uploaded files
   7 din baad khud delete karti hai, aur run reports 6 mahine rakhti hai (privacy page yahi kehta hai).
   R2 → "Manage API tokens" → Object Read & Write token → Access Key ID, Secret, Account ID copy karo.
6. Dono services (web + worker) mein Variables daalo:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `SHOPIFY_API_KEY` | production app ka Client ID |
| `SHOPIFY_API_SECRET` | production app ka Client secret |
| `SHOPIFY_APP_URL` | `https://<railway domain>` |
| `SCOPES` | `write_products,write_files` |
| `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare se |
| `SUPPORT_EMAIL` | support email |
| `APP_HANDLE` | production app ka handle (Partner Dashboard URL mein dikhta hai) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (optional) JSON key ek line mein |
| `NODE_ENV` | `production` |

7. Claude: `shopify.app.production.toml` mein Railway ka address daal ke `npm run deploy -- --config production`
   (URLs, scopes, webhooks Shopify pe chale jaate hain).
8. Check: `https://<domain>/privacy` aur `/support` browser mein khulein; dev store pe production app install karke
   Step 1 wala test dobara.

## Step 5: Pricing (Owner, 30 min)

Partner Dashboard → **production app** → Distribution → Manage listing → Pricing → **Managed pricing**:

| Plan naam (bilkul yahi) | Limit | Price |
|---|---|---|
| Free | 50 products/month | $0 |
| Pro | 2,000 products/month | aap decide karo (jaise $9-15/month), free trial 7 din |
| Unlimited | no limit | aap decide karo (jaise $29-39/month) |

Naam badle to app plan nahi pehchaanegi. Dev store pe "Upgrade" dabake test charge dekho (paisa nahi katta).

## Step 6: Listing (Owner + Claude, 2-3 din)

Partner Dashboard → production app → Distribution → **Shopify App Store** → Manage listing.
Text `docs/LISTING.md` se copy karo.

| Cheez | Kaun | Note |
|---|---|---|
| App icon 1200×1200 | Owner (designer) | Koi text/price nahi |
| Subtitle, introduction, details, features, search terms | Claude ne likh diya | `docs/LISTING.md` |
| Screenshots 1600×900, kam se kam 3 (6 ki list di hai) | Owner + Claude | Sirf asli app ka screen, har ek alag, price nahi |
| Demo video 2-3 min, English | Owner | Script `docs/LISTING.md` mein |
| Privacy policy URL | | `https://<domain>/privacy` (text ek baar padh lo) |
| Support URL + email | Owner | `https://<domain>/support` |
| Reviewer ke testing instructions | Claude ne likh diya | Review kit ka zip Google Drive pe "anyone with link" daal ke link bharna |
| Emergency developer contact | Owner | Partner Dashboard → Settings, phone + email |
| App naam check | Owner | App Store pe "Bulk Product Uploader" search karke dekho koi aur to nahi |

## Step 7: Submit (Owner)

1. Partner Dashboard → production app → Distribution → **$19 registration fee** (ek baar).
2. Listing page pe "Run automated checks" / pre-submission checks chalao. Jo laal dikhe, Claude ko bhejo.
3. **Submit for review.**
4. Shopify 1-4 hafte mein email karega. 1-2 round ki kamiyan normal hain: email Claude ko bhejo, theek karke
   dobara submit.
5. Approve → app App Store pe live.

## Live hone ke baad
- Har din Railway ke logs aur support email dekhna (pehle 2 hafte).
- Reviews ka jawab dena.
- Neon/Railway database ka backup Railway mein on rakhna.
