# Shopify ⇄ eBay Sync

A free, self-hosted app that keeps your **eBay store in sync with your Shopify store**. Shopify stays the source of truth for products. When something sells on eBay, Shopify stock goes down automatically. The app also lists Shopify products on eBay the way eBay expects (categories, item specifics, variations, policies) and suggests prices based on what identical brand-new items sell for on eBay.

It runs on a NAS (Synology, Unraid, QNAP), a Raspberry Pi, a home server or any always-on computer with Docker. You set everything up in your browser. There are no config files to edit and no monthly fees.

---

## Features

**Inventory sync**
- **eBay sale → Shopify stock decreases.** The app checks for new eBay sales every 3 minutes. Each order is applied exactly once, even after retries or restarts.
- **Shopify → eBay price and stock**, every 5 minutes. With optional webhooks this becomes near-instant.
- **Cancelled eBay orders** are restocked in Shopify automatically.
- **Out of stock** sets the eBay quantity to 0 and keeps the listing. When you restock, the listing is relisted automatically.
- **Safety buffer and maximum quantity.** You can hide a few units from eBay, or cap the quantity shown.
- **Protection against bad updates:**
  - eBay never shows more stock than Shopify has.
  - Large price jumps are **held for your approval** instead of being pushed.
  - A health check fixes eBay listings that were edited by hand.
- **Dry-run mode** lets you see what *would* happen without changing anything.

**Listing on eBay**
- Pick products from your Shopify catalog and create eBay listings one at a time or in bulk.
- **Multi-variation listings.** Sizes and colors become one eBay listing with dropdowns. You can also list each variant separately.
- **eBay category suggestions** and a form for **item specifics** that shows which ones are required or recommended for the category.
- Title builder that respects eBay's 80-character limit, HTML description templates with a live preview, and photo ordering.
- **Profiles:** reusable presets for groups of products (category, policies, templates, item specifics, markup).
- **Lock fields** so your eBay-specific edits survive a "refresh from Shopify".
- **Best Offer**, with auto-accept and auto-decline thresholds tied to your minimum markup.

**Pricing**
- eBay price = Shopify price **+15% to +17%** by default (configurable), always inside that range.
- **Market research** on eBay for *identical brand-new* items, matched by UPC/EAN barcode when available:
  - lowest, median and number of **active** listings;
  - **sold prices over the last 6 weeks** (needs eBay approval, see below).
- A **suggestion column**: recommended price, where you stand against the market, and a one-click "Apply". Automatic repricing is optional.
- Price history charts, plus alerts when competitors drop below your floor.
- Choose whether Shopify sale prices also apply on eBay.

**Insights and alerts**
- **Profit reports** using **real eBay fees** from eBay's Finances API and your item cost from Shopify, by month and by product.
- **Stale listing alerts** for items with no sales in N days.
- **Seller standards alerts** when your eBay seller level is projected to drop.
- Low-stock, error and unmatched-sale alerts sent to your **phone (ntfy), Discord or Slack**.
- Activity log, CSV export and nightly database backups.

---

## What you need

- A **Shopify** store. Any plan works.
- An **eBay seller account**. A store subscription is recommended but not required. You also need **business policies** for shipping, payment and returns; the wizard helps you turn them on.
- A computer that's always on and can run **Docker**: Synology/QNAP/Unraid NAS, Raspberry Pi 4/5, mini PC, etc. The app uses about 100–200 MB of RAM.
- About **20 minutes** for setup.

Everything is free. You create your *own* free API keys for Shopify and eBay. eBay's API license doesn't allow apps like this to share keys, so each user needs their own.

---

## Install

### Option A: Synology NAS (Container Manager)

