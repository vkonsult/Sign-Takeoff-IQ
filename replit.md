# Sign TakeOff IQ

## Overview
Sign TakeOff IQ is an MVP web application designed for sign contractors and fabricators. Its primary purpose is to automate the extraction of sign-related data from PDF architectural plan documents. The system leverages Gemini AI to identify sign types, quantities, dimensions, mounting, illumination, finishes, materials, messages, and locations. Users can review the extracted data in a structured table, supported by confidence scores and flags, and utilize a PDF review modal with visual markers. The final output is an XLSX file containing the structured sign data, streamlining fabrication and bidding workflows.

## User Preferences
I prefer that the agent focuses on the core tasks of developing and refining the Sign TakeOff IQ application. When implementing new features or making significant changes, please ask for confirmation and provide a brief explanation of the proposed approach. I value iterative development, with clear communication on progress and any potential roadblocks.

## System Architecture
Sign TakeOff IQ is built as a pnpm workspace monorepo using TypeScript.

**Frontend:**
- Developed with React, Vite, and TanStack Query.
- UI/UX features include a review table with confidence badges, a PDF review modal with color-coded sign markers, and an onboarding wizard for new organizations.
- Frontend role detection is handled via Clerk JWTs, dictating navigation and access to features.

**Backend & API:**
- The API server is built with Express 5.
- Uses OpenAPI specification (`lib/api-spec/openapi.yaml`) as the single source of truth for API types. Run `pnpm codegen` from the project root to regenerate TypeScript interfaces and TanStack Query hooks whenever the spec changes. Do not edit `lib/api-client-react/src/generated/` or `lib/api-zod/src/generated/` by hand.
- All API routes, except `/api/healthz`, require Clerk-based authentication with role-based access control (SUPER_ADMIN, ADMIN, SALES, ESTIMATOR, PROJECT_MANAGER).
- Activity tracking records significant user actions to the `activity_logs` table, providing role-scoped visibility and job-specific activity history.

**Data & AI:**
- PostgreSQL is used as the primary database, managed with Drizzle ORM.
- Gemini AI (`gemini-2.5-flash`) is central to data extraction, configured for maximum JSON output and includes exponential backoff for rate limit retries and JSON repair logic.
- A two-phase extraction process classifies PDF pages into `floor_plan`, `sign_schedule`, or `other`, performing specific AI extractions for each.
- Confidence scores (high, medium, low) are assigned to extracted data, with a `review_flag` for low-confidence entries or missing required fields.
- A RAG (Retrieval Augmented Generation) knowledge layer is implemented using ChromaDB, with collections for various sign industry regulations, glossaries, and standards, enabling semantic search and contextual understanding for AI.

**File Management:**
- Files are stored in a structured manner within the `data/` directory for uploads, parsed JSON results, XLSX exports, and ChromaDB vector store.
- XLSX export functionality uses `exceljs` for generating formatted spreadsheets with conditional styling based on confidence scores.

## External Dependencies
- **Clerk**: For user authentication, authorization, and multi-tenancy management.
- **Gemini AI**: Used for intelligent data extraction from PDF documents. The Replit-managed integration is used for core extraction, while a separate Google AI API key is required for `text-embedding-004` embeddings in ChromaDB.
- **PostgreSQL**: Relational database for storing application data.
- **Drizzle ORM**: Object-Relational Mapper for interacting with PostgreSQL.
- **ChromaDB**: Vector database for the RAG knowledge layer. Requires a separate Python server instance.
- **pdfjs**: For PDF parsing and word extraction.
- **exceljs**: For generating XLSX export files.