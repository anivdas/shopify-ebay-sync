# Agent notes

## Commands
- `npm ci` – install (dev deps only; the server has zero runtime npm deps)
- `npm run check` – typecheck (server + web) + tests + UI build. Run before committing.
- `npm test` – node:test suites in `test/` (Shopify/eBay APIs are mocked via global fetch)
- `npm run dev` / `npm run dev:web` – server on :8080, Vite UI on :5173

## Conventions
- Server: TypeScript executed directly by Node 24 type stripping. Only erasable syntax (no enums/parameter properties); relative imports use `.ts` extensions.
- DB: `node:sqlite` (`src/db.ts`), schema created on startup with `CREATE TABLE IF NOT EXISTS`.
- Credentials: entered in the UI and stored encrypted (`src/credentials.ts`); env vars override.
- Shopify Admin GraphQL `2026-10`: `inventoryAdjustQuantities` requires `@idempotent(key:)` and an explicit `changeFromQuantity` (null).
- eBay: listings use the Inventory API (inventory items + offers + item groups). Don't mix with Trading/GraphQL listing APIs.
- Pin new dependencies to exact versions published at least 7 days ago.
