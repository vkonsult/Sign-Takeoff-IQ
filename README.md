# Sign TakeOff IQ

AI-assisted sign takeoff portal for sign contractors and fabricators. Extracts sign data from PDF architectural plans using Gemini AI.

## Development

### Prerequisites

- Node.js 20+
- pnpm 9+

### Install dependencies

```bash
pnpm install
```

### Start the API server

```bash
pnpm --filter @workspace/api-server dev
```

### Start the web app

```bash
pnpm --filter @workspace/web dev
```

## Regenerating API types

The TypeScript types used by the web app are generated automatically from the OpenAPI spec at `lib/api-spec/openapi.yaml`. **Do not edit the generated files by hand** — any manual changes will be overwritten the next time codegen runs.

### When to regenerate

Run codegen whenever you add, remove, or change fields in the API:

1. Update `lib/api-spec/openapi.yaml` to reflect the new or changed API shape.
2. Run codegen from the project root:

```bash
pnpm codegen
```

This regenerates:
- `lib/api-client-react/src/generated/api.schemas.ts` — TypeScript interfaces for all API schemas
- `lib/api-client-react/src/generated/api.ts` — TanStack Query hooks for every API endpoint
- `lib/api-zod/src/generated/` — Zod validation schemas (used for server-side validation)

3. Commit both the updated spec and the regenerated files together so the repo stays in sync.

### Keeping generated files in sync

A CI check called **`codegen-sync`** reruns `pnpm codegen` and then verifies that the output matches what is committed. The check fails if the generated files differ from the committed versions, which catches cases where someone edits `openapi.yaml` without running codegen.

To run the check locally before pushing:

```bash
pnpm codegen && git diff --exit-code lib/api-client-react/src/generated lib/api-zod/src/generated
```

If the check fails, run `pnpm codegen` and commit the updated generated files alongside the spec change.

### How it works

Codegen is powered by [Orval](https://orval.dev/). The configuration lives in `lib/api-spec/orval.config.ts` and points at `lib/api-spec/openapi.yaml` as the single source of truth.
