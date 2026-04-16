import type { ExtractedSign as ApiExtractedSign } from "@workspace/api-client-react";

/**
 * Canonical sign type for the web app.
 *
 * All fields are now captured in the OpenAPI spec and generated client.
 * This re-export exists so internal code uses a stable local path
 * (`@/types/sign`) rather than importing from the generated client directly.
 */
export type ExtractedSign = ApiExtractedSign;
