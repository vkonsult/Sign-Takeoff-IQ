import type { ExtractedSign as ApiExtractedSign } from "@workspace/api-client-react";

/**
 * Canonical sign type for the web app.
 *
 * Extends the generated API-client type with fields that the API currently
 * returns but are not yet captured in the OpenAPI spec. Once the spec is
 * updated and the client is regenerated, the supplementary declarations below
 * can be removed, leaving this as a trivial re-export.
 */
export interface ExtractedSign extends ApiExtractedSign {
  /** The owning job's ID — present in every DB record but not yet in the OpenAPI spec. */
  jobId?: string;
  pageNumber?: number | null;
  /** Normalised horizontal marker position (0–1). */
  xPos?: number | null;
  /** Normalised vertical marker position (0–1). */
  yPos?: number | null;
  /** Where the placement originated ("pdf" | "ai" | "manual"). */
  placementSource?: string | null;
  /** AI bounding-box coordinates (normalised). */
  aiBboxX?: number | null;
  aiBboxY?: number | null;
  aiBboxW?: number | null;
  aiBboxH?: number | null;
  aiBbox?: boolean | null;
  /** Granular data-source tag. */
  dataSource?: "pdf" | "ai" | "manual" | null;
  /** ADA compliance flag. */
  adaRequired?: boolean;
  /** Reason an exception was raised for this sign. */
  exceptionReason?: string | null;
}
