# Sign Takeoff Portal

## Overview

Sign Takeoff Portal is an MVP web app for sign contractors and fabricators. Users upload PDF architectural plan documents, the system extracts sign-related data (types, quantities, dimensions, mounting, illumination, finishes, materials, messages, locations) using Gemini AI, displays results in a review table with confidence scores and flags, and exports structured data to XLSX.

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
│       └── lib/            # storage.ts, extraction.ts, export.ts
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

## Database Schema

Three tables in PostgreSQL:

### `jobs`
- `id` UUID (PK)
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

## Key Notes

- Gemini extraction uses `gemini-2.5-flash` with a detailed sign-industry prompt
- PDF text is extracted via `pdf-parse`, then sent to Gemini as structured extraction task
- Confidence scores: ≥0.8 = high (green), 0.6–0.8 = medium (yellow), <0.6 = low/flagged (red)
- `review_flag = true` when confidence < 0.7 or required fields are missing
- XLSX export uses `exceljs` with conditional formatting (colored confidence cells, flagged row highlighting)
- Vite proxy forwards `/api` requests to Express API server at port 8080

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
