import { useState, useRef, useEffect, useCallback } from "react";
import { useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/Shell";
import { apiFetch, openPdfInNewTab } from "@/lib/apiClient";
import { useJobDetails, useStartExtraction, downloadExport, useUpdateJobName } from "@/hooks/use-takeoff";
import { useExportButtonState } from "@/hooks/useExportButtonState";
import { useToast } from "@/hooks/use-toast";
import { UnifiedPlanViewer } from "@/components/UnifiedPlanViewer";
import type { ExtractedSign as SignMarker } from "@/components/UnifiedPlanViewer";
import { SignSpecModal } from "@/components/SignSpecModal";
import { AiScansTab } from "@/components/AiScansTab";
import { SignSpecsTab } from "@/components/SignSpecsTab";
import { ComplianceTab } from "@/components/ComplianceTab";
import {
  getGetJobQueryKey,
  useGetPlaqueSchedule,
  useGetOccupantLoads,
  useExtractPlaqueSchedule,
  useExtractOccupantLoads,
} from "@workspace/api-client-react";
import type { PlaqueScheduleEntry, OccupantLoadEntry, AssemblyRoom } from "@workspace/api-client-react";
import { 
  FileText, 
  Cpu, 
  CheckCircle2, 
  AlertTriangle, 
  Download, 
  Play, 
  Loader2,
  ListFilter,
  Pencil,
  PenLine,
  Zap,
  MapPin,
  Crosshair,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Layers,
  Stamp,
  ShieldCheck,
  Eye,
  EyeOff,
  RefreshCw,
  BarChart2,
  RotateCcw,
  LayoutGrid,
  ExternalLink,
  Clock,
  Brain,
  Users,
  BookOpen,
  Lock,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { exportMarkedupPdf, type MarkerSign } from "@/lib/exportMarkedupPdf";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

// ── Processing Timeline ──────────────────────────────────────────────────────

interface ProcessingStep {
  step: string;
  label: string;
  durationMs: number;
  startedAt: string;
  details?: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// UUID pattern to detect per-file step suffixes
const PER_FILE_STEP_RE = /^(.+?)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface FileSummary {
  fileId: string;
  fileName: string;
  pages: number;
  excludedPages: number;
  classifiedPages: { floor_plan: number; sign_schedule: number; both: number; unknown: number; excluded: number };
  textDurationMs: number;
  imageDurationMs: number;
}

function getClassificationLabel(cp: { floor_plan: number; sign_schedule: number; both: number; unknown: number; excluded: number }): string {
  const hasFP = cp.floor_plan > 0;
  const hasSS = cp.sign_schedule > 0;
  const hasBoth = cp.both > 0;
  // A file with ONLY "both" pages → "both"; mixed floor+sched without "both" pages → "both"
  if (hasBoth || (hasFP && hasSS)) return "both";
  if (hasFP) return "floor plan";
  if (hasSS) return "sign schedule";
  return "unknown";
}

function ProcessingTimeline({ steps }: { steps: ProcessingStep[] }) {
  // Separate total step and per-file steps from top-level steps
  const total = steps.find((s) => s.step === "total");

  // Classify each step: top-level vs per-file (has UUID suffix)
  const topLevelSteps: ProcessingStep[] = [];
  const perFileSteps: ProcessingStep[] = [];
  for (const step of steps) {
    if (step.step === "total") continue;
    if (PER_FILE_STEP_RE.test(step.step)) {
      perFileSteps.push(step);
    } else {
      topLevelSteps.push(step);
    }
  }

  // Build fileId → { spatial, text, visual } map from per-file steps
  type FileStepGroup = {
    fileId: string;
    spatial?: ProcessingStep;
    text?: ProcessingStep;
    visual?: ProcessingStep;
    others: ProcessingStep[];
  };
  const fileStepGroups = new Map<string, FileStepGroup>();
  for (const step of perFileSteps) {
    const match = PER_FILE_STEP_RE.exec(step.step);
    if (!match) continue;
    const [, baseType, fileId] = match as [string, string, string];
    if (!fileStepGroups.has(fileId)) {
      fileStepGroups.set(fileId, { fileId, others: [] });
    }
    const group = fileStepGroups.get(fileId)!;
    if (baseType === "spatial_prepass") group.spatial = step;
    else if (baseType === "text_extraction") group.text = step;
    else if (baseType === "visual_verification") group.visual = step;
    else group.others.push(step);
  }

  // Use the extraction step's details.files array (from backend) when available,
  // falling back to per-file step aggregation.
  const extractionStep = topLevelSteps.find((s) => s.step === "extraction");
  const backendFiles = extractionStep?.details?.files as FileSummary[] | undefined;

  // Build a generic map: parentStepKey → ordered list of child fileIds.
  // For each per-file step group, determine the appropriate parent:
  //   1. Look for a matching top-level step with the same base name (e.g. "text_extraction")
  //   2. Fall back to the "extraction" aggregate step
  // This ensures future per-file step types are automatically grouped under their parent.
  const topLevelStepKeys = new Set(topLevelSteps.map((s) => s.step));
  const parentToFileIds = new Map<string, string[]>();

  // Seed extraction's ordered fileIds from the backend files array when available
  if (backendFiles && backendFiles.length > 0) {
    parentToFileIds.set("extraction", backendFiles.map((f) => f.fileId));
  }

  for (const [fileId, group] of fileStepGroups.entries()) {
    // Collect all base types present for this file group
    const baseTypes = [
      group.spatial ? "spatial_prepass" : null,
      group.text ? "text_extraction" : null,
      group.visual ? "visual_verification" : null,
      ...group.others.map((s) => PER_FILE_STEP_RE.exec(s.step)?.[1] ?? null),
    ].filter((t): t is string => t !== null);

    // For each base type, find the parent top-level step
    const assignedParents = new Set<string>();
    for (const bt of baseTypes) {
      const parentId = topLevelStepKeys.has(bt) ? bt : "extraction";
      if (!assignedParents.has(parentId)) {
        assignedParents.add(parentId);
        if (!parentToFileIds.has(parentId)) parentToFileIds.set(parentId, []);
        const arr = parentToFileIds.get(parentId)!;
        if (!arr.includes(fileId)) arr.push(fileId);
      }
    }
  }

  const maxMs = Math.max(...topLevelSteps.map((s) => s.durationMs), 1);

  const STEP_COLORS: Record<string, string> = {
    project_info: "bg-blue-500",
    spec_processing: "bg-purple-500",
    extraction: "bg-amber-500",
    deduplication: "bg-teal-500",
    word_match: "bg-green-500",
    db_insert: "bg-gray-400",
    bbox_persist: "bg-cyan-500",
  };

  function getBarColor(step: string): string {
    return STEP_COLORS[step] ?? "bg-muted-foreground";
  }

  function formatDetails(details: Record<string, unknown> | undefined): string | null {
    if (!details) return null;
    const parts: string[] = [];
    const d = details as Record<string, number | string | boolean | undefined>;
    const { rows, pages, inputTokens, outputTokens, verified, discoveries, matched, totalSigns, textAfter, imageAfter, textRows, imageRows, signsExtracted, specFileCount, succeeded, failed, textBefore, imageBefore, classified, floorPlan, signSchedule, filesWithBboxes, pagesWithBboxes } = d;
    const { skipReason, skipped } = details as Record<string, string | boolean | undefined>;
    if (specFileCount != null) parts.push(`${specFileCount} spec file${Number(specFileCount) !== 1 ? "s" : ""}`);
    if (rows != null) parts.push(`${rows} rows`);
    if (pages != null) parts.push(`${pages} pages`);
    if (classified != null) parts.push(`${classified} classified`);
    if (floorPlan != null) parts.push(`${floorPlan} floor plan`);
    if (signSchedule != null) parts.push(`${signSchedule} sign sched`);
    if (filesWithBboxes != null) parts.push(`${filesWithBboxes} file${Number(filesWithBboxes) !== 1 ? "s" : ""}`);
    if (pagesWithBboxes != null) parts.push(`${pagesWithBboxes} page${Number(pagesWithBboxes) !== 1 ? "s" : ""}`);
    if (inputTokens != null) parts.push(`${Number(inputTokens).toLocaleString()} in-tok`);
    if (outputTokens != null) parts.push(`${Number(outputTokens).toLocaleString()} out-tok`);
    if (succeeded != null) parts.push(`${succeeded} ok`);
    if (failed != null && Number(failed) > 0) parts.push(`${failed} failed`);
    if (verified != null) parts.push(`${verified} verified`);
    if (discoveries != null) parts.push(`${discoveries} discoveries`);
    if (totalSigns != null && matched != null) parts.push(`${matched}/${totalSigns} matched`);
    if (textBefore != null && textAfter != null) parts.push(`${textAfter}/${textBefore} text`);
    else if (textAfter != null) parts.push(`${textAfter} text`);
    if (imageBefore != null && imageAfter != null) parts.push(`${imageAfter}/${imageBefore} image`);
    else if (imageAfter != null) parts.push(`${imageAfter} image`);
    if (textRows != null) parts.push(`${textRows} text rows`);
    if (imageRows != null) parts.push(`${imageRows} image rows`);
    if (signsExtracted != null) parts.push(`${signsExtracted} signs`);
    if (skipped && skipReason) parts.push(`skipped: ${skipReason}`);
    else if (skipped) parts.push("skipped");
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  // Build sub-row data for a given fileId
  function buildFileSummary(fileId: string): FileSummary | null {
    // Prefer backend-provided files array
    if (backendFiles) {
      const f = backendFiles.find((bf) => bf.fileId === fileId);
      if (f) {
        // Ensure classifiedPages has all required fields (backward compat with older jobs)
        return {
          ...f,
          classifiedPages: {
            floor_plan: f.classifiedPages?.floor_plan ?? 0,
            sign_schedule: f.classifiedPages?.sign_schedule ?? 0,
            both: (f.classifiedPages as Record<string, number>)?.both ?? 0,
            unknown: (f.classifiedPages as Record<string, number>)?.unknown ?? 0,
            excluded: (f.classifiedPages as Record<string, number>)?.excluded ?? 0,
          },
        };
      }
    }
    // Fall back to assembling from per-file steps
    const group = fileStepGroups.get(fileId);
    if (!group) return null;
    const spatialDetails = group.spatial?.details ?? {};
    const textDetails = group.text?.details ?? {};
    const fileName = group.text
      ? (group.text.label.includes(" — ") ? group.text.label.split(" — ").slice(1).join(" — ") : group.text.label)
      : group.spatial
        ? (group.spatial.label.includes(" — ") ? group.spatial.label.split(" — ").slice(1).join(" — ") : group.spatial.label)
        : fileId.slice(0, 8);
    // Prefer nested classifiedPages (new schema) then fall back to flat legacy fields
    const cp = (spatialDetails.classifiedPages as Record<string, number> | undefined) ?? {};
    const fpCount = cp.floor_plan ?? (spatialDetails.floorPlan as number) ?? 0;
    const ssCount = cp.sign_schedule ?? (spatialDetails.signSchedule as number) ?? 0;
    const bothCount = cp.both ?? (spatialDetails.both as number) ?? 0;
    const unknownCount = cp.unknown ?? (spatialDetails.unknown as number) ?? 0;
    // Prefer excludedPages key, then legacy excluded key, then unknown count
    const excludedCount = (spatialDetails.excludedPages as number) ?? cp.excluded ?? (spatialDetails.excluded as number) ?? unknownCount;
    return {
      fileId,
      fileName,
      pages: (spatialDetails.pages as number) ?? (textDetails.pages as number) ?? 0,
      excludedPages: excludedCount,
      classifiedPages: {
        floor_plan: fpCount,
        sign_schedule: ssCount,
        both: bothCount,
        unknown: unknownCount,
        excluded: excludedCount,
      },
      textDurationMs: group.text?.durationMs ?? 0,
      imageDurationMs: group.visual?.durationMs ?? 0,
    };
  }

  function renderTopLevelRow(step: ProcessingStep) {
    const widthPct = Math.max(2, (step.durationMs / maxMs) * 100);
    const detailStr = formatDetails(step.details);
    // Generic: render sub-rows for any parent step that has per-file children
    const childFileIds = parentToFileIds.get(step.step) ?? [];
    const hasSubRows = childFileIds.length > 0;
    const borderColor = step.step === "extraction" ? "border-amber-500/30" : "border-muted-foreground/20";
    return (
      <div key={step.step}>
        <div className="flex items-center gap-4" title={detailStr ?? undefined}>
          <div className="w-56 shrink-0 text-sm text-foreground/80 truncate leading-tight">
            {step.label}
          </div>
          <div className="flex-1 h-5 bg-muted/40 rounded overflow-hidden">
            <div
              className={`h-full rounded ${getBarColor(step.step)}`}
              style={{ width: `${widthPct}%`, opacity: 0.75 }}
            />
          </div>
          <div className="w-16 shrink-0 text-right text-sm font-mono text-foreground/70">
            {formatDuration(step.durationMs)}
          </div>
          {detailStr && (
            <div className="w-72 shrink-0 text-xs text-muted-foreground truncate">
              {detailStr}
            </div>
          )}
        </div>
        {hasSubRows && (
          <div className={`mt-1 space-y-1 pl-4 border-l-2 ${borderColor} ml-4`}>
            {childFileIds.map((fileId) => renderFileSubRow(fileId, step.step))}
          </div>
        )}
      </div>
    );
  }

  // Parent-context-aware sub-row rendering.
  // parentStepKey controls duration and details displayed:
  //   "text_extraction"     → text-only duration, row count
  //   "visual_verification" → visual-only duration, verifications count
  //   "extraction" / other  → combined duration, classification badge + T/V breakdown
  function renderFileSubRow(fileId: string, parentStepKey: string) {
    const summary = buildFileSummary(fileId);
    if (!summary) return null;

    const group = fileStepGroups.get(fileId);
    const visualSkipped = (group?.visual?.details?.skipped as boolean | undefined) ?? false;

    let displayMs: number;
    let detailContent: React.ReactNode;

    const processedPages = summary.pages - summary.excludedPages;
    const exclLabel = summary.excludedPages > 0
      ? `${summary.excludedPages} unclassified`
      : null;

    if (parentStepKey === "text_extraction") {
      displayMs = summary.textDurationMs;
      const rows = group?.text?.details?.rows as number | undefined;
      detailContent = (
        <>
          {processedPages} processed
          {exclLabel && <span className="text-orange-400/80 ml-1">· {exclLabel} excl</span>}
          {rows != null && <span className="ml-1 text-foreground/40">· {rows} rows</span>}
        </>
      );
    } else if (parentStepKey === "visual_verification") {
      displayMs = summary.imageDurationMs;
      const verified = group?.visual?.details?.verified as number | undefined;
      const discoveries = group?.visual?.details?.discoveries as number | undefined;
      const classLabel = getClassificationLabel(summary.classifiedPages);
      detailContent = visualSkipped
        ? (
          <>
            <span className="inline-block bg-muted/60 rounded px-1 mr-1 text-[10px] font-medium text-foreground/60">
              {classLabel}
            </span>
            <span className="text-muted-foreground/50">skipped</span>
          </>
        )
        : (
          <>
            <span className="inline-block bg-muted/60 rounded px-1 mr-1 text-[10px] font-medium text-foreground/60">
              {classLabel}
            </span>
            {processedPages} of {summary.pages} pg
            {exclLabel && <span className="text-orange-400/80 ml-1">· {exclLabel} skipped</span>}
            {verified != null && <span className="ml-1 text-foreground/40">· {verified} verified</span>}
            {discoveries != null && discoveries > 0 && <span className="ml-1 text-foreground/40">· {discoveries} found</span>}
          </>
        );
    } else {
      displayMs = summary.textDurationMs + summary.imageDurationMs;
      const classLabel = getClassificationLabel(summary.classifiedPages);
      detailContent = (
        <>
          <span className="inline-block bg-muted/60 rounded px-1 mr-1 text-[10px] font-medium text-foreground/60">
            {classLabel}
          </span>
          {processedPages} of {summary.pages} pg
          {exclLabel && (
            <span className="text-orange-400/80 ml-1">· {exclLabel} skipped</span>
          )}
          <span className="ml-1 text-foreground/40">
            · T:{formatDuration(summary.textDurationMs)}
            {" "}V:{visualSkipped ? "skip" : formatDuration(summary.imageDurationMs)}
          </span>
        </>
      );
    }

    const subBarWidthPct = Math.max(2, (displayMs / maxMs) * 100);
    const tooltipParts = [
      summary.fileName,
      `${summary.pages} pages`,
      summary.excludedPages > 0 ? `${summary.excludedPages} excluded` : "",
      `Text: ${formatDuration(summary.textDurationMs)}`,
      visualSkipped ? "Visual: skipped" : `Visual: ${formatDuration(summary.imageDurationMs)}`,
    ].filter(Boolean);

    return (
      <div key={fileId} className="flex items-center gap-3 py-0.5" title={tooltipParts.join(" · ")}>
        <div className="w-52 shrink-0 text-xs text-foreground/70 truncate leading-tight pl-1">
          {summary.fileName}
        </div>
        <div className="flex-1 h-3.5 bg-muted/30 rounded overflow-hidden">
          <div
            className="h-full rounded bg-amber-400/70"
            style={{ width: `${subBarWidthPct}%` }}
          />
        </div>
        <div className="w-16 shrink-0 text-right text-xs font-mono text-foreground/60">
          {formatDuration(displayMs)}
        </div>
        <div className="w-72 shrink-0 text-xs text-muted-foreground truncate">
          {detailContent}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {topLevelSteps.map((step) => renderTopLevelRow(step))}
      {total && (
        <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-between">
          <span className="text-sm text-muted-foreground font-display font-semibold uppercase tracking-wide">Total</span>
          <span className="text-base font-bold font-mono text-foreground">{formatDuration(total.durationMs)}</span>
        </div>
      )}
    </div>
  );
}

export default function JobDetails() {
  const [, params] = useRoute("/jobs/:jobId");
  const jobId = params?.jobId || "";
  
  const { data, isLoading, isError, error } = useJobDetails(jobId);
  const extractMutation = useStartExtraction();
  const queryClient = useQueryClient();

  type SignRow = NonNullable<typeof data>["extractedSigns"][number];
  const [reviewSign, setReviewSign] = useState<SignRow | null>(null);

  type SpecViewer = { fileId: string; fileName: string; specPages: number[] } | null;
  const [specViewer, setSpecViewer] = useState<SpecViewer>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const updateJobName = useUpdateJobName(jobId);

  const { toast } = useToast();

  const plaqueScheduleQuery = useGetPlaqueSchedule(jobId);
  const occupantLoadsQuery = useGetOccupantLoads(jobId);
  const extractPlaqueMutation = useExtractPlaqueSchedule();
  const extractOccupantMutation = useExtractOccupantLoads();

  const startNameEdit = (currentName: string) => {
    setNameValue(currentName);
    setEditingName(true);
  };

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  const commitNameEdit = async () => {
    const trimmed = nameValue.trim();
    if (trimmed && data?.job) {
      try {
        await updateJobName(trimmed);
      } catch {
        // silently ignore
      }
    }
    setEditingName(false);
  };

  const handleStartExtraction = () => {
    if (jobId) {
      extractMutation.mutate({ jobId });
    }
  };

  const handleExport = () => {
    if (jobId) {
      downloadExport(jobId)
        .then(({ signCount }) => {
          if (signCount === 0) {
            toast({
              title: "Partial export downloaded",
              description:
                "This export contains plaque/occupant load data only — no sign takeoff rows were found.",
            });
          }
        })
        .catch((err) => console.error("Export failed:", err));
    }
  };

  const [exportingPdf, setExportingPdf] = useState(false);

  const handleExportMarkedPdf = async () => {
    if (!data || exportingPdf) return;
    setExportingPdf(true);
    try {
      const allSigns = data.extractedSigns as unknown as MarkerSign[];
      const markedSigns = allSigns.filter(
        (s) => s.pageNumber != null
      );
      await exportMarkedupPdf(
        jobId,
        data.job.name ?? `Job-${jobId.split("-")[0]}`,
        data.files,
        markedSigns
      );
      apiFetch(`/api/jobs/${jobId}/log-pdf-export`, { method: "POST" }).catch(() => {});
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("Failed to export marked-up PDF. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  };

  const [showHidden, setShowHidden] = useState(false);
  const [showExceptions, setShowExceptions] = useState(false);
  const [signsUnlockingAll, setSignsUnlockingAll] = useState(false);
  const [showSignsConfirm, setShowSignsConfirm] = useState(false);
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [summaryFilter, setSummaryFilter] = useState<null | "flagged">(null);
  const [activeTab, setActiveTab] = useState<"table" | "sheets" | "summary" | "floorplans" | "signpages" | "specs" | "timeline" | "coords" | "ai_scans" | "compliance" | "plaque_schedule" | "occupant_loads">("table");
  const [showAiHighlight, setShowAiHighlight] = useState(false);
  const [unlockingSignId, setUnlockingSignId] = useState<string | null>(null);

  const PROCESSING_TIMEOUT_SECONDS = 5 * 60;
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const isProcessingNow = (data?.job?.status === "processing") || extractMutation.isPending;
  useEffect(() => {
    if (!isProcessingNow) { setProcessingSeconds(0); return; }
    const id = setInterval(() => setProcessingSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isProcessingNow]);

  const isJobCompleted = data?.job?.status === "completed";
  const supplementalDataLoading =
    isJobCompleted &&
    (plaqueScheduleQuery.isLoading || occupantLoadsQuery.isLoading);
  const hasNoMapData =
    isProcessingNow ||
    (isJobCompleted &&
    (data?.extractedSigns ?? []).filter((s: { pageNumber?: number | null }) => s.pageNumber != null).length === 0);

  const exportButtonState = useExportButtonState({
    extractedSigns: data?.extractedSigns ?? [],
    plaqueCount: plaqueScheduleQuery.data?.plaques?.length ?? 0,
    loadsCount: occupantLoadsQuery.data?.loads?.length ?? 0,
    assemblyRoomsCount: occupantLoadsQuery.data?.assemblyRooms?.length ?? 0,
    isProcessingNow,
    supplementalDataLoading,
    exportingPdf,
    hasNoMapData,
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const toggleHidden = async (signId: string, currentlyHidden: boolean) => {
    const next = !currentlyHidden;
    // Optimistic update: move sign between extractedSigns and hiddenSigns
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      const castOld = old as typeof old & { hiddenSigns?: typeof old.extractedSigns };
      const allVisible = castOld.extractedSigns ?? [];
      const allHidden = castOld.hiddenSigns ?? [];
      if (next) {
        // Hiding: move from visible → hidden
        const sign = allVisible.find((s) => s.id === signId);
        return {
          ...old,
          extractedSigns: allVisible.filter((s) => s.id !== signId),
          hiddenSigns: sign ? [...allHidden, { ...sign, hidden: true }] : allHidden,
          totalSigns: Math.max(0, (old.totalSigns ?? 0) - 1),
        };
      } else {
        // Restoring: move from hidden → visible
        const sign = allHidden.find((s) => s.id === signId);
        return {
          ...old,
          extractedSigns: sign ? [...allVisible, { ...sign, hidden: false }] : allVisible,
          hiddenSigns: allHidden.filter((s) => s.id !== signId),
          totalSigns: (old.totalSigns ?? 0) + 1,
        };
      }
    });
    // Persist to server; revert optimistic update on any failure
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      if (!res.ok) {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    } catch {
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    }
  };

  const handleUnlockSign = async (signId: string): Promise<boolean> => {
    setUnlockingSignId(signId);
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manuallyEdited: false }),
      });
      if (res.ok) {
        queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
          if (!old) return old;
          const extractedSigns = (old.extractedSigns ?? []).map((s) =>
            s.id === signId ? { ...s, manuallyEdited: false } : s
          );
          return { ...old, extractedSigns };
        });
        return true;
      } else {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        return false;
      }
    } catch {
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      return false;
    } finally {
      setUnlockingSignId(null);
    }
  };

  const handleUnlockAllSigns = async () => {
    setSignsUnlockingAll(true);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/signs/unlock-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const responseData = await res.json();
      if (!res.ok) {
        toast({ title: "Unlock failed", description: responseData.error ?? "Failed to unlock all sign rows.", variant: "destructive" });
        return;
      }
      const unlockedSigns = responseData.signs as Array<{ id: string; manuallyEdited: boolean }>;
      queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
        if (!old) return old;
        return {
          ...old,
          extractedSigns: old.extractedSigns.map((s) => {
            const updated = unlockedSigns.find((u) => u.id === s.id);
            return updated ? { ...s, manuallyEdited: updated.manuallyEdited } : s;
          }),
        };
      });
    } catch {
      toast({ title: "Unlock failed", description: "Failed to unlock all sign rows.", variant: "destructive" });
    } finally {
      setSignsUnlockingAll(false);
    }
  };

  const toggleRejectedPage = async (fileId: string, pageNo: number) => {
    // Optimistically add the page to rejectedPageNumbers immediately.
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      type FileWithPageStats = (typeof old.files)[number] & { pageStats?: { floorPlanPages: number[]; signSchedulePages: number[]; otherPages: number[]; rejectedPageNumbers?: number[] } | null };
      const files = (old.files as FileWithPageStats[]).map((f) => {
        if (f.id !== fileId) return f;
        const stats = f.pageStats ?? { floorPlanPages: [], signSchedulePages: [], otherPages: [] };
        const existing = stats.rejectedPageNumbers ?? [];
        const updatedRejectedPageNumbers = existing.includes(pageNo)
          ? existing.filter((p) => p !== pageNo)
          : [...existing, pageNo];
        return { ...f, pageStats: { ...stats, rejectedPageNumbers: updatedRejectedPageNumbers } };
      });
      return { ...old, files: files as typeof old.files };
    });
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/files/${fileId}/rejected-pages`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNo }),
      });
      if (!res.ok) {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      } else {
        // Signs for this page were deleted on the server — refresh the signs list.
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    } catch {
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    }
  };

  const handleSignSaved = (updatedSign: SignMarker) => {
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      return {
        ...old,
        extractedSigns: old.extractedSigns.map((s) =>
          s.id === updatedSign.id ? { ...s, ...updatedSign } : s
        ),
      };
    });
    setReviewSign(null);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSignAdded = (newSign: any) => {
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      return {
        ...old,
        extractedSigns: [...old.extractedSigns, newSign as SignRow],
        totalSigns: (old.totalSigns ?? 0) + 1,
      };
    });
  };

  const handleSignDeleted = (signId: string) => {
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      const newSigns = old.extractedSigns.filter((s) => s.id !== signId);
      return {
        ...old,
        extractedSigns: newSigns,
        totalSigns: newSigns.length,
      };
    });
  };

  const handleSignUpdated = (signId: string, xPos: number, yPos: number) => {
    queryClient.setQueryData(getGetJobQueryKey(jobId), (old: typeof data) => {
      if (!old) return old;
      const patch = { xPos, yPos, placementSource: "manual" };
      return {
        ...old,
        extractedSigns: old.extractedSigns.map((s) =>
          s.id === signId ? { ...s, ...patch } : s
        ),
      };
    });
  };

  if (isLoading && !data) {
    return (
      <AppShell>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div className="p-8 text-destructive">
          Error loading job: {error?.message || "Unknown error"}
        </div>
      </AppShell>
    );
  }

  const { job, files, totalSigns, flaggedCount, highConfidenceCount, plaqueCount, occupantLoadCount } = data;
  const dataAny = data as typeof data & {
    lastScan?: { at: string; userName: string; userInitials: string } | null;
    lastEdit?: { at: string; userName: string; userInitials: string } | null;
  };
  const lastScan = dataAny.lastScan ?? null;
  const lastEdit = dataAny.lastEdit ?? null;

  // Show all signs: text, manual, and image-only (visual-only finds).
  // Paired image signs are excluded by the API (their data is in the paired text row).
  const extractedSigns = data.extractedSigns;
  const hiddenSigns = (data as typeof data & { hiddenSigns?: typeof data.extractedSigns }).hiddenSigns ?? [];
  const exceptionSigns = extractedSigns.filter((s) => s.reviewFlag && s.exceptionReason);
  const manuallyEditedSignsCount = extractedSigns.filter((s) => (s as Record<string, unknown>).manuallyEdited).length;

  // Unplaced-sign counts used by both the PDF button badge and the canvas banner.
  const _placedCount = extractedSigns.filter((s) => s.pageNumber != null).length;
  const unplacedCount = extractedSigns.length - _placedCount;
  const noneArePlaced = extractedSigns.length > 0 && _placedCount === 0;
  const someAreUnplaced = extractedSigns.length > 0 && unplacedCount > 0 && _placedCount > 0;
  const showUnplacedWarning = !isProcessingNow && (noneArePlaced || someAreUnplaced);

  // Derive a source sort key matching the SourceBadge priority order
  function sourceKey(s: typeof extractedSigns[number]): string {
    const r = s as Record<string, unknown>;
    if (r.manuallyAdded) return "0_manual";
    if (r.extractionMethod === "text" && r.pairedSignId) return "1_both";
    if (r.extractionMethod === "image" && !r.pairedSignId) return "2_visual";
    return "3_text";
  }

  const filteredSigns = summaryFilter === "flagged"
    ? extractedSigns.filter((s) => (s as Record<string, unknown>).reviewFlag === true)
    : extractedSigns;

  const sortedSigns = sortField
    ? [...filteredSigns].sort((a, b) => {
        let av: string | number = "";
        let bv: string | number = "";
        const ar = a as Record<string, unknown>;
        const br = b as Record<string, unknown>;
        switch (sortField) {
          case "code":
            av = (ar.signIdentifier as string) ?? "";
            bv = (br.signIdentifier as string) ?? "";
            break;
          case "codeText": {
            const aId = (ar.signIdentifier as string) ?? "";
            const aLoc = (ar.location as string) ?? "";
            av = [aId, aLoc].filter(Boolean).join(" ");
            const bId = (br.signIdentifier as string) ?? "";
            const bLoc = (br.location as string) ?? "";
            bv = [bId, bLoc].filter(Boolean).join(" ");
            break;
          }
          case "signType":   av = (ar.signType as string) ?? ""; bv = (br.signType as string) ?? ""; break;
          case "quantity":   av = (ar.quantity as number) ?? 0;  bv = (br.quantity as number) ?? 0;  break;
          case "location":   av = (ar.location as string) ?? ""; bv = (br.location as string) ?? ""; break;
          case "dimensions": av = (ar.dimensions as string) ?? ""; bv = (br.dimensions as string) ?? ""; break;
          case "mounting":   av = (ar.mountingType as string) ?? ""; bv = (br.mountingType as string) ?? ""; break;
          case "finish":     av = (ar.finishColor as string) ?? ""; bv = (br.finishColor as string) ?? ""; break;
          case "message":    av = (ar.messageContent as string) ?? ""; bv = (br.messageContent as string) ?? ""; break;
          case "confidence": av = (ar.confidenceScore as number) ?? 0;  bv = (br.confidenceScore as number) ?? 0;  break;
          case "source":     av = sourceKey(a); bv = sourceKey(b); break;
        }
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filteredSigns;
  const displaySigns = showExceptions
    ? sortedSigns.filter((s) => s.reviewFlag && s.exceptionReason)
    : sortedSigns;
  const isProcessing = job.status === "processing" || extractMutation.isPending;
  const isCompleted = job.status === "completed";
  const isPending = job.status === "pending";
  const isFailed = job.status === "failed";

  return (
    <AppShell>
      <div className="flex flex-col h-screen overflow-hidden">
        {/* Header Area */}
        <header className="flex-none p-6 border-b border-border bg-background">
          <div className="flex items-start justify-between max-w-7xl mx-auto w-full gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 mb-2">
                {editingName ? (
                  <input
                    ref={nameInputRef}
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onBlur={commitNameEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitNameEdit();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    className="text-2xl font-display text-foreground leading-none bg-secondary border border-primary/50 rounded px-2 py-0.5 outline-none focus:border-primary min-w-0 w-full max-w-md"
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={() => startNameEdit(job.name ?? job.id.split('-')[0])}
                    className="group flex items-center gap-2 text-left"
                    title="Click to rename"
                  >
                    <h1 className="text-2xl font-display text-foreground leading-none truncate">
                      {job.name ? (
                        <span className="text-primary">{job.name}</span>
                      ) : (
                        <>Job <span className="text-primary">{job.id.split('-')[0]}</span></>
                      )}
                    </h1>
                    <Pencil className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </button>
                )}
                <StatusBadge status={job.status} />
              </div>
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1">
                <p className="text-sm text-muted-foreground font-mono">
                  {job.name && <span className="text-muted-foreground/50 mr-2">{job.id.split('-')[0]}</span>}
                  Created {format(new Date(job.createdAt), "PP pp")} • {files.length} file(s)
                </p>
                {(job.projectAddress || job.projectCity || job.projectState) && (
                  <span className="flex items-center gap-1 text-sm text-accent font-mono">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                    {[job.projectAddress, job.projectCity, job.projectState].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
              {(lastScan || lastEdit) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                  {lastScan && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Zap className="w-3 h-3 text-primary/70 flex-shrink-0" />
                      Last scanned by{" "}
                      <span
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[9px] font-bold flex-shrink-0"
                        title={lastScan.userName}
                      >
                        {lastScan.userInitials}
                      </span>
                      <span className="font-medium text-foreground/70">{lastScan.userName}</span>
                      {" — "}{formatDistanceToNow(new Date(lastScan.at), { addSuffix: true })}
                    </span>
                  )}
                  {lastEdit && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <PenLine className="w-3 h-3 text-accent/70 flex-shrink-0" />
                      Last edited by{" "}
                      <span
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/15 text-accent text-[9px] font-bold flex-shrink-0"
                        title={lastEdit.userName}
                      >
                        {lastEdit.userInitials}
                      </span>
                      <span className="font-medium text-foreground/70">{lastEdit.userName}</span>
                      {" — "}{formatDistanceToNow(new Date(lastEdit.at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              )}
              
              {isFailed && job.error && (
                <div className="mt-3 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded border border-destructive/20 inline-block">
                  <span className="font-semibold">Error:</span> {job.error}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {isPending && (
                <Button
                  onClick={handleStartExtraction}
                  disabled={extractMutation.isPending}
                  className="font-display font-semibold uppercase tracking-wide shadow-[0_0_15px_rgba(255,170,0,0.1)]"
                >
                  {extractMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 fill-current" />
                  )}
                  Start Extraction
                </Button>
              )}

              {isCompleted && (
                <>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={handleStartExtraction}
                          disabled={extractMutation.isPending}
                          variant="outline"
                          className="font-display font-semibold uppercase tracking-wide hover:bg-primary/10 hover:text-primary hover:border-primary/40"
                        >
                          {extractMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                          Re-Scan
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Re-run both text and visual scans to refresh sign data</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="relative inline-flex">
                          <Button
                            onClick={handleExportMarkedPdf}
                            disabled={exportButtonState.pdf.disabled}
                            variant="outline"
                            className="font-display font-semibold uppercase tracking-wide hover:bg-primary/10 hover:text-primary hover:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                          >
                            {exportingPdf ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Stamp className="w-4 h-4" />
                            )}
                            {exportingPdf ? "Building PDF…" : "Export Marked PDF"}
                          </Button>
                          {exportButtonState.pdf.showBadge && (
                            <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-yellow-400 text-[9px] font-bold text-yellow-900 shadow">
                              !
                            </span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{exportButtonState.pdf.tooltip}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="relative inline-flex">
                          <Button
                            onClick={handleExport}
                            disabled={exportButtonState.xlsx.disabled}
                            className="font-display font-semibold uppercase tracking-wide bg-accent text-accent-foreground hover:bg-accent/90 shadow-[0_0_15px_rgba(0,240,255,0.15)] disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                          >
                            <Download className="w-4 h-4" />
                            Export XLSX
                          </Button>
                          {exportButtonState.xlsx.showBadge && (
                            <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-yellow-400 text-[9px] font-bold text-yellow-900 shadow">
                              !
                            </span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{exportButtonState.xlsx.tooltip}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden flex flex-col bg-background">
          {isProcessing ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
              <div className="relative w-24 h-24 mb-8">
                <div className="absolute inset-0 border-4 border-secondary rounded-full"></div>
                <div className="absolute inset-0 border-4 border-primary rounded-full border-t-transparent animate-spin"></div>
                <Cpu className="absolute inset-0 m-auto w-8 h-8 text-primary animate-pulse" />
              </div>
              <h2 className="text-xl font-display text-foreground mb-2">Analyzing Plan Documents...</h2>
              <p className="text-muted-foreground font-mono text-sm max-w-md mx-auto leading-relaxed">
                Running text and visual scans in parallel. Gemini AI is reading plan text, identifying sign schedules, and visually scanning floor plans. Large files may take 3–6 minutes.
              </p>

              <div className="mt-2 text-xs text-muted-foreground/60 font-mono tabular-nums">
                {Math.floor(processingSeconds / 60)}:{String(processingSeconds % 60).padStart(2, "0")} elapsed
              </div>
              
              <div className="mt-4 w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-primary w-1/2 animate-[progress_2s_ease-in-out_infinite_alternate]" style={{ transformOrigin: 'left' }}></div>
              </div>

              {processingSeconds >= PROCESSING_TIMEOUT_SECONDS && (
                <div className="mt-8 flex flex-col items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    This is taking longer than expected. You can try restarting the extraction.
                  </p>
                  <button
                    onClick={handleStartExtraction}
                    disabled={extractMutation.isPending}
                    className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary/10 border border-primary/30 text-primary text-sm font-medium hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Retry Extraction
                  </button>
                </div>
              )}
            </div>
          ) : (isCompleted || isFailed) ? (
            <div className="flex flex-col h-full">
              <div className="flex-none px-4 pt-3 pb-2 max-w-7xl mx-auto w-full grid grid-cols-2 md:grid-cols-3 gap-3">
                <SummaryCard 
                  title="Total Signs Extracted" 
                  value={totalSigns} 
                  icon={<ListFilter className="w-4 h-4 text-muted-foreground" />}
                  onClick={() => setSummaryFilter(null)}
                  isActive={summaryFilter === null}
                />
                <SummaryCard 
                  title="High Confidence" 
                  value={highConfidenceCount} 
                  icon={<CheckCircle2 className="w-4 h-4 text-accent" />} 
                  accent="accent"
                />
                <SummaryCard 
                  title="Needs Review" 
                  value={flaggedCount} 
                  icon={<AlertTriangle className="w-4 h-4 text-primary" />} 
                  accent="primary"
                  onClick={() => setSummaryFilter("flagged")}
                  isActive={summaryFilter === "flagged"}
                />
                <SummaryCard
                  title="Plaque Items"
                  value={plaqueCount ?? 0}
                  icon={<Stamp className="w-4 h-4 text-muted-foreground" />}
                  onClick={() => setActiveTab("plaque_schedule")}
                />
                <SummaryCard
                  title="Occupant Load Entries"
                  value={occupantLoadCount ?? 0}
                  icon={<Users className="w-4 h-4 text-muted-foreground" />}
                  onClick={() => setActiveTab("occupant_loads")}
                />
                <CostCard 
                  inputTokens={(data as Record<string, unknown> & { processingCost?: { inputTokens?: number } }).processingCost?.inputTokens ?? (job.inputTokens ?? 0)}
                  outputTokens={(data as Record<string, unknown> & { processingCost?: { outputTokens?: number } }).processingCost?.outputTokens ?? (job.outputTokens ?? 0)}
                />
              </div>
              
              {/* View tabs */}
              <div className="flex-none flex items-center border-b border-border bg-secondary/20">
                <div className="flex items-center px-4 gap-0">
                  <button
                    onClick={() => setActiveTab("table")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "table"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <ListFilter className="w-3.5 h-3.5" />
                    Sign Table
                  </button>
                  <button
                    onClick={() => setActiveTab("sheets")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "sheets"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    Sheets Analysis
                  </button>
                  <button
                    onClick={() => setActiveTab("summary")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "summary"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <BarChart2 className="w-3.5 h-3.5" />
                    Sign Type Summary
                  </button>
                  <button
                    onClick={() => setActiveTab("floorplans")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "floorplans"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    Floor Plans
                  </button>
                  <button
                    onClick={() => setActiveTab("signpages")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "signpages"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Sign Pages
                  </button>
                  <button
                    onClick={() => setActiveTab("specs")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "specs"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Sign Specs
                  </button>
                  <button
                    onClick={() => setActiveTab("timeline")}
                    className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                      activeTab === "timeline"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    Timeline
                  </button>
                  {(isCompleted || isFailed) && (
                    <button
                      onClick={() => setActiveTab("coords")}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                        activeTab === "coords"
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      Coordinates
                    </button>
                  )}
                  {(isCompleted || isFailed) && (
                    <button
                      onClick={() => setActiveTab("ai_scans")}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                        activeTab === "ai_scans"
                          ? "border-violet-500 text-violet-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Brain className="w-3.5 h-3.5" />
                      AI Scans
                    </button>
                  )}
                  {(isCompleted || isFailed) && (
                    <button
                      onClick={() => setActiveTab("compliance")}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                        activeTab === "compliance"
                          ? "border-emerald-500 text-emerald-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Compliance
                    </button>
                  )}
                  {(isCompleted || isFailed) && (
                    <button
                      onClick={() => setActiveTab("plaque_schedule")}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                        activeTab === "plaque_schedule"
                          ? "border-indigo-500 text-indigo-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Stamp className="w-3.5 h-3.5" />
                      Plaque Schedule
                      {plaqueScheduleQuery.data && plaqueScheduleQuery.data.plaques.length > 0 && (
                        <span className="ml-1 bg-indigo-500/20 text-indigo-400 rounded px-1 text-[9px] font-mono">
                          {plaqueScheduleQuery.data.plaques.length}
                        </span>
                      )}
                    </button>
                  )}
                  {(isCompleted || isFailed) && (
                    <button
                      onClick={() => setActiveTab("occupant_loads")}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider border-b-2 transition-all ${
                        activeTab === "occupant_loads"
                          ? "border-orange-500 text-orange-400"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" />
                      Occupant Loads
                      {occupantLoadsQuery.data && occupantLoadsQuery.data.assemblyRooms.length > 0 && (
                        <span className="ml-1 bg-orange-500/20 text-orange-400 rounded px-1 text-[9px] font-mono">
                          {occupantLoadsQuery.data.assemblyRooms.length} asm
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {activeTab === "floorplans" ? (
                <div className="flex-1 min-h-0 flex flex-col">
                  {showUnplacedWarning && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-300 text-xs shrink-0">
                      <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                      <span className="flex-1">
                        {noneArePlaced
                          ? `${extractedSigns.length} sign${extractedSigns.length !== 1 ? "s" : ""} have no floor plan location — the exported PDF will have no markers.`
                          : `${unplacedCount} of ${extractedSigns.length} sign${extractedSigns.length !== 1 ? "s" : ""} ${unplacedCount !== 1 ? "are" : "is"} not placed on the floor plan and will be missing from the PDF.`}
                      </span>
                      <button
                        onClick={() => {
                          const firstUnplaced = document.querySelector<HTMLElement>("[data-unplaced='true']");
                          if (firstUnplaced) {
                            firstUnplaced.scrollIntoView({ behavior: "smooth", block: "center" });
                            firstUnplaced.classList.add("ring-2", "ring-yellow-400", "ring-inset");
                            setTimeout(() => firstUnplaced.classList.remove("ring-2", "ring-yellow-400", "ring-inset"), 2000);
                          }
                        }}
                        className="whitespace-nowrap underline underline-offset-2 hover:text-yellow-200 transition-colors"
                      >
                        Show unplaced signs
                      </button>
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    <UnifiedPlanViewer
                      mode="tab"
                      jobId={jobId}
                      files={files}
                      signs={extractedSigns}
                      showAiHighlight={showAiHighlight}
                      onSignAdded={handleSignAdded}
                      onSignUpdated={handleSignUpdated}
                      onEditSign={(s) => setReviewSign(s as SignRow)}
                    />
                  </div>
                </div>
              ) : activeTab === "signpages" ? (
                <div className="flex-1 min-h-0">
                  <UnifiedPlanViewer
                    mode="tab"
                    jobId={jobId}
                    files={files}
                    signs={[]}
                    showMarkers={false}
                    pageType="sign_schedule"
                  />
                </div>
              ) : activeTab === "specs" ? (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  <SignSpecsTab
                    signs={extractedSigns}
                    files={files}
                    jobId={jobId}
                  />
                </div>
              ) : activeTab === "sheets" ? (
                <SheetsPanel
                  files={files}
                  onOpenSpec={setSpecViewer}
                  allSigns={extractedSigns}
                  hiddenSigns={hiddenSigns}
                  toggleHidden={toggleHidden}
                  jobId={jobId}
                  toggleRejectedPage={toggleRejectedPage}
                />
              ) : activeTab === "timeline" ? (
                <div className="flex-1 overflow-auto p-8">
                  <div className="max-w-4xl mx-auto">
                    <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-6">
                      Processing Timeline
                    </div>
                    {(() => {
                      const jobLog = (job as Record<string, unknown>).processingLog as ProcessingStep[] | null | undefined;
                      return jobLog && jobLog.length > 0 ? (
                        <ProcessingTimeline steps={jobLog} />
                      ) : (
                        <p className="text-sm text-muted-foreground">No processing log available for this job.</p>
                      );
                    })()}
                  </div>
                </div>
              ) : activeTab === "summary" ? (
                <SignSummaryPanel signs={extractedSigns} />
              ) : activeTab === "coords" ? (
                <div className="flex-1 overflow-auto bg-card border-t border-border">
                  <CoordinatesTable signs={extractedSigns} showAiHighlight={showAiHighlight} onView={(sign) => setReviewSign(sign as SignRow)} />
                </div>
              ) : activeTab === "ai_scans" ? (
                <div className="flex-1 overflow-auto bg-card border-t border-border">
                  <AiScansTab
                    jobId={jobId}
                    showAiHighlight={showAiHighlight}
                    onToggleAiHighlight={() => setShowAiHighlight((v) => !v)}
                    onScansComplete={() => {
                      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                    }}
                  />
                </div>
              ) : activeTab === "compliance" ? (
                <div className="flex-1 flex flex-col min-h-0 bg-card border-t border-border overflow-hidden">
                  <ComplianceTab jobId={jobId} />
                </div>
              ) : activeTab === "plaque_schedule" ? (
                <div className="flex-1 overflow-auto bg-card border-t border-border">
                  <PlaqueScheduleTab
                    jobId={jobId}
                    plaques={plaqueScheduleQuery.data?.plaques ?? []}
                    isLoading={plaqueScheduleQuery.isLoading}
                    isExtracting={extractPlaqueMutation.isPending}
                    onExtract={() => extractPlaqueMutation.mutate({ jobId }, {
                      onSuccess: () => {
                        plaqueScheduleQuery.refetch();
                        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                      },
                    })}
                  />
                </div>
              ) : activeTab === "occupant_loads" ? (
                <div className="flex-1 overflow-auto bg-card border-t border-border">
                  <OccupantLoadsTab
                    jobId={jobId}
                    loads={occupantLoadsQuery.data?.loads ?? []}
                    assemblyRooms={occupantLoadsQuery.data?.assemblyRooms ?? []}
                    isLoading={occupantLoadsQuery.isLoading}
                    isExtracting={extractOccupantMutation.isPending}
                    onExtract={() => extractOccupantMutation.mutate({ jobId }, {
                      onSuccess: () => {
                        occupantLoadsQuery.refetch();
                        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                      },
                    })}
                  />
                </div>
              ) : (
                <>
                  {/* Data Table Container */}
                  <div className="flex-1 overflow-auto bg-card border-t border-border">
                {/* Filter bar — exceptions toggle + hidden toggle + unlock all */}
                {(hiddenSigns.length > 0 || exceptionSigns.length > 0 || manuallyEditedSignsCount > 0) && (
                  <div className="flex items-center gap-3 px-4 py-2 bg-secondary/60 border-b border-border/60">
                    {exceptionSigns.length > 0 && (
                      <button
                        onClick={() => setShowExceptions((v) => !v)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all ${
                          showExceptions
                            ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
                            : "bg-secondary text-muted-foreground border-border hover:text-amber-600 hover:border-amber-500/40"
                        }`}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {showExceptions ? "Show all signs" : `Exceptions (${exceptionSigns.length})`}
                      </button>
                    )}
                    {hiddenSigns.length > 0 && (
                      <button
                        onClick={() => setShowHidden((v) => !v)}
                        className={`flex items-center gap-2 px-3 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all ${
                          showHidden
                            ? "bg-muted-foreground/10 text-muted-foreground border-border/80"
                            : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80"
                        }`}
                      >
                        {showHidden ? (
                          <Eye className="w-3 h-3" />
                        ) : (
                          <EyeOff className="w-3 h-3" />
                        )}
                        {showHidden ? "Hide hidden rows" : `Show hidden (${hiddenSigns.length})`}
                      </button>
                    )}
                    {hiddenSigns.length > 0 && (
                      <span className="text-[10px] text-muted-foreground/50 font-mono">
                        {hiddenSigns.length} sign{hiddenSigns.length !== 1 ? "s" : ""} hidden from table and export
                      </span>
                    )}
                    {manuallyEditedSignsCount > 0 && (
                      showSignsConfirm ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-amber-400 whitespace-nowrap">Unlock all ({manuallyEditedSignsCount}) rows?</span>
                          <button
                            onClick={() => { setShowSignsConfirm(false); handleUnlockAllSigns(); }}
                            className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-white bg-amber-500 hover:bg-amber-400 transition-colors border border-amber-400/30"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setShowSignsConfirm(false)}
                            className="flex items-center justify-center px-2 py-1 rounded text-[11px] font-medium text-muted-foreground bg-secondary hover:text-foreground transition-colors border border-border"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowSignsConfirm(true)}
                          disabled={signsUnlockingAll}
                          className="flex items-center gap-2 px-3 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all bg-secondary text-muted-foreground border-border hover:text-amber-600 hover:border-amber-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {signsUnlockingAll ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3" />
                          )}
                          Unlock all ({manuallyEditedSignsCount})
                        </button>
                      )
                    )}
                  </div>
                )}

                <div className="min-w-[max-content] inline-block align-top">
                  <table className="w-full text-left border-collapse border-spacing-0">
                    <thead>
                      <tr>
                        <SortableHeader field="code"     label="Sign ID"       sortField={sortField} sortDir={sortDir} onSort={handleSort} className="sticky left-0 z-30 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]" />
                        <SortableHeader field="location"   label="Location"      sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="signType"   label="Sign Type"     sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="quantity"   label="Qty"           sortField={sortField} sortDir={sortDir} onSort={handleSort} className="w-16 text-center" />
                        <SortableHeader field="dimensions" label="Dimensions"    sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="mounting"   label="Mounting"      sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="finish"     label="Finish / Color" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="message"    label="Message"       sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                        <SortableHeader field="confidence" label="Confidence"    sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-center" />
                        <SortableHeader field="source"     label="Source"        sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-center" />
                        <th className="data-header text-center">Status</th>
                        <th className="data-header text-center w-24">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-background">
                      {displaySigns.map((sign, idx) => {
                        const isAiRow = showAiHighlight && ((sign as Record<string, unknown>).dataSource === "ai" || (sign as Record<string, unknown>).aiBbox === true);
                        return (
                        <tr 
                          key={sign.id}
                          data-sign-id={sign.id}
                          data-unplaced={sign.pageNumber == null ? "true" : undefined}
                          className={`
                            hover:bg-secondary/40 transition-colors
                            ${sign.reviewFlag ? 'bg-primary/5' : ''}
                            ${idx % 2 === 0 ? '' : 'bg-card/30'}
                            ${isAiRow ? 'border-l-2 border-violet-500' : ''}
                          `}
                          style={isAiRow ? { boxShadow: 'inset 3px 0 0 rgba(139, 92, 246, 0.6)', background: 'rgba(139, 92, 246, 0.04)' } : undefined}
                        >
                          <td className="data-cell sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                            <span className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold text-foreground">
                                {sign.signIdentifier || '—'}
                              </span>
                              {sign.manuallyEdited && (
                                <span
                                  title="Manually locked — this row will not be overwritten by AI re-runs"
                                  className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 cursor-default"
                                >
                                  <Lock className="w-2.5 h-2.5" />
                                  locked
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="data-cell truncate max-w-[200px]" title={sign.location || ''}>{sign.location || '—'}</td>
                          <td className="data-cell text-foreground">{sign.signType || '—'}</td>
                          <td className="data-cell text-center font-mono font-medium">{sign.quantity || 1}</td>
                          <td className="data-cell font-mono text-xs">{sign.dimensions || '—'}</td>
                          <td className="data-cell">{sign.mountingType || '—'}</td>
                          <td className="data-cell text-xs">{sign.finishColor || '—'}</td>
                          <td className="data-cell truncate max-w-[250px]" title={sign.messageContent || ''}>{sign.messageContent || '—'}</td>
                          <td className="data-cell text-center">
                            <ConfidenceBadge score={sign.confidenceScore} />
                          </td>
                          <td className="data-cell text-center">
                            <SourceBadge sign={sign as Record<string, unknown>} />
                          </td>
                          <td className="data-cell text-center">
                            <div className="flex flex-col gap-1 items-center">
                              {sign.pageNumber == null && (
                                <span
                                  title="This sign has not been placed on a floor plan yet"
                                  className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-yellow-500/10 text-yellow-500 border border-yellow-500/25 cursor-default"
                                >
                                  <MapPin className="w-3 h-3 mr-1" />
                                  Unplaced
                                </span>
                              )}
                              {sign.userVerified && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider" style={{ background: "#22c55e15", color: "#22c55e", border: "1px solid #22c55e44" }}>
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                  Verified
                                </span>
                              )}
                              {sign.reviewFlag && !sign.exceptionReason && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary/20 text-primary border border-primary/30">
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  Flag
                                </span>
                              )}
                              {sign.exceptionReason && (
                                <span
                                  title={`Exception: ${sign.exceptionReason}`}
                                  className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-600 border border-amber-500/30 cursor-help"
                                >
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  Exception
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="data-cell text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => setReviewSign(sign)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide bg-secondary hover:bg-primary/20 hover:text-primary border border-border hover:border-primary/40 text-muted-foreground transition-all"
                              >
                                <Pencil className="w-3 h-3" />
                                Edit
                              </button>
                              {sign.manuallyEdited && (
                                <button
                                  onClick={() => handleUnlockSign(sign.id)}
                                  disabled={unlockingSignId !== null}
                                  title="Unlock row — allow AI to update again"
                                  aria-label="Unlock row"
                                  className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-secondary hover:bg-emerald-500/10 hover:text-emerald-400 border border-border text-amber-400 transition-all disabled:opacity-40"
                                >
                                  {unlockingSignId === sign.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => toggleHidden(sign.id, false)}
                                title="Hide this row"
                                className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-secondary hover:bg-muted-foreground/20 hover:text-foreground border border-border text-muted-foreground/50 transition-all"
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                      })}

                      {/* Hidden rows — shown only when "Show hidden" is toggled on */}
                      {showHidden && hiddenSigns.map((sign) => (
                        <tr
                          key={sign.id}
                          className="opacity-40 bg-muted/30 hover:opacity-60 transition-opacity"
                        >
                          <td className="data-cell sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold text-muted-foreground line-through">
                                {sign.signIdentifier || '—'}
                              </span>
                              {sign.manuallyEdited && (
                                <span
                                  title="Manually locked — this row will not be overwritten by AI re-runs"
                                  className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 cursor-default"
                                >
                                  <Lock className="w-2.5 h-2.5" />
                                  locked
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="data-cell truncate max-w-[200px] text-muted-foreground line-through">{sign.location || '—'}</td>
                          <td className="data-cell text-muted-foreground line-through">{sign.signType || '—'}</td>
                          <td className="data-cell text-center font-mono font-medium text-muted-foreground line-through">{sign.quantity || 1}</td>
                          <td className="data-cell font-mono text-xs text-muted-foreground">{sign.dimensions || '—'}</td>
                          <td className="data-cell text-muted-foreground">{sign.mountingType || '—'}</td>
                          <td className="data-cell text-xs text-muted-foreground">{sign.finishColor || '—'}</td>
                          <td className="data-cell truncate max-w-[250px] text-muted-foreground">{sign.messageContent || '—'}</td>
                          <td className="data-cell text-center">
                            <ConfidenceBadge score={sign.confidenceScore} />
                          </td>
                          <td className="data-cell text-center">
                            <SourceBadge sign={sign as Record<string, unknown>} />
                          </td>
                          <td className="data-cell text-center">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-muted/50 text-muted-foreground border border-border/50">
                              <EyeOff className="w-3 h-3 mr-1" />
                              Hidden
                            </span>
                          </td>
                          <td className="data-cell text-center">
                            <button
                              onClick={() => toggleHidden(sign.id, true)}
                              title="Restore this row"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide bg-secondary hover:bg-accent/20 hover:text-accent border border-border hover:border-accent/40 text-muted-foreground transition-all"
                            >
                              <Eye className="w-3 h-3" />
                              Restore
                            </button>
                          </td>
                        </tr>
                      ))}

                      {extractedSigns.length === 0 && hiddenSigns.length === 0 && (
                        <tr>
                          <td colSpan={12} className="p-8 text-center text-muted-foreground">
                            No signs were extracted from these documents.
                          </td>
                        </tr>
                      )}
                      {extractedSigns.length === 0 && hiddenSigns.length > 0 && !showHidden && (
                        <tr>
                          <td colSpan={12} className="p-8 text-center text-muted-foreground">
                            All signs are hidden. Click "Show hidden ({hiddenSigns.length})" above to view them.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 p-8 max-w-3xl mx-auto w-full">
              <h3 className="font-display font-medium text-lg mb-4 text-foreground">Uploaded Files</h3>
              <div className="grid gap-3">
                {files.map(f => (
                  <div key={f.id} className="flex items-center p-4 bg-card border border-border rounded-lg">
                    <FileText className="w-5 h-5 text-muted-foreground mr-4" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{f.originalName}</p>
                    </div>
                    <button
                      onClick={() => openPdfInNewTab(jobId, f.id, f.originalName).catch(() => {})}
                      title="Open original PDF in new tab"
                      className="ml-3 flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-muted-foreground border border-border hover:text-primary hover:border-primary/50 transition-colors flex-shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View PDF
                    </button>
                  </div>
                ))}
              </div>
              
              <div className="mt-8 p-6 bg-secondary rounded-lg border border-border">
                <h4 className="font-medium text-foreground mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-primary" /> Ready for processing
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Click the "Start Extraction" button above to send these files to the AI engine. 
                  The system will read the text, locate sign schedules, and extract structured data.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {reviewSign && (
        <UnifiedPlanViewer
          mode="modal"
          jobId={jobId}
          files={files}
          allSigns={extractedSigns}
          initialSignId={reviewSign.id}
          onClose={() => setReviewSign(null)}
          onSaved={handleSignSaved}
          onSignAdded={handleSignAdded}
          onSignDeleted={handleSignDeleted}
          onUnlock={handleUnlockSign}
        />
      )}

      {specViewer && (
        <SignSpecModal
          jobId={jobId}
          fileId={specViewer.fileId}
          fileName={specViewer.fileName}
          specPages={specViewer.specPages}
          onClose={() => setSpecViewer(null)}
        />
      )}
    </AppShell>
  );
}

function CoordinatesTable({
  signs,
  showAiHighlight,
  onView,
}: {
  signs: AnySign[];
  showAiHighlight?: boolean;
  onView: (sign: AnySign) => void;
}) {
  const [coordSortField, setCoordSortField] = useState<string>("page");
  const [coordSortDir, setCoordSortDir] = useState<"asc" | "desc">("asc");
  const [showCoordExceptions, setShowCoordExceptions] = useState(false);

  const handleCoordSort = (field: string) => {
    if (coordSortField === field) {
      setCoordSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCoordSortField(field);
      setCoordSortDir("asc");
    }
  };

  const coordExceptionCount = signs.filter((s) => s["reviewFlag"] && s["exceptionReason"]).length;
  const sorted = [...(showCoordExceptions ? signs.filter((s) => s["reviewFlag"] && s["exceptionReason"]) : signs)].sort((a, b) => {
    let av: string | number = "";
    let bv: string | number = "";
    switch (coordSortField) {
      case "code":
        av = (a.signIdentifier as string | null) ?? "";
        bv = (b.signIdentifier as string | null) ?? "";
        break;
      case "codeText": {
        const aId = (a.signIdentifier as string | null) ?? "";
        const aLoc = (a.location as string | null) ?? "";
        av = [aId, aLoc].filter(Boolean).join(" ");
        const bId = (b.signIdentifier as string | null) ?? "";
        const bLoc = (b.location as string | null) ?? "";
        bv = [bId, bLoc].filter(Boolean).join(" ");
        break;
      }
      default: {
        const pageA = (a.pageNumber as number | null) ?? 0;
        const pageB = (b.pageNumber as number | null) ?? 0;
        if (pageA !== pageB) return pageA - pageB;
        const idA = (a.signIdentifier as string | null) ?? "";
        const idB = (b.signIdentifier as string | null) ?? "";
        return idA.localeCompare(idB);
      }
    }
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
    return coordSortDir === "asc" ? cmp : -cmp;
  });

  const fmtCoord = (v: unknown) =>
    v != null ? `${(v as number).toFixed(1)}%` : null;

  return (
    <div>
      {coordExceptionCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-secondary/60 border-b border-border/60">
          <button
            onClick={() => setShowCoordExceptions((v) => !v)}
            className={`flex items-center gap-2 px-3 py-1 rounded-md text-[11px] font-display font-semibold uppercase tracking-wide border transition-all ${
              showCoordExceptions
                ? "bg-amber-500/15 text-amber-600 border-amber-500/40"
                : "bg-secondary text-muted-foreground border-border hover:text-amber-600 hover:border-amber-500/40"
            }`}
          >
            <AlertTriangle className="w-3 h-3" />
            {showCoordExceptions ? "Show all signs" : `Exceptions (${coordExceptionCount})`}
          </button>
        </div>
      )}
    <div className="overflow-x-auto">
      <div className="min-w-[max-content] inline-block align-top w-full">
        <table className="w-full text-left border-collapse border-spacing-0">
          <thead>
            <tr>
              <SortableHeader field="code" label="Sign ID" sortField={coordSortField} sortDir={coordSortDir} onSort={handleCoordSort} className="sticky left-0 z-30 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]" />
              <th className="data-header">Location</th>
              <th className="data-header">Sign Type</th>
              <th className="data-header">Message</th>
              <th className="data-header">Word-match Coords</th>
              <th className="data-header">AI Bbox</th>
              <th className="data-header text-center">Status</th>
              <th className="data-header text-center w-20">View</th>
            </tr>
          </thead>
          <tbody className="bg-background">
            {sorted.map((sign, idx) => {
              const xPos = sign.xPos as number | null | undefined;
              const yPos = sign.yPos as number | null | undefined;
              const bboxX = sign.aiBboxX as number | null | undefined;
              const bboxY = sign.aiBboxY as number | null | undefined;
              const bboxW = sign.aiBboxW as number | null | undefined;
              const bboxH = sign.aiBboxH as number | null | undefined;
              const isAiRow = showAiHighlight && ((sign.dataSource as string | null | undefined) === "ai" || (sign as Record<string, unknown>).aiBbox === true);
              const isBboxAi = showAiHighlight && (sign as Record<string, unknown>).aiBbox === true;

              const hasCoords = xPos != null && yPos != null;
              const hasBbox = bboxX != null && bboxY != null && bboxW != null && bboxH != null;

              let statusLabel: string;
              let statusCls: string;
              if (hasCoords && hasBbox) {
                statusLabel = "Both";
                statusCls = "bg-green-500/15 text-green-600 border-green-500/30";
              } else if (hasBbox) {
                statusLabel = "Bbox only";
                statusCls = "bg-blue-500/15 text-blue-600 border-blue-500/30";
              } else if (hasCoords) {
                statusLabel = "Coords only";
                statusCls = "bg-amber-500/15 text-amber-600 border-amber-500/30";
              } else {
                statusLabel = "None";
                statusCls = "bg-muted/40 text-muted-foreground border-border";
              }

              const isNone = !hasCoords && !hasBbox;
              const codeVal = (sign.signIdentifier as string | null) || "—";
              const exceptionReason = sign.exceptionReason as string | null | undefined;
              const isException = !!(sign.reviewFlag && exceptionReason);

              return (
                <tr
                  key={sign.id as string}
                  className={`
                    hover:bg-secondary/40 transition-colors
                    ${isException ? "bg-amber-500/5" : idx % 2 === 0 ? "" : "bg-card/30"}
                    ${isNone ? "opacity-50" : ""}
                  `}
                  style={isAiRow ? { boxShadow: 'inset 3px 0 0 rgba(139, 92, 246, 0.6)', background: 'rgba(139, 92, 246, 0.04)' } : undefined}
                >
                  <td className="data-cell sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                    <span className="text-xs font-semibold">{codeVal}</span>
                  </td>
                  <td className="data-cell">
                    <span className="text-xs text-muted-foreground">{(sign.location as string | null) ?? "—"}</span>
                  </td>
                  <td className="data-cell">
                    <span className="text-xs">{(sign.signType as string | null) ?? "—"}</span>
                  </td>
                  <td className="data-cell max-w-[200px]">
                    <span className="text-xs text-muted-foreground line-clamp-2">{(sign.messageContent as string | null) ?? "—"}</span>
                  </td>
                  <td className="data-cell">
                    {hasCoords ? (
                      <span className="text-xs font-mono text-foreground">
                        ({fmtCoord(xPos)}, {fmtCoord(yPos)})
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className={`data-cell ${isBboxAi ? "bg-violet-500/5" : ""}`}>
                    {hasBbox ? (
                      <div className={`text-[10px] font-mono leading-tight rounded px-1.5 py-1 inline-block ${isBboxAi ? "bg-violet-500/15 text-violet-300 border border-violet-500/20" : "bg-secondary/60"}`}>
                        <div>x: {fmtCoord(bboxX)}  y: {fmtCoord(bboxY)}</div>
                        <div>w: {fmtCoord(bboxW)}  h: {fmtCoord(bboxH)}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="data-cell text-center">
                    <div className="flex flex-col gap-1 items-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusCls}`}>
                        {statusLabel}
                      </span>
                      {isException && (
                        <span
                          title={`Exception: ${exceptionReason}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-600 border border-amber-500/30 cursor-help max-w-[120px] truncate"
                        >
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span className="truncate">{exceptionReason}</span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="data-cell text-center">
                    <button
                      onClick={() => onView(sign)}
                      className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                      title="Open in plan viewer"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}

function SortableHeader({
  field, label, sortField, sortDir, onSort, className,
}: {
  field: string;
  label: string;
  sortField: string | null;
  sortDir: "asc" | "desc";
  onSort: (field: string) => void;
  className?: string;
}) {
  const active = sortField === field;
  return (
    <th
      className={`data-header cursor-pointer select-none group hover:text-foreground ${className ?? ""}`}
      onClick={() => onSort(field)}
    >
      <div className="flex items-center gap-1">
        <span>{label}</span>
        <span className={`flex-shrink-0 ${active ? "text-primary" : "text-muted-foreground/25 group-hover:text-muted-foreground/50"}`}>
          {active
            ? sortDir === "asc"
              ? <ChevronUp className="w-3 h-3" />
              : <ChevronDown className="w-3 h-3" />
            : <ChevronsUpDown className="w-3 h-3" />
          }
        </span>
      </div>
    </th>
  );
}

function StatusBadge({ status }: { status: string }) {
  type StatusConfig = { color: string; icon: typeof FileText; label: string };
  const statusMap: Record<string, StatusConfig> = {
    pending: { color: "bg-muted text-muted-foreground border-border", icon: FileText, label: "PENDING" },
    processing: { color: "bg-primary/20 text-primary border-primary/30", icon: Cpu, label: "PROCESSING" },
    completed: { color: "bg-green-900/30 text-green-400 border-green-700/40", icon: CheckCircle2, label: "COMPLETED" },
    failed: { color: "bg-destructive/20 text-destructive border-destructive/30", icon: AlertTriangle, label: "FAILED" },
  };
  const config = statusMap[status] ?? statusMap["pending"]!;

  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-display font-bold tracking-widest border ${config.color}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

function ConfidenceBadge({ score }: { score: number }) {
  let color = "text-destructive bg-destructive/10 border-destructive/20";
  if (score >= 0.8) color = "text-accent bg-accent/10 border-accent/20";
  else if (score >= 0.6) color = "text-primary bg-primary/10 border-primary/20";

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-mono font-medium border ${color}`}>
      {Math.round(score * 100)}%
    </span>
  );
}

function SummaryCard({ title, value, icon, accent, onClick, isActive }: { title: string, value: number, icon: React.ReactNode, accent?: 'primary' | 'accent', onClick?: () => void, isActive?: boolean }) {
  const clickable = typeof onClick === "function";
  return (
    <div
      onClick={onClick}
      className={`bg-card border px-3 py-2 rounded-lg relative overflow-hidden group transition-colors
        ${clickable ? "cursor-pointer select-none" : ""}
        ${isActive && accent === "primary" ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30" : ""}
        ${isActive && !accent ? "border-foreground/40 bg-secondary/60 ring-1 ring-foreground/20" : ""}
        ${!isActive ? "border-border hover:border-border/80" : ""}
      `}
    >
      <div className="flex justify-between items-center relative z-10">
        <div>
          <p className="text-[10px] font-display font-medium text-muted-foreground uppercase tracking-wider mb-0.5">{title}</p>
          <p className={`text-xl font-mono font-bold ${accent === 'primary' ? 'text-primary' : accent === 'accent' ? 'text-accent' : 'text-foreground'}`}>
            {value}
          </p>
        </div>
        <div className="p-1.5 bg-secondary rounded-md flex-shrink-0">
          {icon}
        </div>
      </div>
      {accent === 'primary' && <div className="absolute -bottom-4 -right-4 w-16 h-16 bg-primary/5 rounded-full blur-2xl group-hover:bg-primary/10 transition-colors"></div>}
      {accent === 'accent' && <div className="absolute -bottom-4 -right-4 w-16 h-16 bg-accent/5 rounded-full blur-2xl group-hover:bg-accent/10 transition-colors"></div>}
    </div>
  );
}

type SignSummaryRow = {
  signType: string;
  dimensions: string;
  qty: number;
  sheets: string[];
};

type AnySign = Record<string, unknown>;

function buildSignSummary(signs: AnySign[]): SignSummaryRow[] {
  const map = new Map<string, SignSummaryRow>();
  for (const sign of signs) {
    const st = ((sign.signType as string) || "Unknown").trim();
    const dim = ((sign.dimensions as string) || "—").trim();
    const key = `${st}||${dim}`;
    const ex = map.get(key);
    const qty = (sign.quantity as number) ?? 1;
    const sheet = (sign.sheetNumber as string) || null;
    if (ex) {
      ex.qty += qty;
      if (sheet && !ex.sheets.includes(sheet)) ex.sheets.push(sheet);
    } else {
      map.set(key, { signType: st, dimensions: dim, qty, sheets: sheet ? [sheet] : [] });
    }
  }
  return [...map.values()].sort((a, b) =>
    a.signType.localeCompare(b.signType) || a.dimensions.localeCompare(b.dimensions)
  );
}

function SignSummaryPanel({ signs }: { signs: AnySign[] }) {
  const [open, setOpen] = useState(true);
  const rows = buildSignSummary(signs);
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);

  return (
    <div className="flex-none border-t border-border/60 bg-background">
      <div className="max-w-7xl mx-auto w-full px-4">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-3 py-2 w-full text-left group"
        >
          <BarChart2 className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-display font-semibold text-foreground uppercase tracking-wider">Sign Type Summary</span>
          <span className="text-[10px] font-mono text-muted-foreground/50">
            {rows.length} type{rows.length !== 1 ? "s" : ""} · {totalQty} total
          </span>
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground/50 ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="pb-3 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-y border-border/60">
                  <th className="py-1 px-2 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Sign Type</th>
                  <th className="py-1 px-2 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Size</th>
                  <th className="py-1 px-2 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground text-center">Qty</th>
                  <th className="py-1 px-2 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Floors / Sheets</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-b border-border/30 hover:bg-secondary/20 ${i % 2 === 0 ? "" : "bg-card/30"}`}>
                    <td className="py-1 px-2 text-xs text-foreground">{r.signType}</td>
                    <td className="py-1 px-2 text-xs font-mono text-muted-foreground">{r.dimensions}</td>
                    <td className="py-1 px-2 text-xs font-mono font-bold text-center text-foreground">{r.qty}</td>
                    <td className="py-1 px-2 text-[10px] font-mono text-muted-foreground/70">{r.sheets.sort().join(", ") || "—"}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border/60 bg-secondary/30">
                  <td className="py-1 px-2 text-xs font-bold text-foreground" colSpan={2}>Total</td>
                  <td className="py-1 px-2 text-xs font-mono font-bold text-center text-primary">{totalQty}</td>
                  <td className="py-1 px-2"></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type FileWithStats = NonNullable<ReturnType<typeof useJobDetails>["data"]>["files"][number];
type SpecViewerState = { fileId: string; fileName: string; specPages: number[] };

type OutlineSection = NonNullable<NonNullable<FileWithStats["pageStats"]>["outlineSections"]>[number];

type DetectionRow = {
  pageNo: number;
  label: string;
  bookmarkTitle: string | null;
};

type RawPageStats = NonNullable<FileWithStats["pageStats"]>;

function buildDetectionRows(
  stats: RawPageStats
): { floorPlanRows: DetectionRow[]; signSpecRows: DetectionRow[] } {
  const floorPlanPages = stats.floorPlanPages ?? [];
  const signSchedulePages = stats.signSchedulePages ?? [];
  const pageLabels = stats.pageLabels ?? [];
  const outlineSections = stats.outlineSections ?? [];

  const getLabel = (pgNo: number): string => {
    const label = pageLabels[pgNo - 1];
    return label ? String(label) : `pg ${pgNo}`;
  };

  const getBookmarkTitle = (pgNo: number): string | null => {
    for (const section of outlineSections) {
      if (pgNo >= section.pageStart && pgNo <= section.pageEnd) {
        return section.title ?? null;
      }
    }
    return null;
  };

  const bothPages: number[] = (stats as Record<string, unknown>).bothPages as number[] ?? [];

  const floorPlanRows: DetectionRow[] = floorPlanPages.map((pgNo) => ({
    pageNo: pgNo,
    label: getLabel(pgNo),
    bookmarkTitle: getBookmarkTitle(pgNo),
  }));

  // Sign spec rows include both pure sign-schedule pages AND "both" pages
  // (combined floor-plan + sign-schedule sheets). Deduplicated and sorted.
  const allSpecPageNums = [...new Set([...signSchedulePages, ...bothPages])].sort((a, b) => a - b);
  const signSpecRows: DetectionRow[] = allSpecPageNums.map((pgNo) => ({
    pageNo: pgNo,
    label: getLabel(pgNo),
    bookmarkTitle: getBookmarkTitle(pgNo),
  }));

  return { floorPlanRows, signSpecRows };
}

function DetectionTable({
  title,
  rows,
  colorScheme,
  rejectedPageNumbers,
  toggleRejectedPage,
}: {
  title: string;
  rows: DetectionRow[];
  colorScheme: "primary" | "accent";
  rejectedPageNumbers: number[];
  toggleRejectedPage: (pageNo: number) => void;
}) {
  const headCls =
    colorScheme === "primary"
      ? "text-primary/70 bg-primary/5 border-primary/10"
      : "text-accent/70 bg-accent/5 border-accent/10";

  // Rejected pages are excluded entirely from the display.
  const visibleRows = rows.filter((r) => !rejectedPageNumbers.includes(r.pageNo));
  const rejectedCount = rows.length - visibleRows.length;

  if (visibleRows.length === 0 && rejectedCount === 0) return null;

  return (
    <div className="mt-3">
      <p className={`text-[10px] font-display font-semibold uppercase tracking-wider mb-1 ${colorScheme === "primary" ? "text-primary/70" : "text-accent/70"}`}>
        {title}
      </p>
      {visibleRows.length > 0 && (
        <div className="overflow-x-auto rounded border border-border/60">
          <table className="w-full text-left border-collapse text-[10px] font-mono">
            <thead>
              <tr className={`border-b border-border/60 ${headCls}`}>
                <th className="px-2 py-1 font-semibold whitespace-nowrap">Page No</th>
                <th className="px-2 py-1 font-semibold whitespace-nowrap">Label</th>
                <th className="px-2 py-1 font-semibold whitespace-nowrap">Bookmark</th>
                <th className="px-2 py-1 font-semibold whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, i) => (
                <tr
                  key={`${row.pageNo}-${i}`}
                  className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? "bg-background" : "bg-card/40"}`}
                >
                  <td className="px-2 py-1 text-muted-foreground">{row.pageNo}</td>
                  <td className="px-2 py-1 text-foreground/80">{row.label}</td>
                  <td className="px-2 py-1 max-w-[160px] truncate text-foreground/70" title={row.bookmarkTitle ?? undefined}>
                    {row.bookmarkTitle ?? "—"}
                  </td>
                  <td className="px-2 py-1">
                    <button
                      onClick={() => toggleRejectedPage(row.pageNo)}
                      className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border transition-colors bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20"
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rejectedCount > 0 && (
        <p className="mt-1 text-[9px] text-muted-foreground/50 italic">
          {rejectedCount} page{rejectedCount > 1 ? "s" : ""} excluded from extraction
        </p>
      )}
    </div>
  );
}

function OutlineSectionsTree({ sections }: { sections: OutlineSection[] }) {
  const [expanded, setExpanded] = useState(false);
  const preview = sections.slice(0, 3);
  const hasMore = sections.length > 3;

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left group mb-1"
      >
        <span className="text-[10px] text-muted-foreground/60">
          PDF sections ({sections.length})
        </span>
        <ChevronDown
          className={`w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-transform ml-auto ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {(expanded ? sections : preview).map((section, si) => {
        const sType = section.type;
        const badgeClass =
          sType === "sign_schedule"
            ? "bg-accent/15 text-accent border-accent/30"
            : sType === "floor_plan"
            ? "bg-primary/10 text-primary/80 border-primary/20"
            : "bg-secondary text-muted-foreground/60 border-border/60";
        const badge =
          sType === "sign_schedule" ? "Sign Sched"
          : sType === "floor_plan" ? "Floor Plan"
          : null;
        return (
          <div key={si} className="flex items-center gap-1.5 py-0.5">
            <span className="text-[10px] font-mono text-foreground/80 truncate max-w-[180px]" title={section.title}>
              {section.title}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
              pg {section.pageStart}{section.pageEnd !== section.pageStart ? `–${section.pageEnd}` : ""}
            </span>
            {badge && (
              <span className={`px-1.5 py-px rounded text-[9px] font-bold uppercase tracking-wider border flex-shrink-0 ${badgeClass}`}>
                {badge}
              </span>
            )}
          </div>
        );
      })}
      {!expanded && hasMore && (
        <button
          onClick={() => setExpanded(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground mt-0.5 transition-colors"
        >
          +{sections.length - 3} more sections…
        </button>
      )}
    </div>
  );
}

function SheetsPanel({
  files,
  onOpenSpec,
  allSigns,
  hiddenSigns,
  toggleHidden,
  jobId,
  toggleRejectedPage,
}: {
  files: FileWithStats[];
  onOpenSpec: (v: SpecViewerState) => void;
  allSigns: Array<{ id: string; pageNumber?: number | null; jobFileId?: string | null; hidden?: boolean }>;
  hiddenSigns: Array<{ id: string; pageNumber?: number | null; jobFileId?: string | null; hidden?: boolean }>;
  toggleHidden: (signId: string, currentlyHidden: boolean) => void;
  jobId: string;
  toggleRejectedPage: (fileId: string, pageNo: number) => void;
}) {
  const [open, setOpen] = useState(true);

  const hasStats = files.some((f) => f.pageStats != null);
  if (!hasStats) return null;

  const totalPages = files.reduce((sum, f) => sum + (f.pageCount ?? 0), 0);
  const totalSignSchedule = files.reduce((sum, f) => {
    const ss = f.pageStats?.signSchedulePages?.length ?? 0;
    const both = (f.pageStats as Record<string, unknown>)?.bothPages instanceof Array
      ? ((f.pageStats as Record<string, unknown>).bothPages as number[]).length : 0;
    return sum + ss + both;
  }, 0);
  const totalFloorPlan = files.reduce((sum, f) => sum + (f.pageStats?.floorPlanPages?.length ?? 0), 0);

  // Find the first file that has sign spec pages (sign schedule OR both)
  const firstSpecFile = files.find(
    (f) => (f.pageStats?.signSchedulePages?.length ?? 0) > 0 ||
      (((f.pageStats as Record<string, unknown>)?.bothPages as number[] | undefined)?.length ?? 0) > 0
  );

  // Build the combined spec page list for a given file's pageStats
  const getSpecPages = (stats: NonNullable<typeof firstSpecFile>["pageStats"]): number[] => {
    const ss = stats?.signSchedulePages ?? [];
    const both = (stats as Record<string, unknown>)?.bothPages as number[] | undefined ?? [];
    return [...new Set([...ss, ...both])].sort((a, b) => a - b);
  };

  return (
    <div className="flex-none border-t border-border/60 bg-background">
      <div className="max-w-7xl mx-auto w-full px-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex-1 flex items-center gap-3 py-2 text-left group"
          >
            <Layers className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-display font-semibold text-foreground uppercase tracking-wider">Sheets Analysis</span>
            {totalSignSchedule > 0 ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/20 text-accent border border-accent/30 text-[10px] font-bold uppercase tracking-wider">
                ✓ {totalSignSchedule} Sign Spec {totalSignSchedule === 1 ? "Page" : "Pages"} Found
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground/50 font-mono">No sign spec pages detected</span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground/50">
              {totalFloorPlan} floor plan{totalFloorPlan !== 1 ? "s" : ""} · {totalPages} total pages
            </span>
          </button>
          <div className="flex items-center gap-2">
            {firstSpecFile && (
              <button
                onClick={() =>
                  onOpenSpec({
                    fileId: firstSpecFile.id,
                    fileName: firstSpecFile.originalName,
                    specPages: getSpecPages(firstSpecFile.pageStats),
                  })
                }
                className="flex-shrink-0 px-3 py-1 rounded text-[10px] font-display font-bold uppercase tracking-wider border bg-accent/10 text-accent border-accent/40 hover:bg-accent/20 transition-colors"
              >
                Review Sign Spec →
              </button>
            )}
            <button
              onClick={() => setOpen((v) => !v)}
              className="w-7 h-7 flex items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
            </button>
          </div>
        </div>

        {open && (
          <div className="pb-3 space-y-2">
            {files.map((f) => {
              const stats = f.pageStats;
              const total = f.pageCount ?? 0;
              const bothCount = stats?.bothPages?.length ?? 0;
              const fpCount = (stats?.floorPlanPages?.length ?? 0) - bothCount;
              const ssCount = (stats?.signSchedulePages?.length ?? 0) - bothCount;
              const otherCount = stats?.otherPages?.length ?? 0;
              const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

              return (
                <div key={f.id} className="bg-card border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-mono text-foreground font-medium truncate">{f.originalName}</span>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button
                        onClick={() => openPdfInNewTab(jobId, f.id, f.originalName).catch(() => {})}
                        title="Open original PDF in new tab"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground border border-border hover:text-primary hover:border-primary/50 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        PDF
                      </button>
                      {(ssCount > 0 || bothCount > 0) && (
                        <button
                          onClick={() =>
                            onOpenSpec({
                              fileId: f.id,
                              fileName: f.originalName,
                              specPages: getSpecPages(stats),
                            })
                          }
                          className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors"
                        >
                          Review Spec →
                        </button>
                      )}
                      <span className="text-[10px] font-mono text-muted-foreground">{total} pages</span>
                    </div>
                  </div>

                  {stats ? (
                    <>
                      {/* Stacked proportion bar */}
                      <div className="h-1.5 rounded-full overflow-hidden flex mb-2 bg-secondary">
                        {ssCount > 0 && (
                          <div className="h-full bg-accent/70" style={{ width: `${pct(ssCount)}%` }} title={`Sign specs: ${ssCount} pages`} />
                        )}
                        {bothCount > 0 && (
                          <div className="h-full bg-violet-500/60" style={{ width: `${pct(bothCount)}%` }} title={`Floor plan + sign schedule: ${bothCount} pages`} />
                        )}
                        {fpCount > 0 && (
                          <div className="h-full bg-primary/40" style={{ width: `${pct(fpCount)}%` }} title={`Floor plans: ${fpCount} pages`} />
                        )}
                      </div>

                      {/* Legend */}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] font-mono text-muted-foreground mb-2">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm bg-accent/70 inline-block" />
                          Sign Specs/Schedules — {ssCount}
                        </span>
                        {bothCount > 0 && (
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-sm bg-violet-500/60 inline-block" />
                            Floor Plan + Sign Schedule — {bothCount}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm bg-primary/40 inline-block" />
                          Floor Plans — {fpCount}
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm bg-secondary inline-block border border-border/60" />
                          Other/Title Sheets — {otherCount}
                        </span>
                      </div>

                      {/* Combined floor plan + sign schedule page chips */}
                      {bothCount > 0 && (
                        <div className="flex items-center flex-wrap gap-1 mb-1">
                          <span className="text-[10px] text-muted-foreground/60 mr-0.5">Combined pages:</span>
                          {(stats.bothPages ?? []).map((pg) => (
                            <span key={pg} className="px-1.5 py-0.5 bg-violet-500/15 text-violet-400 border border-violet-500/30 text-[10px] font-mono rounded">
                              pg {pg}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Sign spec page chips (pure schedule pages only) */}
                      {ssCount > 0 && (
                        <div className="flex items-center flex-wrap gap-1 mb-1">
                          <span className="text-[10px] text-muted-foreground/60 mr-0.5">Sign spec pages:</span>
                          {(stats.signSchedulePages ?? []).filter((pg) => !(stats.bothPages ?? []).includes(pg)).map((pg) => (
                            <span key={pg} className="px-1.5 py-0.5 bg-accent/15 text-accent border border-accent/30 text-[10px] font-mono rounded">
                              pg {pg}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Floor plan page chips (pure floor plan pages only, limited) */}
                      {fpCount > 0 && (
                        <div className="flex items-center flex-wrap gap-1">
                          <span className="text-[10px] text-muted-foreground/60 mr-0.5">Floor plan pages:</span>
                          {(stats.floorPlanPages ?? []).filter((pg) => !(stats.bothPages ?? []).includes(pg)).slice(0, 24).map((pg) => (
                            <span key={pg} className="px-1.5 py-0.5 bg-primary/10 text-primary/70 border border-primary/20 text-[10px] font-mono rounded">
                              pg {pg}
                            </span>
                          ))}
                          {fpCount > 24 && (
                            <span className="text-[10px] font-mono text-muted-foreground/50">+{fpCount - 24} more</span>
                          )}
                        </div>
                      )}

                      {/* Outline sections tree — collapsible */}
                      {stats.outlineSections && stats.outlineSections.length > 0 && (
                        <OutlineSectionsTree sections={stats.outlineSections} />
                      )}

                      {/* Detection tables */}
                      {(() => {
                        const { floorPlanRows, signSpecRows } = buildDetectionRows(stats);
                        const rejectedPageNumbers = (stats as RawPageStats).rejectedPageNumbers ?? [];
                        return (
                          <>
                            <DetectionTable
                              title="Floor Plans Detected"
                              rows={floorPlanRows}
                              colorScheme="primary"
                              rejectedPageNumbers={rejectedPageNumbers}
                              toggleRejectedPage={(pageNo) => toggleRejectedPage(f.id, pageNo)}
                            />
                            <DetectionTable
                              title="Sign Specs / Schedules Detected"
                              rows={signSpecRows}
                              colorScheme="accent"
                              rejectedPageNumbers={rejectedPageNumbers}
                              toggleRejectedPage={(pageNo) => toggleRejectedPage(f.id, pageNo)}
                            />
                          </>
                        );
                      })()}
                    </>
                  ) : (
                    <p className="text-[10px] text-muted-foreground/40 font-mono">
                      No classification data — re-run extraction to generate sheet breakdown.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SOURCE BADGE ─────────────────────────────────────────────────────────────

function SourceBadge({ sign }: { sign: Record<string, unknown> }) {
  const method = sign.extractionMethod as string | null | undefined;
  const paired = sign.pairedSignId as string | null | undefined;
  const manual = sign.manuallyAdded as boolean | undefined;
  const dataSource = sign.dataSource as string | null | undefined;

  if (manual) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-purple-500/10 text-purple-400 border border-purple-500/20 whitespace-nowrap">
        <Pencil className="w-2.5 h-2.5" /> Manual
      </span>
    );
  }

  if (dataSource === "ai") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-violet-500/10 text-violet-400 border border-violet-500/20 whitespace-nowrap">
        <Brain className="w-2.5 h-2.5" /> AI Scan
      </span>
    );
  }

  if (method === "text" && paired) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-accent/10 text-accent border border-accent/20 whitespace-nowrap">
        <ShieldCheck className="w-2.5 h-2.5" /> Both
      </span>
    );
  }

  if (method === "image") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-orange-500/10 text-orange-400 border border-orange-500/20 whitespace-nowrap">
        <Eye className="w-2.5 h-2.5" /> Visual
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/20 whitespace-nowrap">
      <FileText className="w-2.5 h-2.5" /> Text
    </span>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function CostCard({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }) {
  const hasData = inputTokens > 0 || outputTokens > 0;
  // Gemini 2.5 Flash pricing (thinking disabled): $0.15/M input, $0.60/M output
  const INPUT_RATE  = 0.15; // $ per million tokens
  const OUTPUT_RATE = 0.60; // $ per million tokens
  const inputCost  = (inputTokens  * INPUT_RATE)  / 1_000_000;
  const outputCost = (outputTokens * OUTPUT_RATE) / 1_000_000;
  const totalCost  = inputCost + outputCost;
  const fmt = (c: number) =>
    c === 0 ? "$0.00" : c < 0.001 ? `$${c.toFixed(5)}` : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`;

  return (
    <div className="bg-card border border-border px-3 py-2 rounded-lg relative overflow-hidden group hover:border-border/80 transition-colors">
      <div className="flex justify-between items-start relative z-10">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-display font-medium text-muted-foreground uppercase tracking-wider mb-0.5">AI Processing Cost</p>
          <p className="text-xl font-mono font-bold text-foreground">
            {hasData ? fmt(totalCost) : "—"}
          </p>
          {hasData ? (
            <div className="mt-1.5 space-y-1">
              {/* Input row */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                  <span className="text-blue-400">→</span> Input <span className="text-muted-foreground/50">(text + visual scans)</span>
                </span>
                <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                  {fmtTokens(inputTokens)} tok · {fmt(inputCost)}
                </span>
              </div>
              {/* Output row */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
                  <span className="text-accent">←</span> Output <span className="text-muted-foreground/50">(sign JSON)</span>
                </span>
                <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                  {fmtTokens(outputTokens)} tok · {fmt(outputCost)}
                </span>
              </div>
              {/* Rate footnote */}
              <div className="pt-1.5 border-t border-border/40 text-[9px] font-mono text-muted-foreground/50 leading-relaxed">
                Gemini 2.5 Flash · text + visual · ${INPUT_RATE}/M input · ${OUTPUT_RATE}/M output
              </div>
            </div>
          ) : (
            <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">No token data for this job</p>
          )}
        </div>
        <div className="p-1.5 bg-secondary rounded-md flex-shrink-0">
          <Zap className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function PlaqueScheduleTab({
  jobId: _jobId,
  plaques,
  isLoading,
  isExtracting,
  onExtract,
}: {
  jobId: string;
  plaques: PlaqueScheduleEntry[];
  isLoading: boolean;
  isExtracting: boolean;
  onExtract: () => void;
}) {
  return (
    <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-display font-semibold text-foreground">Plaque Schedule</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Plaque type specifications extracted from sign schedule pages.
          </p>
        </div>
        <button
          onClick={onExtract}
          disabled={isExtracting}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-medium hover:bg-indigo-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isExtracting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <BookOpen className="w-3.5 h-3.5" />
          )}
          {isExtracting ? "Extracting…" : plaques.length > 0 ? "Re-extract" : "Extract Plaque Schedule"}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : plaques.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-10 flex flex-col items-center gap-3 text-center">
          <Stamp className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No plaque schedule data yet.</p>
          <p className="text-xs text-muted-foreground/60">
            Click "Extract Plaque Schedule" to scan sign schedule pages for plaque type specifications.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-secondary/60">
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-16">Type</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-20">Braille</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-20">Insert</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Insert Size</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Letter Ht.</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Trigger</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Maps To</th>
                <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-16 text-center">Page</th>
              </tr>
            </thead>
            <tbody>
              {plaques.map((p, i) => (
                <tr
                  key={p.id}
                  className={`border-t border-border/50 hover:bg-secondary/30 transition-colors ${i % 2 === 0 ? "" : "bg-secondary/10"}`}
                >
                  <td className="px-3 py-2 font-mono text-xs font-semibold text-indigo-400">{p.typeId}</td>
                  <td className="px-3 py-2 text-sm text-foreground">{p.name ?? <span className="text-muted-foreground/40">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-center">
                    {p.braille === true ? (
                      <span className="text-emerald-400 font-semibold">Yes</span>
                    ) : p.braille === false ? (
                      <span className="text-muted-foreground/50">No</span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-center">
                    {p.insert === true ? (
                      <span className="text-emerald-400 font-semibold">Yes</span>
                    ) : p.insert === false ? (
                      <span className="text-muted-foreground/50">No</span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.insertSize ?? <span className="text-muted-foreground/30">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.letterHeight ?? <span className="text-muted-foreground/30">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-[200px] truncate" title={p.trigger ?? undefined}>{p.trigger ?? <span className="text-muted-foreground/30">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.mapsToColumn ?? <span className="text-muted-foreground/30">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground text-center font-mono">{p.sourcePage ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OccupantLoadsTab({
  jobId: _jobId,
  loads,
  assemblyRooms,
  isLoading,
  isExtracting,
  onExtract,
}: {
  jobId: string;
  loads: OccupantLoadEntry[];
  assemblyRooms: AssemblyRoom[];
  isLoading: boolean;
  isExtracting: boolean;
  onExtract: () => void;
}) {
  const assemblySet = new Set(assemblyRooms.map((r) => r.roomNumber));

  return (
    <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-display font-semibold text-foreground">Occupant Loads</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Room-level occupancy data extracted from egress/life-safety drawings.
          </p>
        </div>
        <button
          onClick={onExtract}
          disabled={isExtracting}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs font-medium hover:bg-orange-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isExtracting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Users className="w-3.5 h-3.5" />
          )}
          {isExtracting ? "Extracting…" : loads.length > 0 ? "Re-extract" : "Extract Occupant Loads"}
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loads.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-10 flex flex-col items-center gap-3 text-center">
          <Users className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No occupant load data yet.</p>
          <p className="text-xs text-muted-foreground/60">
            Click "Extract Occupant Loads" to scan egress drawings for room-level occupancy data.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {assemblyRooms.length > 0 && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />
                <span className="text-sm font-display font-semibold text-orange-400">
                  Assembly Rooms ({assemblyRooms.length})
                </span>
                <span className="text-xs text-muted-foreground">— occupant load ≥ 50</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {assemblyRooms.map((r) => (
                  <div
                    key={r.roomNumber}
                    className="flex items-center justify-between gap-2 bg-orange-500/10 border border-orange-500/20 rounded-md px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-mono font-semibold text-orange-400">{r.roomNumber}</div>
                      {r.roomName && (
                        <div className="text-xs text-muted-foreground truncate">{r.roomName}</div>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-bold font-mono text-orange-300">{r.occupantLoad}</div>
                      {r.occupancyGroup && (
                        <div className="text-[10px] text-muted-foreground font-mono">{r.occupancyGroup}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-secondary/60">
                  <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-24">Room #</th>
                  <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground">Room Name</th>
                  <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-28 text-right">Occupant Load</th>
                  <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-28">Occupancy Group</th>
                  <th className="px-3 py-2 text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground w-16 text-center">Page</th>
                </tr>
              </thead>
              <tbody>
                {loads.map((r, i) => {
                  const isAssembly = assemblySet.has(r.roomNum);
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-border/50 transition-colors ${
                        isAssembly
                          ? "bg-orange-500/8 hover:bg-orange-500/12"
                          : i % 2 === 0
                            ? "hover:bg-secondary/30"
                            : "bg-secondary/10 hover:bg-secondary/30"
                      }`}
                    >
                      <td className="px-3 py-2 font-mono text-xs font-semibold text-foreground">
                        <div className="flex items-center gap-1.5">
                          {isAssembly && <AlertTriangle className="w-3 h-3 text-orange-400 flex-shrink-0" />}
                          {r.roomNum}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-sm text-foreground">{r.roomName ?? <span className="text-muted-foreground/40">—</span>}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`text-sm font-mono font-semibold ${isAssembly ? "text-orange-400" : "text-foreground"}`}>
                          {r.occupantLoad ?? <span className="text-muted-foreground/40 font-normal">—</span>}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground font-mono">{r.occupancyGroup ?? <span className="text-muted-foreground/30">—</span>}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground text-center font-mono">{r.sourcePage ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