1. In **Package Center**, install **Container Manager**.
2. In **File Station**, create the folder `docker/shopify-ebay-sync`.
3. Download [`docker-compose.yml`](https://raw.githubusercontent.com/anivdas/shopify-ebay-sync/main/docker-compose.yml) into that folder.
   - Change `PUID`/`PGID` to your DSM user's IDs (usually `1026` and `100`). You can check by SSHing in and running `id`.
   - Set `TZ` to your timezone.
4. Open **Container Manager**, go to **Project**, then **Create**:
   - Name: `shopify-ebay-sync`
   - Path: `/volume1/docker/shopify-ebay-sync`
   - Source: **Use existing docker-compose.yml**
   - Click **Next** until it's done.
5. Open `http://<your-nas-ip>:8080` and follow the setup wizard.

### Option B: Any computer with Docker (Linux, Windows, Mac, Raspberry Pi, Unraid)

```bash
mkdir shopify-ebay-sync && cd shopify-ebay-sync
curl -O https://raw.githubusercontent.com/anivdas/shopify-ebay-sync/main/docker-compose.yml
docker compose up -d
```

Open `http://localhost:8080` (or your server's IP).

The image is built for both `amd64` and `arm64`, so it runs on Intel/AMD machines and on a Raspberry Pi.

### Option C: From source (no Docker)

Requires Node.js 24+.

```bash
git clone https://github.com/anivdas/shopify-ebay-sync.git && cd shopify-ebay-sync
npm ci && npm run build
npm start          # http://localhost:8080
```

---

## Setup wizard: what to expect

When you first open the app you create a dashboard password. The wizard then walks you through these steps, with instructions and links on each screen:

1. **Connect Shopify.** In the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), create an app and give it the `read_products`, `read_inventory`, `write_inventory` and `read_locations` scopes. Release it and install it on your store. Paste the **Client ID** and **Client secret** into the app.
   - If you already have an older custom app with a `shpat_…` token, you can use that instead.
2. **eBay developer keys.** Join the free [eBay Developers Program](https://developer.ebay.com/) and create a **Production** keyset. Copy the **App ID**, **Cert ID** and **RuName**.
   - When eBay asks about *Marketplace Account Deletion* notifications, choose to **opt out**. This app doesn't store eBay buyers' personal data.
3. **Connect your eBay account.** Sign in to eBay and click Agree.
   - If your app isn't on HTTPS, copy the address of the page eBay sends you to and paste it into the app.
4. **Shipping and policies.** Choose default shipping, payment and return policies, and where you ship from.
5. **Pricing rules.** Set the markup range, automatic repricing, Best Offer and fees.
6. **Extras (optional):**
   - phone alerts;
   - instant updates through webhooks;
   - sold-price data.

Then go to **Shopify products**, select products and click **Create eBay listings**.

> **Tip:** turn on **dry-run mode** (Settings → Sync & alerts) for your first day. Check the Activity log to see exactly what the app would do, then turn it off.

---

## How pricing works

```
floor   = Shopify price × (1 + min%)      e.g. $100 → $115.00
ceiling = Shopify price × (1 + max%)      e.g. $100 → $117.00
target  = cheapest identical NEW listing on eBay (incl. shipping) − $0.01
eBay price = target, kept between floor and ceiling (rounded to .99 when it fits)
```

- If competitors are **cheaper than your floor**, you stay at the floor and get an alert. The app never drops below your minimum markup.
- If competitors are **above your ceiling**, you're priced at the ceiling and you're the cheapest.
- With **no comparable listings**, the price sits in the middle of your range.
- If there are no active listings but sold data exists, the median sold price over the last 6 weeks is used.
- When your Shopify price changes, the eBay price follows and keeps the same markup.

**Exact matching:** add **UPC/EAN barcodes** to your Shopify variants. Without a barcode, the app matches by brand, title and model numbers, which is less exact. You can review the matched listings in the market panel.

**Sold prices (last 6 weeks)** come from eBay's *Marketplace Insights API*, which eBay only gives to approved apps. To request it, sign in at developer.ebay.com and request access through the **Application Growth Check** for your keyset. Until it's approved, everything else works and research uses active listings only.

---

## Optional: instant updates and automatic eBay sign-in (Cloudflare Tunnel)

By default the app *checks* Shopify every few minutes and needs no public internet access, so no port forwarding is required. If you want near-instant Shopify → eBay updates, the app needs a public HTTPS address. A free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) is the easiest way and doesn't open any ports on your router.

1. Move your domain's DNS to Cloudflare. The free plan is enough.
2. In Cloudflare **Zero Trust**, go to **Networks**, then **Tunnels**, and create a tunnel. Copy its token.
3. Add this to your `docker-compose.yml` under `services:`:
   ```yaml
     cloudflared:
       image: cloudflare/cloudflared:latest
       restart: unless-stopped
       command: tunnel run
       environment:
         - TUNNEL_TOKEN=paste-your-token
   ```
4. In the tunnel, add a **public hostname**, e.g. `sync.yourdomain.com` → `http://shopify-ebay-sync:8080`.
5. Add these to the app's `environment:` and restart:
   ```yaml
         - PUBLIC_URL=https://sync.yourdomain.com
         - COOKIE_SECURE=true
         - TRUST_PROXY=true
   ```
   `TRUST_PROXY=true` lets login rate-limiting see real visitor IPs through the tunnel. Only set it when the app is behind a proxy or tunnel, and don't also expose port 8080 to the internet.
6. In the app, go to **Settings → Sync & alerts → Instant Shopify updates**, enter `https://sync.yourdomain.com` and click **Register webhooks**.
7. *(Optional)* In your eBay RuName settings, set **auth accepted URL** to `https://sync.yourdomain.com/auth/ebay/callback`. eBay sign-in then returns to the app automatically.

**Security tip:** the dashboard is password protected. For extra safety you can put it behind **Cloudflare Access**. If you do, add a *bypass* rule for `/webhooks/*` so Shopify can still reach it.

---

## Phone alerts

Under **Settings → Sync & alerts**, paste one of:
- an [ntfy.sh](https://ntfy.sh) topic URL, e.g. `https://ntfy.sh/my-long-secret-topic` (install the ntfy app and subscribe to the topic);
- a Discord webhook URL;
- a Slack incoming-webhook URL.

You'll get alerts for errors, unmatched eBay sales, low stock, held price changes, competitors below your floor, stale listings, seller-level risks, and an expiring eBay connection.

---

## Updating

- **Synology:** in **Container Manager**, go to **Project**, select the project and choose **Action → Build** (this pulls the latest image). Alternatively, go to **Image**, then **Update**.
- **Docker CLI:** run `docker compose pull && docker compose up -d`.

Your data in `./data` is kept.

## Backups

The app saves a copy of its database to `data/backups/` every night and keeps the last 14 by default.

To move or restore the app, copy the whole `data` folder. It contains the database, your settings and the `secret.key` that encrypts your stored keys. **Keep `secret.key` safe**: without it, the saved keys can't be decrypted, and you'd have to enter your Shopify and eBay keys again.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `permission denied` on `/data` | Set `PUID`/`PGID` in `docker-compose.yml` to the owner of the folder (run `id` on the NAS). |
| Shopify: "Client credentials cannot be performed on this shop" | The app and the store must be in the same Shopify organization in the Dev Dashboard. Create the app while logged in as the store owner. |
| Shopify: missing scopes | Add the scopes to a **new app version**, click Release, then approve the update in your store admin. |
| eBay: "invalid_grant" or "not connected" | Reconnect eBay in Settings → Connections. eBay sign-ins last about 18 months, and the app warns you 30 days before. |
| eBay: business policies error | Enable business policies in the wizard (or in Seller Hub), then create a shipping, a payment and a return policy. |
| A listing fails to publish | Open the listing. The **Ready to publish?** panel lists what eBay needs, usually a required item specific. |
| Sold prices say "not available" | Your keyset hasn't been approved for the Marketplace Insights API yet (see above). |
| An eBay sale didn't reduce Shopify | Check **eBay sales**. "No match" means the SKU wasn't found. Listings created by this app always match. |

**Don't edit listings created by this app in eBay Seller Hub.** eBay manages listings created through its Inventory API differently, and manual edits can be overwritten or cause errors. Make changes in this app instead. Quantity and price corrections made in Seller Hub are detected and fixed automatically.

---

## Privacy and security

- Everything runs on **your** hardware. Your keys, products and sales data are never sent anywhere except Shopify and eBay.
- API secrets and tokens are **encrypted** in the database (AES-256-GCM).
- The dashboard needs a password. Logins are rate-limited, and API calls are protected against cross-site requests.
- No buyer names or addresses are stored. The app only keeps order IDs, SKUs, quantities and totals.

---

## Limitations

- The app does **not** import eBay orders into Shopify for fulfillment. Ship eBay orders from eBay Seller Hub as usual. Shopify stock is still adjusted.
- Prices are not converted between currencies. Your Shopify currency should match the eBay site's currency; the app warns you if they differ.
- eBay doesn't allow Best Offer on multi-variation listings.

---

## Development

```bash
npm ci
npm run dev        # API server on :8080 (auto-restart)
npm run dev:web    # UI on :5173 with hot reload (proxies to :8080)
npm run check      # typecheck + tests + build
```

The backend is TypeScript running directly on Node 24, with no runtime npm dependencies and SQLite through `node:sqlite`. The UI is React with Vite and Tailwind CSS.

Project layout:
```
src/       server: Shopify/eBay clients, sync jobs, pricing, listing builder, HTTP API
web/       React UI
test/      unit and sync tests (node:test, APIs mocked)
docker/    container entrypoint
```

---

## License

[MIT with the Commons Clause](LICENSE). This is source-available, not OSI open source.

- ✅ Free to use, including to run your own Shopify/eBay business
- ✅ Free to modify and to share your changes (for free), keeping the license notice
- ❌ Not allowed: selling the app, or charging others for hosting, setup or support whose value comes mainly from this app

*This project is not affiliated with Shopify or eBay. Use at your own risk, and try dry-run mode first.*
