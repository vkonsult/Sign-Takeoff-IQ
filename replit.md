# Sign TakeOff IQ

## Overview

Sign TakeOff IQ is an MVP web app for sign contractors and fabricators. Users upload PDF architectural plan documents, the system extracts sign-related data (types, quantities, dimensions, mounting, illumination, finishes, materials, messages, locations, page numbers) using Gemini AI, displays results in a review table with confidence scores and flags, provides a PDF review modal with color-coded sign markers and page navigation, and exports structured data to XLSX.

## Architecture

pnpm workspace monorepo using TypeScript. 

- **Frontend**: React + Vite + TanStack Query (port 22333, previewPath `/`)
- **API server**: Express 5 (port 8080, proxied via Vite `/api` proxy)
- **Database**: PostgreSQL + Drizzle ORM
- **AI**: Gemini (via `@workspace/integrations-gemini-ai`, model `gemini-2.5-flash`)
- **API codegen**: Orval (from OpenAPI spec `lib/api-spec/openapi.yaml`)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod, `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (ESM bundle via `build.mjs`)
- **Frontend build**: Vite

## Structure

```text
artifacts/
├── api-server/             # Express API server
│   └── src/
│       ├── app.ts          # Express app setup, middleware
│       ├── index.ts        # Server entry point
│       ├── routes/         # Route handlers (health, upload, jobs)
│       └── lib/
│           ├── extraction.ts              # Main AI extraction orchestration (~2475 lines)
│           ├── extraction-classification.ts  # Page-type classification module (split from extraction.ts)
│           ├── extraction-heuristic.ts    # Residential/institutional heuristic extractor
│           ├── pdf-processor.ts           # Multi-file job processing pipeline
│           ├── pdf-words.ts               # pdfjs phrase/word extraction + caching
│           ├── pdf-render.ts              # Page-to-PNG rendering
│           ├── sign-vocabulary.ts         # Canonical keyword lists + building-type maps
│           ├── signage-schedule-parser.ts # Structured sign-schedule table parser (legacy text path)
│           ├── sign-schedule-extractor.ts # Phase 3: Gemini visual read of sign schedule pages → PlaqueTypeRow[]
│           ├── verifier.ts                # Phase 6: pre-output verification checks V1-V7
│           ├── storage.ts                 # File storage helpers
│           └── export.ts                  # XLSX export
└── web/                    # React + Vite frontend
    └── src/
        ├── App.tsx          # Router + QueryClient setup
        ├── pages/           # Home.tsx, JobDetails.tsx, JobsList.tsx
        ├── components/      # layout/Sidebar.tsx, layout/Shell.tsx, ui/*
        └── hooks/           # use-takeoff.ts

