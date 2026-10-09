# Bulk Product Uploader: App Store tak ka roadmap

Owner ke liye checklist: kya ho chuka hai, aur Shopify App Store pe app dikhne tak kya-kya karna baaki hai.
Last updated: 2026-10-09

Technical details (code, files, tests) ke liye `docs/PROGRESS.md` dekho.

---

## Abhi kahan hain (ek nazar mein)

```
[✅ Phase 1] → [✅ Phase 2] → [✅ Phase 3] → [🔄 Local test] → [⬜ Phase 4: Billing] → [⬜ Live (Railway)] → [⬜ Phase 5: Listing] → [⬜ Phase 6: Review] → 🎉 App Store
```

---

## ✅ Ho chuka hai

### Code (Claude)
| Phase | Kya bana |
|---|---|
| 1 | Shopify ka official app template, install/login (OAuth), database, purane tool ka poora upload logic naye app mein, GDPR/privacy webhooks |
| 2 | Background mein upload chalna (browser band ho tab bhi), ek store ek run, server restart pe run apne aap dobara, file storage (Cloudflare R2), purana data apne aap saaf |
| 3 | Shopify Admin ke andar pura upload form: sheet, columns, images, rules, run, results, thumbnails, CSV report, pichle runs |
| Tests | 52 automatic tests + asli browser mein 23 checks, sab pass |

### Setup (Owner)
- ✅ Shopify Partner account (org: ZingwithCloude)
- ✅ Development store: `bulk-uploader-test.myshopify.com`
- ✅ Neon database (free plan)
- ✅ App Shopify pe bani: "Bulk Product Uploader" (`npm run config:link`)
- ✅ App development store pe install hui, database tables ban gayi

### Asli setup pe pakde gaye aur theek kiye gaye problems
| Problem | Kya kiya |
|---|---|
| Computer ke PATH mein `C:\Windows\System32` nahi tha, isliye `npm run dev` crash ho raha tha | Terminal mein PATH jod ke chalaya. **Permanent fix abhi baaki hai** (neeche dekho) |
| `config:link` ne app ki permissions khaali kar di thi | `shopify.app.toml` mein `write_products,write_files` wapas daala |
| Neon database "so" jaata hai aur jagne mein der lagti hai, jisse login fail hota tha | `.env` mein database URL ke saath `connect_timeout=30` joda |

---

## 🔄 Abhi chal raha hai: Local test

App aapke computer se chal rahi hai (`npm run dev` + temporary tunnel).

| # | Kaam | Kaun | Status |
|---|---|---|---|
| 1 | App ka page Shopify Admin mein khulna chahiye | Owner | ⬜ |
| 2 | Template download karke 2-3 products bharna (ek purane SKU wala, ek naya) | Owner | ⬜ |
| 3 | Sheet upload → Auto-fill → Check → Preview | Owner | ⬜ |
| 4 | Upload sirf 2-3 products pe ("Only the first N" = 3), phir Shopify Admin mein products check karna | Owner | ⬜ |
| 5 | Images ke saath ek run | Owner | ⬜ |
| 6 | Jo bhi bug mile use theek karna | Claude | ⬜ |

---

## ⬜ Aage kya karna hai

### Phase 4: Billing (paid plans), ~3-4 din
| # | Kaam | Kaun |
|---|---|---|
| 1 | **Plans aur prices decide karna.** Jaise Free (50 products/month), Pro ($__/month, ___ products), Unlimited ($__/month) | **Owner** |
| 2 | Free trial chahiye? Kitne din? | **Owner** |
| 3 | Shopify Billing jodna, plans ka page, monthly limit lagana | Claude |
| 4 | Development store pe test charge karke dekhna | Owner + Claude |

### Live server (Railway), ~1 din
| # | Kaam | Kaun |
|---|---|---|
| 1 | Production config, deploy guide aur Railway settings taiyar karna | Claude |
| 2 | GitHub account + private repo, code push karna | Owner |
| 3 | Railway account banana, repo connect karna, Redis add karna | Owner |
| 4 | Cloudflare account, R2 bucket + API key | Owner |
| 5 | Shopify pe alag "production" app banana (testing wali app alag rahegi) | Owner + Claude |
| 6 | Settings (env variables) daalna, deploy, `npm run deploy` | Owner + Claude |
| 7 | (Optional) apna subdomain, jaise `uploader.perceptive-solutions.com` | Owner |

