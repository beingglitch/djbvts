# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the dev server (Turbopack) on http://localhost:3000
- `npm run build` — production build (Turbopack)
- `npm start` — run the production build
- `npx prisma migrate dev --name <name>` — create + apply a new migration against `DATABASE_URL`
- `npx prisma migrate deploy` — apply pending migrations (production)
- `npx prisma generate` — regenerate the Prisma client (run after editing `prisma/schema.prisma`)
- `npx prisma studio` — open the DB browser

No lint or test scripts are configured.

## Required environment variables

- `DATABASE_URL` — pooled Postgres URL (used by the runtime Prisma client)
- `DIRECT_URL` — direct Postgres URL (used by Prisma migrations; see `schema.prisma`)
- `JWT_SECRET` — `src/lib/auth.ts` throws at import time if this is missing, which will crash any route that touches auth
- `REPORT_CARD_URL` or `NEXT_PUBLIC_REPORT_CARD_URL` — base URL embedded in the QR code on generated PDFs. Defaults to `https://djbvtswatsoo.com/report-card.html` in production and `http://localhost:3000/report-card.html` otherwise.

## Architecture

Single Next.js 15 App Router app (React 19, TypeScript, Tailwind v4) that ingests vehicle trip data from Excel and produces verifiable PDF reports. The whole product lives in `src/app/page.tsx` (a single ~1100-line client component) plus a handful of API routes.

### Data flow

1. **Upload** — `src/app/page.tsx` posts an XLSX file (or JSON rows) to `POST /api/reports/data`. The route parses every sheet in the workbook, normalises dates and distances, and upserts via the `(vehicleNo, reportDate)` unique key. Each upload gets a `snapshotCode` and an `UploadSnapshot` row.
2. **Browse / edit** — the page filters in-memory by vehicle, area, and one or more `YYYY-MM` month keys. `PATCH` and `DELETE` on the same route mutate single rows. Editing a row preserves its `reportDate`.
3. **Generate** — `POST /api/reports/generate` re-fetches matching rows (filters applied in SQL, date-range applied in-memory because dates are stored as `DD-MM-YYYY` strings), renders a PDF via `src/lib/report-pdf.ts`, computes a per-vehicle summary, and persists the PDF as base64 plus the summary JSON on a `PdfGeneration` row keyed by a random `verificationCode`.
4. **Verify** — the QR code on each PDF links to `/report-card.html?code=<verificationCode>` (static HTML in `public/`). That page calls `GET /api/reports/verify/[code]` for the summary and links to `GET /api/reports/pdf/[code]` for the raw PDF.

### Auth model

JWT bearer auth via `src/lib/auth.ts`. `POST /api/login` returns `{ accessToken, email }`; the client stores both in `localStorage`. `JwtClaims` carries `{ sub, email, role }` — the email is the source of truth for `uploadedBy` / `generatedBy`, **never trust client-supplied emails in request bodies**. Use `requireAuth(req)` at the top of any new authenticated route; it throws `AuthError` (with `.status`) which `errorResponse(error)` converts to a JSON response. `JWT_SECRET` is checked lazily inside `getSecret()` — a missing env var returns a clean 500 instead of crashing at import.

The frontend funnels every API call through `authedFetch(router, ...)` in `src/app/page.tsx`, which attaches `Authorization: Bearer <token>` and redirects to `/login` on 401.

**Public routes** (no auth required): `POST /api/login`, `POST /api/signup`, `GET /api/reports/verify/[code]`, `GET /api/reports/pdf/[code]`. The verify+pdf pair is the QR-code flow used by `public/report-card.html`, and the verification code itself (16 hex chars from `randomBytes(8)`) is the capability.

`ensureUserByEmail` in `src/lib/users.ts` still auto-provisions a `User` row if a token email doesn't have one. With the new flow the email always comes from a verified token, so this is just a safety net — don't reintroduce code paths that pass it client-supplied input.

### Date handling (project-specific convention)

`Report.reportDate` is a **`String` column in `DD-MM-YYYY` format**, not a `DateTime`. Every entry point normalises into this format:

- `normaliseDate` in `src/app/api/reports/data/route.ts` accepts Excel serials, `Date` objects, `DD-MM-YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, and ISO strings — and rejects summary rows containing `" - "`.
- The HTML `<input type="date">` in the UI works in `YYYY-MM-DD`; `convertToInputFormat` / `formatDisplayDate` in `page.tsx` translate between the two.
- Date-range filtering in `/api/reports/generate` first narrows by `vehicleNo` / `area` / month-key substring matches in SQL, then **parses `DD-MM-YYYY` in JS and filters in memory** for the `dateFrom`/`dateTo` bounds. New filters that need date math must do the same — don't try to compare `reportDate` strings lexicographically.
- The month filter in `buildWhereClause` matches both `DD-MM-YYYY` and legacy `YYYY-MM-DD` patterns; keep both branches if you touch it.

The `(vehicleNo, reportDate)` `@@unique` on `Report` is the upsert key, so any change to the date format would break dedup.

### PDF generation

`src/lib/report-pdf.ts` uses `pdfkit` to draw a fixed-layout 297×241mm report (21 rows per page) with an embedded QR code and the bundled `src/lib/image.png` logo. `pdfkit` is listed in `next.config.mjs` under `serverExternalPackages` — leaving it bundled triggers a `Helvetica.afm` runtime error in the Next server. The PDF generation route is also pinned to `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`; preserve both when editing.

The generated PDF is stored as base64 in `PdfGeneration.pdfBase64`. Large PDFs will bloat the row — if storage becomes a problem, the schema comment hints at moving to S3/filesystem.

### Layout notes

- `src/app/layout.js` (JS, not TS) is the root layout; the metadata still says "Create Next App".
- `src/app/page.tsx` is one large client component holding all filter, upload, edit, and generate UI state.
- `public/report-card.html` is a standalone static page (not a Next route) consumed by the QR verification link.
- Path alias `@/*` → `src/*` is configured in `tsconfig.json` but most files use relative imports; either works.