lib/
├── api-spec/               # OpenAPI spec + Orval codegen config
├── api-client-react/       # Generated React Query hooks + fetch client
├── api-zod/                # Generated Zod schemas from OpenAPI
├── db/                     # Drizzle ORM schema + DB connection
└── integrations-gemini-ai/ # Gemini AI wrapper (Replit-managed, no user API key)
```

## Authentication & Multi-Tenancy

Clerk is used for authentication. All API routes except `/api/healthz` require a valid Clerk session (cookie-based for web). Role hierarchy: `SUPER_ADMIN` → `ADMIN` → `SALES/ESTIMATOR/PROJECT_MANAGER`.

- **`VITE_CLERK_PUBLISHABLE_KEY`**, **`CLERK_SECRET_KEY`**, **`CLERK_PUBLISHABLE_KEY`** — auto-provisioned secrets
- **`SUPER_ADMIN_GUEST_TOKEN`** — optional secret; when set, `Authorization: Bearer <token>` bypasses Clerk for SUPER_ADMIN access

### Admin Portals (Task #9 — complete)

**Super Admin** routes (`/admin/*`) — platform-wide management, `requireRole("SUPER_ADMIN")` on all backend routes:
- `/admin` → Dashboard (stats: org count, user count, job count via `GET /api/admin/stats`)
- `/admin/organizations` → Org list with job count + last activity (`GET /api/admin/organizations`), create org with optional owner Clerk invitation (`POST /api/admin/organizations`), update org (`PATCH /api/admin/organizations/:orgId`), list members (`GET /api/admin/organizations/:orgId/members`)
- `/admin/users` → All users across all orgs enriched with Clerk `lastSignInAt` (`GET /api/admin/users`)
- Logo upload: `POST /api/admin/logo` (ADMIN+), served statically at `/api/logos/:filename` before auth

**Tenant Admin** (settings sidebar — ADMIN only, not SUPER_ADMIN):
- `/settings` → Company profile (`GET /PATCH /api/admin/org`)
- `/settings/users` → Team members with last-login column (`GET /api/admin/org/members` enriched with Clerk `lastSignInAt`); create user (`POST /api/admin/users`), update role (`PATCH /api/admin/users/:membershipId`), remove (`DELETE /api/admin/users/:membershipId`)
- User creation: admin sets password directly; Clerk `createUser` + DB membership row; no temp password returned

**Onboarding wizard** (`/onboarding`):
- 2-step form: Step 1 = company info (PATCHes org fields), Step 2 = logo upload (PATCHes logoUrl + `onboardingComplete: true`, then redirects to `/jobs`)
- `AdminRoute` and `OnboardingRoute` redirect tenant ADMINs to `/onboarding` when `onboardingComplete = false`
- Completing the wizard auto-redirects to `/jobs`

**Frontend role detection** (`hooks/use-user-role.ts`):
- Reads `user.publicMetadata.role` + `.organizationId` from Clerk JWT
- Falls back to "SUPER_ADMIN" in guest (token) mode
- Sidebar shows role-appropriate nav sections automatically
- Frontend: `ClerkProvider` in `App.tsx`; `/sign-in` and `/sign-up` routes; `<Show>` guards on protected pages
- API: `clerkMiddleware()` in `app.ts`; `requireAuth` from `src/middlewares/authMiddleware.ts`; `requireRole(...)` factory for role-based guards

## Database Schema

Five tables in PostgreSQL:

### `organizations`
- `id` UUID (PK)
- `name`, `slug` (unique), `email`, `phone`, `address`, `website`, `logo_url` text
- `onboarding_complete` boolean (default false)
- `created_at`, `updated_at` timestamps

### `organization_memberships`
- `id` UUID (PK)
- `organization_id` UUID (FK → organizations)
- `clerk_user_id` text
- `full_name`, `email` text (nullable)
- `role` enum (SUPER_ADMIN | ADMIN | SALES | ESTIMATOR | PROJECT_MANAGER)
- `created_at`, `updated_at` timestamps

### `jobs`
- `id` UUID (PK)
- `organization_id` UUID (FK → organizations, nullable)
- `status` text (pending | processing | completed | failed)
- `file_count` int
- `error` text (nullable)
- `created_at`, `updated_at` timestamps

### `job_files`
- `id` UUID (PK)
- `job_id` UUID (FK → jobs)
- `original_name` text
- `stored_path` text
- `page_count` int (nullable, populated after extraction)
- `extracted_text` text (nullable, first 10k chars)
- `created_at` timestamp

### `extracted_signs`
- `id` UUID (PK)
- `job_id` UUID (FK → jobs)
- `job_file_id` UUID (FK → job_files)
- `sheet_number`, `detail_reference`, `sign_type`, `sign_identifier` text (nullable)
- `quantity` int (default 1)
- `location`, `dimensions`, `mounting_type`, `finish_color` text (nullable)
- `illumination`, `materials`, `message_content`, `notes` text (nullable)
- `confidence_score` numeric (0–1)
- `review_flag` boolean (true if confidence < 0.7)
- `raw_json` jsonb
- `created_at` timestamp

## API Endpoints

All prefixed `/api`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| POST | `/upload` | Upload PDFs (multipart/form-data, field: `files[]`) → creates job |
| POST | `/jobs/:jobId/process` | Trigger Gemini extraction |
| GET | `/jobs/:jobId` | Job status + extracted signs |
| GET | `/jobs/:jobId/export` | Download XLSX |
| GET | `/jobs` | List all jobs |
| POST | `/knowledge/ingest` | Ingest knowledge files into ChromaDB (optional `collection` + `file_path` body params) |
| POST | `/knowledge/query` | Semantic search against ChromaDB (required `text`, optional `nResults`, `jurisdiction`, `doc_type`) |

## User Flow

1. Upload PDF plan files → creates a job in "pending" state
2. Navigate to job page → click "Start Extraction"
3. Gemini AI reads PDF text, extracts sign schedules (JSON output)
4. Review table shows all extracted signs with confidence badges
5. Export to XLSX for use in fabrication/bidding workflows

## File Storage

- Uploads: `data/uploads/{jobId}/`
- Parsed JSON results: `data/parsed/{jobId}.json`
- XLSX exports: `data/exports/{jobId}.xlsx`
- Temp upload staging: `/tmp/sign-takeoff-uploads/`
- ChromaDB vector store: `data/chroma/` (workspace root, requires ChromaDB Python server)

## RAG Knowledge Layer (Task #2)

Six ChromaDB collections for sign industry knowledge:

| Collection | Purpose |
|-----------|---------|
| `federal_codes` | ADA, MUTCD, OSHA federal sign regulations |
| `state_codes` | State building codes and accessibility standards |
| `city_codes` | Local jurisdiction ordinances and permits |
| `sign_glossary` | Industry terminology, materials, finishes |
| `plan_guides` | Plan reading guides, sign schedule formats |
| `customer_standards` | Customer-specific brand standards |

Knowledge files live in `knowledge/{collection_name}/` with YAML front-matter:
```markdown
---
jurisdiction: federal
doc_type: federal_codes
section: "ADA 703.7.2"
effective_date: "2010-09-15"
status: active
---
Content...
```

Scripts (run from workspace root with `pnpm --filter @workspace/scripts run ...`):

| Script | Description |
|--------|-------------|
| `validate-knowledge` | Validate front-matter metadata in all knowledge files |
| `ingest-knowledge [collection] [--dry-run]` | Embed and ingest knowledge into ChromaDB |
| `rebuild-index [collection] [--dry-run]` | Wipe + rebuild a collection from source files |

Requirements for RAG:
- **ChromaDB server**: `pip install chromadb && chroma run --path data/chroma`
- **GOOGLE_AI_API_KEY**: Google AI API key for `text-embedding-004` embeddings (not the Replit integration key)

## Key Notes — Extraction Engine

### Two-Phase ADA Extraction (`artifacts/api-server/src/lib/extraction.ts`)

PDF pages are classified into three types: floor_plan, sign_schedule, or other.

**Pass 1 — Sign Schedule:** Pages with sign schedule keywords are sent to Gemini with a detailed sign-industry extraction prompt (finds explicitly specified/designed signs).

**Pass 2 — Floor Plan ADA:** Floor plan pages are batched (240K chars/batch) and sent with an ADA-compliance prompt that instructs Gemini to enumerate EVERY room and generate all legally required signs: Room ID signs for every room, Exit signs at every egress door, Stairwell IDs, Elevator floor levels, Restroom signs, Fire safety signs, and Mechanical/utility room IDs.

**Pass 3 — Fallback:** If passes 1 & 2 produce no results, a general extraction is run on all pages.

### Gemini Configuration
- Model: `gemini-2.5-flash`, `maxOutputTokens: 65536`, thinking disabled (`thinkingBudget: 0`)
- Thinking mode disabled to maximize JSON output budget (prevents truncation)
- Rate limit retry: exponential backoff (4 retries, up to 60s) for 429 errors
- JSON repair: `repairTruncatedJson()` recovers partial arrays from truncated responses by extracting all complete top-level objects

### Other Notes
- Confidence scores: ≥0.8 = high (green), 0.6–0.8 = medium (yellow), <0.6 = low/flagged (red)
- `review_flag = true` when confidence < 0.7 or required fields are missing
- XLSX export uses `exceljs` with conditional formatting (colored confidence cells, flagged row highlighting)
- Vite proxy forwards `/api` requests to Express API server at port 8080

## Activity Tracking

All significant user actions are recorded to the `activity_logs` table (fire-and-forget, never blocks responses):

- `job_opened` — when a user opens a job's detail page (`GET /jobs/:jobId`)
- `scan_run` — when a scan/process is triggered (`POST /jobs/:jobId/process`)
- `sign_updated` — when a sign field is edited (`PATCH /extracted-signs/:signId`)
- `xlsx_exported` — when XLSX export is downloaded (`GET /jobs/:jobId/export`)

**Role-scoped visibility**: SUPER_ADMIN sees all tenants + org filter; ADMIN sees own org; SALES/PM/Estimator sees own activity only.

**`GET /activity`** — paginated activity feed (page size 50), filterable by `jobId`, `eventType`, `orgId` (SUPER_ADMIN only), `from` (ISO date).

**`GET /jobs`** — includes `lastActivityAt`, `lastActivityUser`, `lastActivityInitials`, `lastActivityType` scalar subquery columns. The Jobs list renders a user initials badge with a tooltip showing who last touched the plan and when.

**Frontend**: `/activity` route → `ActivityPage.tsx` (filterable table, event badges, user initials display, relative timestamps). Activity sidebar link added between "All Jobs" and "Training Import".

## Sentry Error Monitoring

Sentry is used for production error reporting in the API server.

- **`SENTRY_DSN`** — Replit Secret; consumed by `@sentry/node` at startup.
- Alert rules (error-rate spike, new unhandled issue, high-frequency issue) and
  notification channels (email + Slack) are documented in
  **`docs/sentry-alerts.md`**.

## Development Commands

```bash
# Start frontend
pnpm --filter @workspace/web run dev

# Start API server  
pnpm --filter @workspace/api-server run dev

# Push DB schema
pnpm --filter @workspace/db run push

# Run codegen (after changing openapi.yaml)
pnpm --filter @workspace/api-spec run codegen

# TypeScript typecheck
pnpm run typecheck
```
