# Steam Market Price Assistant

[简体中文](README.md)

**v0.6.0** · [![CI](https://github.com/mindydora8023-prog/steam-market/actions/workflows/ci.yml/badge.svg)](https://github.com/mindydora8023-prog/steam-market/actions/workflows/ci.yml) · [MIT](LICENSE)

Check the lowest active ask, recent median sale price, and sales volume on the Steam Community Market. The dark trading terminal compares four listing strategies, works backward from a target payout, and lets you estimate buyer payments, fees, and seller proceeds for a batch of items.

The app uses public market data and runs on **Node.js 18.17+** with zero third-party runtime dependencies. You can look up prices without signing in or supplying Steam credentials. You place and confirm listings manually on Steam. The Chinese interface works on desktop and mobile.

## Quick start

```sh
git clone https://github.com/mindydora8023-prog/steam-market.git
cd steam-market
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). On Windows, you can also double-click `start.cmd`. Press Ctrl+C in the server terminal to stop it. Restart after changing backend code.

```sh
node app/server.mjs --port 8787 --proxy http://127.0.0.1:7890
node app/server.mjs --proxy none
```

On Windows, `scripts/open-app.ps1` checks the service and opens it in your browser. Use `-CheckOnly` to check health or `-BaseUrl` to target a deployment with a path prefix.

```powershell
pwsh -File .\scripts\open-app.ps1 -CheckOnly
pwsh -File .\scripts\open-app.ps1 -BaseUrl https://example.org/steam/
```

## Price checks and batch estimates

1. Select a game and currency. Enter an item name or paste its Steam Market listing link. Links supply the game and full market name and support custom App IDs.
2. Type at least two characters for suggestions. Use ↑ / ↓ to navigate, Enter to select, and Escape to dismiss the list. Enter continues to work for Chinese IME composition. Press `/` outside an input to focus search.
3. Compare the gold **buyer price** and green **estimated payout**. The quote shows the currency, fetch time, and cache status. Switch strategies against the same snapshot, calculate payout from a buyer price, or work backward from your target payout.
4. Copy an amount such as `3.60` into the Steam listing form. Confirm the price and fees there before you list the item.

### Batch listing and portfolio estimation

1. Click **加入清单** (Add to batch) on a quote to use its current quantity. Click **+** beside a favorite to look up the item in its saved currency and add one unit. Open the batch at any time from **批量清单** in the header.
2. Pick one strategy for the batch, or enter a custom buyer price on a row. Clear that price to use the batch strategy again. Each row keeps the market snapshot, undercut amount, and fees from when it was added. Adding the same item, game, and currency again updates the snapshot and adds to the quantity while keeping any custom price. The batch holds up to 100 rows and 10,000 units per row.
3. Review the total item count and each currency’s buyer payments, Steam fees, publisher fees, total fees, and estimated payout. Fees are rounded per item before multiplication. Totals update as you edit. The drawer flags invalid inputs or items that need a price.
4. Copy the list as Markdown or download a CSV pricing sheet. Both include the item, App ID, currency, quantity, listing price, per-item payout, payout subtotal, both fees, and strategy. Markdown also includes a per-currency summary. The CSV uses UTF-8 with a BOM, decimal points, and a dedicated currency column.
5. Remove individual rows or clear the batch and undo. The batch, favorites, history, and preferences are stored in your browser’s `localStorage`. If storage is blocked, the drawer warns you and keeps editing and exports available for that page session.

Use the single-item quantity calculator when every unit is the same item at the same price. Pin or filter up to 30 favorites, and restore fee rates and strategies from up to 20 recent quotes. Share links include the item, game, currency, strategy, undercut, fees, quantity, and history range.

Cancel a query while it is running. When inputs change or a refresh fails, the app marks the old quote as stale and pauses copying and adding it to the batch. When Steam rate-limits requests, the app displays a cooldown countdown and pauses quote requests and refreshes.

## Pricing and fees

| Strategy | How it prices the item |
| --- | --- |
| Smart | Subtracts the undercut from the lowest ask. If that ask is less than half the median, it applies the undercut to the median |
| Undercut lowest | Subtracts the undercut from the lowest ask |
| Match lowest | Finds the highest attainable buyer price at or under the lowest ask |
| Median | Uses the recent median sale price as the target |

The default undercut is one minor unit, such as ¥0.01 in CNY or ¥1 in JPY. The default fees are 5% for Steam and 10% for the publisher. Adjust them under **费率与降价** (Fees and undercut). When the lowest ask exceeds the median by more than 15%, Smart flags the gap and continues to use the lowest ask.

Fees are calculated on seller proceeds with decimal integer arithmetic in the currency’s minor units. Each fee is rounded down before the minimum applies. Fee steps make some buyer prices unreachable. The app shows the attainable price and flags adjustments for rounding.

With the default fees in CNY, each minimum fee is ¥0.07 and the minimum buyer price is ¥0.21. A buyer price of ¥0.29 leaves an estimated ¥0.15. In JPY, each nonzero fee starts at ¥2. Other currencies use a one-minor-unit minimum. Check the actual price and fees in Steam’s listing form.

## Price history

History loads after the quote. Choose 30, 90, 180, or 365 days and view the seven-day moving average (MA7), volume, range, and percentile. Hover or touch the chart for the crosshair. With the chart focused, use the arrow keys or Home / End. An equivalent data table and CSV export are also available.

- The chart aggregates Steam’s public median samples by UTC day and weights them by volume. Percentiles use the daily observations. Missing dates stay empty. The range change is omitted when the starting period lacks a sample.
- Native-currency history keeps its original prices. For other currencies, the app scales the historical series using the current quote and the last historical price. Both the chart and the CSV flag these estimates.
- If history fails to load, you can retry it separately while keeping the current quote.

## Self-hosting

### Docker Compose

Run from the repository root.

```sh
docker compose up -d --build
```

The image uses `node:22-alpine` and runs as a non-root user. Compose binds to `127.0.0.1:8787` on the host by default. The container health check probes `/api/health`. Configure the following with environment variables or a `.env` file in the repository root.

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8787` | Published host port and HTTP port inside the container |
| `PUBLISH_HOST` | `127.0.0.1` | Host address for the Compose port binding |
| `STEAM_PROXY` | Empty | An HTTP CONNECT proxy URL such as `http://proxy:7890`, or `none` for a direct connection |

A proxy on the host must be reachable from the container. On Docker Desktop, use an address such as `http://host.docker.internal:7890` and make sure the proxy listens on a reachable interface.

```sh
docker compose ps
docker compose logs -f steam-market
docker compose down
```

### Linux systemd

With Node.js installed, run the installer from the repository root. The service binds to `127.0.0.1:8787` by default. The [example Caddy configuration](deploy/Caddyfile) shows how to put it behind an HTTPS reverse proxy.

```sh
sudo env PAYLOAD_DIR="$PWD" bash deploy/install.sh
systemctl status steam-market
journalctl -u steam-market -n 80 --no-pager
```

Edit `PORT`, `BIND`, or `STEAM_PROXY` in `/etc/steam-market.env`, then run `sudo systemctl restart steam-market`.

## Networking and caching

For a regular Node startup, the app checks an explicit proxy first, then `HTTPS_PROXY` / `HTTP_PROXY`, then local ports 7890, 7897, and 10809. With Clash, use its HTTP or mixed port. Use `--proxy none` to connect directly. The header status reflects the local service and its proxy configuration. Steam connectivity is checked when you make a query.

| Data | In-memory cache |
| --- | --- |
| Search suggestions | 5 minutes, keyed by game, query, and result limit |
| Current prices | 60 seconds |
| History pages | 10 minutes |
| No-price results | 2 minutes |

Identical in-flight requests share one upstream request. Refresh bypasses the corresponding cache. Search, quotes, and history share Steam’s HTTP 429 cooldown. Queues, connections, response sizes, decompression, and browser waits are bounded. Late responses cannot overwrite newer input.

## Development and checks

```sh
npm test
npm run check
```

Both commands run offline. GitHub Actions runs them on Ubuntu and Windows with Node.js 20, 22, and 24. The Windows launch-script tests use PowerShell 7 (`pwsh`).

The browser smoke test uses fixture market data and Playwright Core to check quotes, favorites, batches, clipboard and downloads, the chart, failure recovery, and narrow layouts. Set `PLAYWRIGHT_MODULE` to an existing Playwright Core `index.mjs`, or install the test tool locally.

```sh
npm install --no-save --package-lock=false playwright-core
npm run test:ui
```

The Windows default is Edge. Set `BROWSER_EXECUTABLE` to use a particular Edge or Chromium binary. On other platforms, you can use that variable or run `npx playwright-core install chromium` to install Playwright’s Chromium. Screenshots and reports go to `.ui-evidence/` by default. Override it with `UI_EVIDENCE_DIR`.

Single-item pricing and fees live in [lib/quote.js](lib/quote.js) and [lib/fees.js](lib/fees.js). The browser and unit tests use [lib/batch.js](lib/batch.js) for batch estimates and serialization. See [DESIGN.md](DESIGN.md) for the interface conventions.

## License

[MIT](LICENSE). This project is an independently developed Steam Community Market tool.