**Kharcha (approx/month):** Railway ~$5-20, Neon free se shuru, R2 10 GB tak free. **Total ~$5-20.**

### Phase 5: Testing aur listing, ~1 hafta
| # | Kaam | Kaun |
|---|---|---|
| 1 | Live app pe poora test (bade sheet, bahut saari images) | Owner + Claude |
| 2 | Shopify ka AI self-review tool chala ke kamiyan theek karna | Claude |
| 3 | **App icon:** 1200×1200 px, PNG/JPG | **Owner** (designer) |
| 4 | **Privacy policy page:** draft Claude likhega, website pe Owner lagayega | Claude + Owner |
| 5 | **Support email** (jaise support@...) | **Owner** |
| 6 | App description, features, screenshots | Claude (draft) + Owner |
| 7 | **Demo video (zaroori):** install se upload tak screen recording | **Owner** |
| 8 | Reviewer ke liye test instructions + sample sheet | Claude |
| 9 | **$19 App Store registration fee** (ek baar) | **Owner** |

### Phase 6: Shopify review, 1-4 hafte
| # | Kaam | Kaun |
|---|---|---|
| 1 | Partner Dashboard se app submit karna | Owner |
| 2 | Reviewer ke emails ka jawab dena, kamiyan theek karke dobara bhejna (1-2 round normal hai) | Owner + Claude |
| 3 | Approve hone pe app App Store pe live 🎉 | |

---

## Shopify App Store ki zaroori shartein

| Shart | Status |
|---|---|
| Shopify Admin ke andar khulna (embedded) | ✅ |
| GDPR/privacy webhooks | ✅ |
| App naam 30 characters tak, "Shopify" shabd nahi | ✅ "Bulk Product Uploader" |
| SSL wala live address | ⬜ Railway pe milega |
| Saari payment Shopify Billing se | ⬜ Phase 4 |
| Store ki speed 10 points se zyada na giraana | ✅ App store ki website pe kuch nahi daalti |
| Privacy policy | ⬜ Phase 5 |
| Icon 1200×1200 | ⬜ Phase 5 |
| Demo video | ⬜ Phase 5 |
| Reviewer ke liye test instructions | ⬜ Phase 5 |

---

## Paise ka hisaab (Shopify ki taraf se)
- **Registration:** $19, ek baar
- **Shopify ka hissa:** pehli **$1 million** lifetime kamai pe **0%**, uske upar 15%
- **Processing fee:** har charge pe 2.9% + tax

Ye niyam badal sakte hain. Submit karne se pehle Partner Dashboard mein ek baar check kar lena.

---

## Timeline (aaj se)
| Kaam | Time |
|---|---|
| Local test | 1-2 din |
| Phase 4: Billing | 3-4 din |
| Live (Railway) | 1 din |
| Phase 5: Testing + listing | ~1 hafta |
| Phase 6: Review | 1-4 hafte |
| **Total** | **~4-7 hafte** |

---

## Owner ke pending kaam (jaldi wale upar)
1. ⬜ **Local test karna** (upar wali list)
2. ⬜ **PATH permanent theek karna:** Start → "environment variables" → System variables → Path → New: `C:\Windows\System32` aur `C:\Windows` → OK, phir VS Code restart
3. ⬜ **Plans, prices, free trial decide karna**
4. ⬜ App icon banwana (1200×1200)
5. ⬜ Support email banana
6. ⬜ GitHub, Railway, Cloudflare accounts (live server ke waqt)
7. ⬜ $19 registration fee (submit ke waqt)

## Yaad rakhne wali baatein
- `npm run dev` wala terminal band karte hi app band ho jaati hai (local testing mein).
- `.env` file mein database ka password hai. Ise kisi ko share mat karna, aur GitHub pe mat daalna (wo pehle se ignore list mein hai).
- `npm run config:link` dobara chalaya to wo `shopify.app.toml` badal sakta hai. Uske baad permissions (`scopes`) check karna.

---

Sources:
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Submit your app for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
- [About the app review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process)
- [Revenue share for Shopify App Store developers](https://shopify.dev/docs/apps/launch/distribution/revenue-share)
