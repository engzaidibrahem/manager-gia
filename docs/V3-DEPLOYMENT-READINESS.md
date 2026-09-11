# Deployment readiness — Gia V3 (inspect only, not implementing)

## Status: **NOT READY** for Vercel + Railway + PostgreSQL

Local PGlite V3 is ready for restaurant manual testing. Cloud/Postgres cutover is not done.

## What works locally
- Canonical absolute DB: `<root>/.data/gia-v3`
- Fail-fast against `artifacts/api-server/.data` clones
- `pnpm run start:v3` / `START-GIA-V3.bat`
- `/api/healthz` returns absolute DB path

## Remaining blockers before Vercel + Railway + PostgreSQL

1. **PGlite-only storage** — production runtime uses `@electric-sql/pglite` on disk. Railway needs PostgreSQL `DATABASE_URL`.
2. **Schema bootstrap vs migrations** — `bootstrapSchema` runs CREATE/ALTER IF NOT EXISTS for PGlite. Need a reviewed Postgres migration path (`drizzle-kit` / SQL migrations) for Railway.
3. **Data migration** — 189 items + 271 movements (and any live finance/HR) must be exported from PGlite and imported to Postgres once; not automated yet.
4. **Frontend API base URL** — Vite app uses relative `/api` (same-origin). Vercel static hosting needs rewrite/proxy to Railway or an explicit `VITE_API_BASE_URL`.
5. **CORS** — API must allow the Vercel origin if frontend and API are on different hosts.
6. **AUTH_SECRET / admin seed** — production requires strong `AUTH_SECRET` and `AUTH_ADMIN_PASSWORD` (no default password in production).
7. **Health check** — `/api/healthz` exists; Railway health check path must be configured to it.
8. **Persistent volume** — PGlite file DB is not suitable for Railway ephemeral FS; Postgres is required.
9. **Environment matrix** — document/set `DATABASE_URL`, `PORT`, `AUTH_*`, optional `GIA_PROJECT_ROOT` for each environment.
10. **Build/start commands** — Railway: API build (`pnpm --filter @workspace/api-server build`) + `node dist/index.mjs`; Vercel: frontend `vite build` with correct `BASE_PATH`.

## Not blockers for local restaurant QA
- Absolute V3 path resolution
- Purchase/finance/warehouse flows covered by `test:v3`
