/** Shared type for a sign record used across the web app. */
export interface ExtractedSign {
  id: string;
  jobId?: string;
  jobFileId?: string | null;
  sheetNumber?: string | null;
  detailReference?: string | null;
  signType?: string | null;
  signIdentifier?: string | null;
  quantity?: number | null;
  location?: string | null;
  dimensions?: string | null;
  mountingType?: string | null;
  finishColor?: string | null;
  illumination?: string | null;
  materials?: string | null;
  messageContent?: string | null;
  notes?: string | null;
  pageNumber?: number | null;
  xPos?: number | null;
  yPos?: number | null;
  placementSource?: string | null;
  manuallyAdded?: boolean;
  userVerified?: boolean;
  adaRequired?: boolean;
  confidenceScore: number;
  reviewFlag: boolean;
  exceptionReason?: string | null;
  aiBboxX?: number | null;
  aiBboxY?: number | null;
  aiBboxW?: number | null;
  aiBboxH?: number | null;
  aiBbox?: boolean | null;
  dataSource?: "pdf" | "ai" | "manual" | null;
}
