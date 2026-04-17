import { useState, useRef, useEffect, useCallback } from "react";
import { useRoute, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/Shell";
import { apiFetch, openPdfInNewTab } from "@/lib/apiClient";
import { useJobDetails, useStartExtraction, downloadExport, useUpdateJobName } from "@/hooks/use-takeoff";
import { UnifiedPlanViewer } from "@/components/UnifiedPlanViewer";
import type { ExtractedSign as SignMarker } from "@/components/UnifiedPlanViewer";
import { SignSpecModal, type PlaqueTableData } from "@/components/SignSpecModal";
import { AiScansTab } from "@/components/AiScansTab";
import { SignSpecsTab } from "@/components/SignSpecsTab";
import { getGetJobQueryKey } from "@workspace/api-client-react";
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
  ChevronRight,
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
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { exportMarkedupPdf, type MarkerSign } from "@/lib/exportMarkedupPdf";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  PHASE_COLOR_FALLBACK,
  PHASE_COLOR_HEX,
  PIPELINE_PHASES,
  derivePhaseStatus,
  phaseColorClasses,
  resolvePhaseForStep,
} from "@/lib/pipeline-phases";

// ── Processing Timeline ──────────────────────────────────────────────────────

interface ProcessingStep {
  step: string;
  label: string;
  durationMs: number;
  startedAt: string;
  phase?: string;
  details?: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// UUID pattern to detect per-file step suffixes — used to filter them out of the top-level view
const PER_FILE_STEP_RE = /^(.+?)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Aggregated timing summary for one file, built from multiple UUID-suffixed per-file steps */
interface FileSummary {
  fileId: string;
  fileName: string;
  combinedDurationMs: number;
  pageCount: number | null;
  classificationLabel: string | null;
  hasError: boolean;
  errorMessage: string | null;
  isSkipped: boolean;
  skipReason: string | null;
}

/** Derive a short classification label from a per-file step's details */
function getClassificationLabel(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const d = details as Record<string, unknown>;
  if (d.classification) return String(d.classification);
  if (Number(d.signSchedule) > 0) return "Sign Schedule";
  if (Number(d.floorPlan) > 0) return "Floor Plan";
  if (d.classified) return String(d.classified);
  return null;
}

/**
 * Known per-file step base names that belong to the extraction phase.
 * Gating to this set prevents future non-extraction UUID-suffixed steps
 * from being incorrectly folded into the extraction breakdown.
 */
const EXTRACTION_STEP_PREFIXES = new Set([
  "sheet_manifest",
  "text_extraction",
  "sign_schedule_extract",
]);

/**
 * Group all UUID-suffixed per-file steps by their file UUID, then combine them
 * into a single FileSummary per file.  All such summaries are keyed under the
 * "extraction" parent step, which is the visible aggregate step in the timeline.
 */
function buildFileSummaries(allSteps: ProcessingStep[]): FileSummary[] {
  // Group per-file steps by their UUID (the file ID) — only for known extraction prefixes
  const byFileId = new Map<string, ProcessingStep[]>();
  for (const s of allSteps) {
    const m = PER_FILE_STEP_RE.exec(s.step);
    if (m && EXTRACTION_STEP_PREFIXES.has(m[1])) {
      const uuid = m[2];
      if (!byFileId.has(uuid)) byFileId.set(uuid, []);
      byFileId.get(uuid)!.push(s);
    }
  }

  const summaries: FileSummary[] = [];
  for (const [fileId, steps] of byFileId) {
    // Prefer file name embedded in step labels ("Text extraction — filename.pdf")
    let fileName = fileId;
    for (const s of steps) {
      const dashIdx = s.label.indexOf(" — ");
      if (dashIdx !== -1) { fileName = s.label.slice(dashIdx + 3); break; }
    }

    // Combined duration is the sum of all per-file passes for this file
    const combinedDurationMs = steps.reduce((acc, s) => acc + s.durationMs, 0);

    // Page count comes from the text_extraction_* step (has a `pages` detail)
    let pageCount: number | null = null;
    const textStep = steps.find((s) => s.step.startsWith("text_extraction_"));
    if (textStep?.details?.pages != null) pageCount = Number(textStep.details.pages);

    // Classification comes from the sheet_manifest_* step (floorPlan / signSchedule counts)
    let classificationLabel: string | null = null;
    const manifestStep = steps.find((s) => s.step.startsWith("sheet_manifest_"));
    if (manifestStep?.details) classificationLabel = getClassificationLabel(manifestStep.details);

    // Error / skip state — check all per-file steps for this file
    let hasError = false;
    let errorMessage: string | null = null;
    let isSkipped = false;
    let skipReason: string | null = null;
    for (const s of steps) {
      const d = s.details ?? {};
      if (d.error) {
        hasError = true;
        if (typeof d.error === "string") errorMessage = d.error;
      }
      if (d.skipped) {
        isSkipped = true;
        if (typeof d.skipReason === "string") skipReason = d.skipReason;
      }
    }

    summaries.push({ fileId, fileName, combinedDurationMs, pageCount, classificationLabel, hasError, errorMessage, isSkipped, skipReason });
  }

  // Sort: failed first, then skipped, then by combined duration descending
  summaries.sort((a, b) => {
    const rankA = a.hasError ? 0 : a.isSkipped ? 1 : 2;
    const rankB = b.hasError ? 0 : b.isSkipped ? 1 : 2;
    if (rankA !== rankB) return rankA - rankB;
    return b.combinedDurationMs - a.combinedDurationMs;
  });

  return summaries;
}

function formatDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const parts: string[] = [];
  const d = details as Record<string, number | string | boolean | undefined>;
  const { rows, pages, inputTokens, outputTokens, verified, discoveries, matched, totalSigns, textAfter, imageAfter, textRows, imageRows, signsExtracted, specFileCount, succeeded, failed, textBefore, imageBefore, classified, floorPlan, signSchedule, filesWithBboxes, pagesWithBboxes, fileCount, totalRooms, totalSignsAssigned, roomsMatched, occupantLoadSource } = d;
  const { skipReason, skipped } = details as Record<string, string | boolean | undefined>;
  if (totalRooms != null) parts.push(`${totalRooms} rooms`);
  if (totalSignsAssigned != null) parts.push(`${totalSignsAssigned} signs`);
  if (roomsMatched != null) parts.push(`${roomsMatched} rooms matched`);
  if (occupantLoadSource != null && occupantLoadSource !== "none") parts.push(`via ${occupantLoadSource}`);
  if (specFileCount != null) parts.push(`${specFileCount} spec file${Number(specFileCount) !== 1 ? "s" : ""}`);
  if (fileCount != null) parts.push(`${fileCount} file${Number(fileCount) !== 1 ? "s" : ""}`);
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

const PHASE_LABELS: Record<string, string> = {
  "phase-1": "Phase 1 — Intake",
  "phase-2": "Phase 2 — Locate Sheets",
  "phase-3": "Phase 3 — Extract",
  "phase-4": "Phase 4 — Finalize",
};

function getPhaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

interface PhaseGroup {
  phase: string | null;
  label: string;
  steps: ProcessingStep[];
  totalMs: number;
}

/** A single per-file summary sub-row inside an expandable step */
function FileSubRow({ summary, maxMs }: { summary: FileSummary; maxMs: number }) {
  const widthPct = Math.max(1, (summary.combinedDurationMs / maxMs) * 100);
  const isProblematic = summary.hasError || summary.isSkipped;

  const barColor = summary.hasError
    ? "bg-red-500/40"
    : summary.isSkipped
    ? "bg-amber-500/30"
    : "bg-primary/30";

  const rowBg = summary.hasError
    ? "bg-red-500/5"
    : summary.isSkipped
    ? "bg-amber-500/5"
    : "";

  const tooltipText = summary.hasError
    ? (summary.errorMessage ? `Error: ${summary.errorMessage}` : "File failed during extraction")
    : summary.isSkipped
    ? (summary.skipReason ? `Skipped: ${summary.skipReason}` : "File was skipped")
    : summary.fileName;

  return (
    <div className={`flex items-center gap-3 py-1 pl-6 text-xs text-muted-foreground rounded ${rowBg}`}>
      <div className="w-44 shrink-0 truncate leading-tight flex items-center gap-1" title={tooltipText}>
        {summary.hasError ? (
          <AlertTriangle className="inline w-3 h-3 mr-0.5 shrink-0 text-red-400" />
        ) : summary.isSkipped ? (
          <AlertTriangle className="inline w-3 h-3 mr-0.5 shrink-0 text-amber-400" />
        ) : (
          <FileText className="inline w-3 h-3 mr-1 opacity-50 shrink-0" />
        )}
        <span className={`truncate ${summary.hasError ? "text-red-400" : summary.isSkipped ? "text-amber-400" : ""}`}>
          {summary.fileName}
        </span>
      </div>
      <div className="flex-1 h-2.5 bg-muted/30 rounded overflow-hidden">
        <div
          className={`h-full rounded ${barColor}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="w-16 shrink-0 text-right font-mono tabular-nums">
        {formatDuration(summary.combinedDurationMs)}
      </div>
      <div className="w-64 shrink-0 flex items-center gap-1.5">
        {summary.hasError && (
          <span className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-semibold border border-red-500/30 shrink-0">
            failed
          </span>
        )}
        {!summary.hasError && summary.isSkipped && (
          <span className="px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-semibold border border-amber-500/30 shrink-0">
            skipped
          </span>
        )}
        {!isProblematic && summary.pageCount != null && (
          <span className="px-1 py-0.5 rounded bg-muted/40 text-[10px]">
            {summary.pageCount}p
          </span>
        )}
        {!isProblematic && summary.classificationLabel && (
          <span className="px-1 py-0.5 rounded bg-muted/40 text-[10px] truncate max-w-[10rem]">
            {summary.classificationLabel}
          </span>
        )}
        {summary.hasError && summary.errorMessage && (
          <span className="text-[10px] text-red-400/70 truncate max-w-[10rem]" title={summary.errorMessage}>
            {summary.errorMessage}
          </span>
        )}
        {!summary.hasError && summary.isSkipped && summary.skipReason && (
          <span className="text-[10px] text-amber-400/70 truncate max-w-[10rem]" title={summary.skipReason}>
            {summary.skipReason}
          </span>
        )}
      </div>
    </div>
  );
}

function TimelineStepRow({ step, maxMs, fileSummaries }: { step: ProcessingStep; maxMs: number; fileSummaries?: FileSummary[] }) {
  const widthPct = Math.max(2, ((step.durationMs ?? 0) / maxMs) * 100);
  const detailStr = formatDetails(step.details);
  const hasChildren = fileSummaries && fileSummaries.length > 0;

  const failedCount = fileSummaries ? fileSummaries.filter((s) => s.hasError).length : 0;
  const skippedCount = fileSummaries ? fileSummaries.filter((s) => !s.hasError && s.isSkipped).length : 0;
  const hasProblems = failedCount > 0 || skippedCount > 0;

  // Auto-expand when there are failures so users don't miss them (also reacts to live updates)
  const [childOpen, setChildOpen] = useState(hasProblems);
  useEffect(() => {
    if (hasProblems) setChildOpen(true);
  }, [hasProblems]);
  const [sortBy, setSortBy] = useState<"duration" | "name">("duration");

  const sortedSummaries = hasChildren
    ? [...fileSummaries].sort((a, b) =>
        sortBy === "duration"
          ? b.combinedDurationMs - a.combinedDurationMs
          : a.fileName.localeCompare(b.fileName)
      )
    : [];

  return (
    <div>
      <div
        className={`flex items-center gap-3 py-1.5 ${hasChildren ? "cursor-pointer select-none hover:bg-muted/20 rounded" : ""}`}
        title={detailStr ?? undefined}
        onClick={hasChildren ? () => setChildOpen((o) => !o) : undefined}
      >
        <div className="w-52 shrink-0 text-sm text-foreground/80 truncate leading-tight flex items-center gap-1">
          {hasChildren && (
            <span className="shrink-0">
              {childOpen
                ? <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground/60" />}
            </span>
          )}
          {hasProblems && (
            <AlertTriangle className="w-3 h-3 shrink-0 text-red-400" />
          )}
          {step.label}
        </div>
        <div className="flex-1 h-4 bg-muted/40 rounded overflow-hidden">
          <div
            className="h-full rounded bg-primary/50"
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <div className="w-16 shrink-0 text-right text-sm font-mono text-foreground/70 tabular-nums">
          {formatDuration(step.durationMs)}
        </div>
        <div className="w-64 shrink-0 flex items-center gap-1.5">
          {detailStr && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-muted/50 text-[11px] text-muted-foreground truncate max-w-full">
              {detailStr}
            </span>
          )}
          {failedCount > 0 && (
            <span className="shrink-0 px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-semibold border border-red-500/30 font-mono">
              {failedCount} failed
            </span>
          )}
          {skippedCount > 0 && (
            <span className="shrink-0 px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-semibold border border-amber-500/30 font-mono">
              {skippedCount} skipped
            </span>
          )}
          {hasChildren && (
            <span className="shrink-0 px-1 py-0.5 rounded bg-muted/40 text-[10px] text-muted-foreground font-mono">
              {fileSummaries.length} file{fileSummaries.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
      {hasChildren && childOpen && (
        <div className="border-l-2 border-border/30 ml-3 mb-1">
          <div
            className="flex items-center gap-1.5 px-6 py-1 border-b border-border/20"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[10px] text-muted-foreground/50 font-display uppercase tracking-wider mr-1">Sort:</span>
            <button
              onClick={() => setSortBy("duration")}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                sortBy === "duration"
                  ? "bg-primary/20 text-primary/90"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              }`}
            >
              <Clock className="w-2.5 h-2.5" />
              duration
            </button>
            <button
              onClick={() => setSortBy("name")}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                sortBy === "name"
                  ? "bg-primary/20 text-primary/90"
                  : "text-muted-foreground/50 hover:text-muted-foreground"
              }`}
            >
              <FileText className="w-2.5 h-2.5" />
              name
            </button>
          </div>
          <div className="divide-y divide-border/20">
            {sortedSummaries.map((s) => (
              <FileSubRow key={s.fileId} summary={s} maxMs={maxMs} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseSection({ group, maxMs, defaultOpen, extractionFileSummaries, isSlowest }: { group: PhaseGroup; maxMs: number; defaultOpen: boolean; extractionFileSummaries: FileSummary[]; isSlowest?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const isLegacy = group.phase === null;
  return (
    <div className={`rounded-lg border overflow-hidden ${isSlowest ? "border-amber-500/50" : "border-border/60"}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
          ${isLegacy ? "bg-muted/30 hover:bg-muted/50" : isSlowest ? "bg-amber-500/10 hover:bg-amber-500/15" : "bg-primary/5 hover:bg-primary/10"}`}
      >
        <span className={`text-xs font-display font-bold uppercase tracking-wider
          ${isLegacy ? "text-muted-foreground" : isSlowest ? "text-amber-400" : "text-primary/80"}`}>
          {group.label}
        </span>
        <span className="flex-1" />
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold tabular-nums
          ${isLegacy
            ? "bg-muted/60 text-muted-foreground"
            : isSlowest
            ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30"
            : "bg-primary/10 text-primary/90"}`}>
          {formatDuration(group.totalMs)}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground/60 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="px-4 py-1 divide-y divide-border/30">
          {group.steps.map((step) => (
            <TimelineStepRow
              key={step.step}
              step={step}
              maxMs={maxMs}
              fileSummaries={step.step === "extraction" ? extractionFileSummaries : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PhaseBarSegmentProps {
  seg: { label: string; ms: number; pct: number; color: string };
}

function PhaseBarSegment({ seg }: PhaseBarSegmentProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="h-full transition-opacity hover:opacity-80 cursor-default"
          style={{ width: `${seg.pct}%`, backgroundColor: seg.color, minWidth: "2px" }}
        />
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs font-semibold">{seg.label}</div>
        <div className="text-[11px] font-mono text-muted-foreground">{formatDuration(seg.ms)} · {seg.pct.toFixed(1)}%</div>
      </TooltipContent>
    </Tooltip>
  );
}

function ProcessingTimeline({ steps, isLoading }: { steps: ProcessingStep[]; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-border/40 overflow-hidden">
            <div className="h-10 bg-muted/30" />
            <div className="px-4 py-2 space-y-2">
              {[1, 2].map((j) => (
                <div key={j} className="flex items-center gap-3 py-1">
                  <div className="w-52 h-4 rounded bg-muted/50" />
                  <div className="flex-1 h-4 rounded bg-muted/40" />
                  <div className="w-16 h-4 rounded bg-muted/50" />
                  <div className="w-32 h-4 rounded bg-muted/30" />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-between">
          <div className="w-16 h-4 rounded bg-muted/50" />
          <div className="w-20 h-5 rounded bg-muted/50" />
        </div>
      </div>
    );
  }

  // ── Phase overview ─────────────────────────────────────────────────────────
  const completedStepKeys = steps.map((s) => s.step);
  const totalStep = steps.find((s) => s.step === "total");

  // Filter out per-file steps (UUID suffixed) and the total step
  const visibleSteps = steps.filter(
    (s) => s.step !== "total" && !PER_FILE_STEP_RE.test(s.step)
  );

  // Build per-file summaries (grouped by UUID, attached to the "extraction" parent step)
  const extractionFileSummaries = buildFileSummaries(steps);

  // Group steps: check step.phase first (backend-tagged), then resolvePhaseForStep fallback
  const phaseGroupMap = new Map<string, { label: string; steps: ProcessingStep[] }>();
  const legacySteps: ProcessingStep[] = [];
  for (const step of visibleSteps) {
    if (step.phase) {
      const label = getPhaseLabel(step.phase);
      if (!phaseGroupMap.has(step.phase)) phaseGroupMap.set(step.phase, { label, steps: [] });
      phaseGroupMap.get(step.phase)!.steps.push(step);
    } else {
      const resolved = resolvePhaseForStep(step.step);
      if (resolved) {
        const key = `phase-${resolved.id}`;
        const label = `Phase ${resolved.id} — ${resolved.name}`;
        if (!phaseGroupMap.has(key)) phaseGroupMap.set(key, { label, steps: [] });
        phaseGroupMap.get(key)!.steps.push(step);
      } else {
        legacySteps.push(step);
      }
    }
  }

  const groups: PhaseGroup[] = [];
  for (const [phase, { label, steps: phaseSteps }] of [...phaseGroupMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ phase, label, steps: phaseSteps, totalMs: phaseSteps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) });
  }
  if (legacySteps.length > 0) {
    groups.push({ phase: null, label: "Pipeline Steps", steps: legacySteps, totalMs: legacySteps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) });
  }

  const maxMs = Math.max(...visibleSteps.map((s) => s.durationMs ?? 0), 1);

  return (
    <div className="space-y-8">
      {/* Phase overview grid */}
      <div>
        <div className="text-[10px] font-display font-bold uppercase tracking-widest text-muted-foreground mb-3">
          Pipeline Phases
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {PIPELINE_PHASES.map((phase) => {
            const status = derivePhaseStatus(phase, completedStepKeys);
            const badgeClass = phaseColorClasses(phase.color, "badge");
            const borderClass = phaseColorClasses(phase.color, "border");
            const textClass = phaseColorClasses(phase.color, "text");
            const isComplete = status === "complete";
            const isPending = status === "pending";
            const isSkipped = status === "skipped";
            return (
              <div
                key={phase.id}
                title={phase.description}
                className={`relative rounded-lg border p-2.5 transition-all ${
                  isComplete
                    ? `${borderClass} bg-card`
                    : isPending
                    ? "border-border/40 bg-card/50 opacity-50"
                    : isSkipped
                    ? "border-dashed border-border/30 bg-card/20 opacity-35"
                    : "border-border/40 bg-card/50"
                }`}
              >
                <div className="flex items-start justify-between gap-1 mb-1.5">
                  <span className="text-base leading-none">{phase.icon}</span>
                  <span
                    className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded border ${
                      isComplete
                        ? badgeClass
                        : isPending
                        ? "bg-secondary/50 text-muted-foreground/50 border-border/30"
                        : "bg-secondary/30 text-muted-foreground/30 border-border/20"
                    }`}
                  >
                    P{phase.id}
                  </span>
                </div>
                <div
                  className={`text-[10px] font-display font-semibold leading-tight mb-0.5 ${
                    isComplete ? textClass : "text-muted-foreground/50"
                  }`}
                >
                  {phase.shortName}
                </div>
                <div className="text-[9px] font-mono text-muted-foreground/50 leading-tight">
                  {isComplete ? "✓ done" : isPending ? "pending" : isSkipped ? "not built" : "—"}
                </div>
                {phase.taskRef && !isComplete && (
                  <div className="text-[8px] font-mono text-muted-foreground/30 mt-0.5">
                    {phase.taskRef}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Verification Report — shown when Phase 6 "verification" step is present */}
      {(() => {
        const verStep = steps.find((s) => s.step === "verification");
        if (!verStep) return null;
        const d = verStep.details ?? {};
        const passed = d.passed as boolean | undefined;
        const errorDetails = (d.errorDetails as string[] | undefined) ?? [];
        const warningDetails = (d.warningDetails as string[] | undefined) ?? [];
        const questionDetails = (d.questionDetails as string[] | undefined) ?? [];
        const checksPassed = (d.checksPassed as string[] | undefined) ?? [];
        const hasAnyContent = errorDetails.length > 0 || warningDetails.length > 0 || questionDetails.length > 0 || checksPassed.length > 0;
        return (
          <div>
            <div className="text-[10px] font-display font-bold uppercase tracking-widest text-muted-foreground mb-3">
              Verification Report
            </div>
            <div className={`rounded-lg border p-4 space-y-3 ${
              passed
                ? "border-teal-500/30 bg-teal-500/5"
                : errorDetails.length > 0
                  ? "border-red-500/30 bg-red-500/5"
                  : "border-blue-500/30 bg-blue-500/5"
            }`}>
              <div className={`flex items-center gap-2 text-sm font-semibold ${
                passed ? "text-teal-400" : errorDetails.length > 0 ? "text-red-400" : "text-blue-400"
              }`}>
                {passed
                  ? "✓ All checks passed"
                  : errorDetails.length > 0 || warningDetails.length > 0
                    ? `⚠ ${errorDetails.length} error(s), ${warningDetails.length} warning(s)`
                    : `? ${questionDetails.length} question(s) pending`}
              </div>

              {checksPassed.length > 0 && (
                <div className="space-y-1">
                  {checksPassed.map((check) => (
                    <div key={check} className="flex items-start gap-2 text-xs text-teal-400">
                      <span className="shrink-0 font-bold mt-px">✓</span>
                      <span>{check}</span>
                    </div>
                  ))}
                </div>
              )}

              {errorDetails.length > 0 && (
                <div className="space-y-1">
                  {errorDetails.map((err, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-red-400">
                      <span className="shrink-0 font-bold mt-px">✗</span>
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              )}

              {warningDetails.length > 0 && (
                <div className="space-y-1">
                  {warningDetails.map((warn, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-400">
                      <span className="shrink-0 font-bold mt-px">⚠</span>
                      <span>{warn}</span>
                    </div>
                  ))}
                </div>
              )}

              {questionDetails.length > 0 && (
                <div className="border-t border-border/40 pt-3">
                  <div className="text-[10px] font-display font-semibold uppercase tracking-wider text-blue-400 mb-2">
                    Questions for Review
                  </div>
                  <div className="space-y-1">
                    {questionDetails.map((q, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-blue-400">
                        <span className="shrink-0 font-bold mt-px">?</span>
                        <span>{q}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!hasAnyContent && (
                <div className="text-xs text-muted-foreground italic">
                  No room inventory data available — checks V1–V7 will run automatically once Phase 4 &amp; 5 are implemented.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Step Details — collapsible phase sections */}
      {groups.length > 0 && (
        <div>
          <div className="text-[10px] font-display font-bold uppercase tracking-widest text-muted-foreground mb-3">
            Step Details
          </div>
          <div className="space-y-3">
            {(() => {
              const realGroups = groups.filter((g) => g.phase !== null && g.totalMs > 0);
              let slowestGroup: PhaseGroup | null = null;
              if (realGroups.length >= 2) {
                const sorted = [...realGroups].sort((a, b) => b.totalMs - a.totalMs);
                const top = sorted[0];
                const runnerUp = sorted[1];
                const isUnique = top.totalMs > runnerUp.totalMs;
                const isMeaningful = top.totalMs >= runnerUp.totalMs * 1.1;
                if (isUnique && isMeaningful) slowestGroup = top;
              }
              return groups.map((group, i) => (
                <PhaseSection
                  key={group.phase ?? "__legacy__"}
                  group={group}
                  maxMs={maxMs}
                  defaultOpen={i === 0 || groups.length <= 2}
                  extractionFileSummaries={extractionFileSummaries}
                  isSlowest={slowestGroup !== null && group === slowestGroup}
                />
              ));
            })()}
          </div>
          {/* Grand total row + phase breakdown bar */}
          {(() => {
            const grandTotalMs = totalStep?.durationMs ?? groups.reduce((sum, g) => sum + g.totalMs, 0);
            if (grandTotalMs == null) return null;

            const phaseSegments = groups
              .filter((g) => g.totalMs > 0)
              .map((g) => ({
                label: g.label,
                ms: g.totalMs,
                pct: (g.totalMs / grandTotalMs) * 100,
                color: g.phase ? (PHASE_COLOR_HEX[g.phase] ?? PHASE_COLOR_FALLBACK) : PHASE_COLOR_FALLBACK,
              }));

            return (
              <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-xs font-display font-bold uppercase tracking-wider text-foreground/70">
                    Total
                  </span>
                  <span className="flex-1" />
                  {totalStep && (
                    <span className="text-[10px] text-muted-foreground font-mono mr-2">
                      pipeline total
                    </span>
                  )}
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded bg-foreground/10 text-xs font-mono font-bold tabular-nums text-foreground/80">
                    {formatDuration(grandTotalMs)}
                  </span>
                </div>
                {phaseSegments.length > 1 && (
                  <div className="px-4 pb-3 space-y-2">
                    {/* Stacked bar */}
                    <TooltipProvider>
                      <div className="flex h-3 w-full rounded overflow-hidden gap-px">
                        {phaseSegments.map((seg, i) => (
                          <PhaseBarSegment key={i} seg={seg} />
                        ))}
                      </div>
                    </TooltipProvider>
                    {/* Legend */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {phaseSegments.map((seg, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span
                            className="inline-block w-2 h-2 rounded-sm shrink-0"
                            style={{ backgroundColor: seg.color }}
                          />
                          <span className="truncate max-w-[14rem]">{seg.label}</span>
                          <span className="font-mono tabular-nums text-foreground/50">
                            {seg.pct.toFixed(0)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Decisions Log (Phase 5 — Rules R1–R15) ──────────────────────────── */}
      {(() => {
        const ruleStep = steps.find((s) => s.step === "rule_application");
        const decisionsLog = ruleStep?.details?.decisionsLog as string[] | undefined;
        const questions = ruleStep?.details?.questionsForVerification as string[] | undefined;
        const errors = ruleStep?.details?.verificationErrors as string[] | undefined;
        const totalRooms = ruleStep?.details?.totalRooms as number | undefined;
        const totalSigns = ruleStep?.details?.totalSignsAssigned as number | undefined;

        if (!ruleStep) return null;

        return (
          <div>
            <div className="text-[10px] font-display font-bold uppercase tracking-widest text-muted-foreground mb-3">
              Decisions Log — Phase 5 (Rules R1–R15)
            </div>
            {totalRooms != null && totalSigns != null && (
              <div className="flex gap-4 text-xs font-mono text-foreground/60 mb-3">
                <span>{totalRooms} room{totalRooms !== 1 ? "s" : ""} inventoried</span>
                <span>·</span>
                <span>{totalSigns} sign assignment{totalSigns !== 1 ? "s" : ""}</span>
              </div>
            )}
            {decisionsLog && decisionsLog.length > 0 && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-foreground/60 mb-1.5">
                  Sign Assignments ({decisionsLog.length})
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-0.5">
                  {decisionsLog.map((entry, i) => (
                    <div key={i} className="text-[11px] font-mono text-foreground/65 leading-snug">{entry}</div>
                  ))}
                </div>
              </div>
            )}
            {questions && questions.length > 0 && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-amber-400/80 mb-1.5">
                  ⚠ Questions for Verification ({questions.length})
                </div>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-amber-400/25 bg-amber-400/5 p-2.5 space-y-1">
                  {questions.map((q, i) => (
                    <div key={i} className="text-[11px] text-amber-300/80 leading-snug">• {q}</div>
                  ))}
                </div>
              </div>
            )}
            {errors && errors.length > 0 && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-red-400/80 mb-1.5">
                  ✗ Verification Errors ({errors.length})
                </div>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-red-400/25 bg-red-400/5 p-2.5 space-y-1">
                  {errors.map((e, i) => (
                    <div key={i} className="text-[11px] text-red-300/80 leading-snug">• {e}</div>
                  ))}
                </div>
              </div>
            )}
            {(!decisionsLog?.length && !questions?.length && !errors?.length) && (
              <div className="text-xs text-muted-foreground/50 italic">
                No rule engine output recorded for this job. Re-run extraction to populate.
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
}

function parseTabParam(search: string): "table" | "sheets" | "summary" | "floorplans" | "signpages" | "specs" | "timeline" | "coords" | "ai_scans" | null {
  const p = new URLSearchParams(search);
  const t = p.get("tab");
  if (t === "signs") return "table";
  const valid = ["table", "sheets", "summary", "floorplans", "signpages", "specs", "timeline", "coords", "ai_scans"] as const;
  return (valid as readonly string[]).includes(t ?? "") ? (t as ReturnType<typeof parseTabParam>) : null;
}

export default function JobDetails() {
  const [, params] = useRoute("/jobs/:jobId");
  const jobId = params?.jobId || "";
  const search = useSearch();
  
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
      downloadExport(jobId).catch((err) => console.error("Export failed:", err));
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
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [summaryFilter, setSummaryFilter] = useState<null | "flagged">(null);
  const [activeTab, setActiveTab] = useState<"table" | "sheets" | "summary" | "floorplans" | "signpages" | "specs" | "timeline" | "coords" | "ai_scans">(() => parseTabParam(search) ?? "table");
  useEffect(() => {
    const parsed = parseTabParam(search);
    if (parsed) setActiveTab(parsed);
  }, [search]);
  const [showAiHighlight, setShowAiHighlight] = useState(false);

  const PROCESSING_TIMEOUT_SECONDS = 5 * 60;
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const isProcessingNow = (data?.job?.status === "processing") || extractMutation.isPending;
  useEffect(() => {
    if (!isProcessingNow) { setProcessingSeconds(0); return; }
    const id = setInterval(() => setProcessingSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isProcessingNow]);

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

  const { job, files, totalSigns, flaggedCount, highConfidenceCount } = data;

  // Derive verification badge from the job's processing log (Phase 6 step)
  const jobProcessingLog = (job as Record<string, unknown>).processingLog as Array<{ step: string; details?: Record<string, unknown> }> | null | undefined;
  const verificationStep = jobProcessingLog?.find((s) => s.step === "verification");
  const verificationBadge = verificationStep
    ? {
        passed: (verificationStep.details?.passed as boolean) ?? true,
        issues:
          ((verificationStep.details?.errors as number) ?? 0) +
          ((verificationStep.details?.warnings as number) ?? 0) +
          ((verificationStep.details?.questions as number) ?? 0),
      }
    : null;

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
                {job.projectName && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground font-mono">
                    <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                    {job.projectName}
                  </span>
                )}
                {job.jurisdiction && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground font-mono">
                    <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                    {job.jurisdiction}
                  </span>
                )}
                {job.issueDate && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground font-mono">
                    <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                    {job.issueDate}
                  </span>
                )}
                {job.drawingIndexPageNum != null && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground font-mono" title="Drawing index page">
                    <Layers className="w-3.5 h-3.5 flex-shrink-0" />
                    Index p.{job.drawingIndexPageNum}
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
                        <Button
                          onClick={handleExportMarkedPdf}
                          disabled={exportingPdf}
                          variant="outline"
                          className="font-display font-semibold uppercase tracking-wide hover:bg-primary/10 hover:text-primary hover:border-primary/40"
                        >
                          {exportingPdf ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Stamp className="w-4 h-4" />
                          )}
                          {exportingPdf ? "Building PDF…" : "Export Marked PDF"}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Download the original PDF with sign markers drawn on each floor plan page</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Button
                    onClick={handleExport}
                    className="font-display font-semibold uppercase tracking-wide bg-accent text-accent-foreground hover:bg-accent/90 shadow-[0_0_15px_rgba(0,240,255,0.15)]"
                  >
                    <Download className="w-4 h-4" />
                    Export XLSX
                  </Button>
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
              <div className="flex-none px-4 pt-3 pb-2 max-w-7xl mx-auto w-full grid grid-cols-2 md:grid-cols-4 gap-3">
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
                    {verificationBadge && (
                      <span className={`ml-0.5 text-[9px] font-mono px-1 py-px rounded border ${
                        verificationBadge.passed
                          ? "bg-teal-500/10 text-teal-400 border-teal-500/30"
                          : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                      }`}>
                        {verificationBadge.passed ? "✓ Verified" : `⚠ ${verificationBadge.issues}`}
                      </span>
                    )}
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
                </div>
              </div>

              {activeTab === "floorplans" ? (
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
                  files={files as FileWithInventory[]}
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
                      if (isProcessingNow && (!jobLog || jobLog.length === 0)) {
                        return <ProcessingTimeline steps={[]} isLoading />;
                      }
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
              ) : (
                <>
                  {/* Data Table Container */}
                  <div className="flex-1 overflow-auto bg-card border-t border-border">
                {/* Filter bar — exceptions toggle + hidden toggle */}
                {(hiddenSigns.length > 0 || exceptionSigns.length > 0) && (
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
                          className={`
                            hover:bg-secondary/40 transition-colors
                            ${sign.reviewFlag ? 'bg-primary/5' : ''}
                            ${idx % 2 === 0 ? '' : 'bg-card/30'}
                            ${isAiRow ? 'border-l-2 border-violet-500' : ''}
                          `}
                          style={isAiRow ? { boxShadow: 'inset 3px 0 0 rgba(139, 92, 246, 0.6)', background: 'rgba(139, 92, 246, 0.04)' } : undefined}
                        >
                          <td className="data-cell sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                            <span className="text-xs font-semibold text-foreground">
                              {sign.signIdentifier || '—'}
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
                            <span className="text-xs font-semibold text-muted-foreground line-through">
                              {sign.signIdentifier || '—'}
                            </span>
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
        />
      )}

      {specViewer && (
        <SignSpecModal
          jobId={jobId}
          fileId={specViewer.fileId}
          fileName={specViewer.fileName}
          specPages={specViewer.specPages}
          plaqueTable={(data?.job as unknown as { plaqueTable?: PlaqueTableData | null })?.plaqueTable ?? null}
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
// Augment with Phase 4 field that is returned by the API but not yet in the generated client types.
// Remove this augmentation once the API client is regenerated from the updated OpenAPI spec.
type FileWithInventory = FileWithStats & { roomInventory?: RoomInventoryData | null };
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

// ─── PAGE MANIFEST TABLE ──────────────────────────────────────────────────────

type ManifestRow = {
  pdfPage: number;
  sheetTitle: string;
  bucket: string;
  source: string;
  level: string | null;
  area: string | null;
};

function buildFallbackRows(stats: RawPageStats): ManifestRow[] {
  const rows: ManifestRow[] = [];
  const fp = stats.floorPlanPages ?? [];
  const ss = stats.signSchedulePages ?? [];
  const both = (stats as unknown as Record<string, unknown>).bothPages as number[] ?? [];
  const other = (stats as unknown as Record<string, unknown>).otherPages as number[] ?? [];

  const allFp = fp.filter((p) => !both.includes(p));
  const allSs = ss.filter((p) => !both.includes(p));

  for (const p of allFp) rows.push({ pdfPage: p, sheetTitle: "", bucket: "floor_plan", source: "inferred", level: null, area: null });
  for (const p of allSs) rows.push({ pdfPage: p, sheetTitle: "", bucket: "signage_schedule", source: "inferred", level: null, area: null });
  for (const p of both) rows.push({ pdfPage: p, sheetTitle: "", bucket: "floor_plan + signage", source: "inferred", level: null, area: null });
  for (const p of other) rows.push({ pdfPage: p, sheetTitle: "", bucket: "other", source: "inferred", level: null, area: null });

  rows.sort((a, b) => a.pdfPage - b.pdfPage);
  return rows;
}

const BUCKET_CLASS: Record<string, string> = {
  floor_plan: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "floor_plan + signage": "bg-violet-500/15 text-violet-400 border-violet-500/30",
  signage_schedule: "bg-accent/15 text-accent border-accent/30",
  life_safety: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  key_plan: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  general_notes: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  accessibility: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  millwork_interiors: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  specifications: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  ignore: "bg-red-500/15 text-red-400 border-red-500/30",
  other: "bg-secondary text-muted-foreground border-border",
  inferred: "bg-secondary text-muted-foreground border-border",
};

const BUCKET_DOT: Record<string, string> = {
  floor_plan: "🟢",
  "floor_plan + signage": "🟣",
  signage_schedule: "🟡",
  life_safety: "🟠",
  key_plan: "🔵",
  general_notes: "⬜",
  accessibility: "🟣",
  millwork_interiors: "🔷",
  specifications: "🔹",
  ignore: "🔴",
  other: "⬜",
  inferred: "~",
};

function sourceBadgeLabel(source: string): string {
  switch (source) {
    case "bookmark": return "📌 Bookmark";
    case "title_block": return "🔍 Title Block";
    case "full_page_fallback": return "📄 Full Page";
    case "excerpt_fallback": return "📄 Excerpt";
    default: return "~ Inferred";
  }
}

function primarySourceBadge(rows: ManifestRow[]): string {
  if (rows.length === 0) return "~ Inferred";
  const sources = new Set(rows.map((r) => r.source));
  if (sources.size === 1) {
    const src = [...sources][0];
    if (src === "bookmark") return "📌 Bookmarks";
    if (src === "title_block") return "🔍 Title Block";
    if (src === "full_page_fallback" || src === "excerpt_fallback") return "📄 Full Page Scan";
  }
  // Mixed sources — show the dominant one with a modifier
  if (sources.has("bookmark")) return "📌 Bookmarks";
  if (sources.has("title_block")) return "🔍 Title Block";
  if (sources.has("full_page_fallback") || sources.has("excerpt_fallback")) return "📄 Full Page Scan";
  return "~ Inferred";
}

const BUCKET_LABEL: Record<string, string> = {
  floor_plan: "Floor Plans",
  "floor_plan + signage": "Floor Plan + Signage",
  signage_schedule: "Sign Schedules",
  life_safety: "Life Safety",
  key_plan: "Key Plans",
  general_notes: "General Notes",
  accessibility: "Accessibility",
  millwork_interiors: "Millwork / Interiors",
  specifications: "Specifications",
  ignore: "Ignored",
  other: "Other",
  inferred: "Inferred",
};

function PageManifestTable({
  stats,
  fileId,
  jobId,
  originalName,
}: {
  stats: FileWithStats["pageStats"];
  fileId: string;
  jobId: string;
  originalName: string;
}) {
  const [open, setOpen] = useState(false);
  const [filterBucket, setFilterBucket] = useState<string | null>(null);

  if (!stats) return null;

  const statsAny = stats as unknown as Record<string, unknown>;
  const manifestRows: ManifestRow[] = statsAny.manifest as ManifestRow[] ?? [];
  const warnings: string[] = stats.manifestWarnings ?? [];
  const isExcerpt = stats.isExcerpt === true;

  const fallbackRows = buildFallbackRows(stats);
  const rows = manifestRows.length > 0 ? manifestRows : fallbackRows;

  if (rows.length === 0) return null;

  const hasManifest = manifestRows.length > 0;

  const fpCount = rows.filter((r) => r.bucket === "floor_plan" || r.bucket === "floor_plan + signage").length;
  const ssCount = rows.filter((r) => r.bucket === "signage_schedule" || r.bucket === "floor_plan + signage").length;
  const sourceSummary = hasManifest ? primarySourceBadge(rows) : "~ Inferred";

  // Unique buckets and per-bucket counts computed in a single pass
  const bucketCounts = new Map<string, number>();
  for (const row of rows) {
    bucketCounts.set(row.bucket, (bucketCounts.get(row.bucket) ?? 0) + 1);
  }
  const presentBuckets = Array.from(bucketCounts.keys());

  const filteredRows = filterBucket ? rows.filter((r) => r.bucket === filterBucket) : rows;

  return (
    <div className="mt-3 pt-2 border-t border-border/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        {open
          ? <ChevronDown className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
        }
        <span className="text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">
          All Pages
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/60">
          {rows.length} pages · {fpCount} floor plan{fpCount !== 1 ? "s" : ""} · {ssCount} sign schedule{ssCount !== 1 ? "s" : ""}
        </span>
        <span className="ml-1 text-[10px] font-mono text-muted-foreground/50">{sourceSummary}</span>
      </button>

      {open && (
        <div className="mt-2">
          {isExcerpt && (
            <div className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-1 mb-1">
              📄 This upload appears to be a plan excerpt — some reference sheets may be missing.
            </div>
          )}
          {warnings.map((w) => (
            <div key={w} className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 mb-1">
              ⚠ {w}
            </div>
          ))}

          {/* Filter pills — only shown when more than one bucket is present */}
          {presentBuckets.length > 1 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {presentBuckets.map((bucket) => {
                const bucketKey = bucket in BUCKET_CLASS ? bucket : "other";
                const dot = BUCKET_DOT[bucketKey] ?? "⬜";
                const count = bucketCounts.get(bucket) ?? 0;
                const label = BUCKET_LABEL[bucket] ?? "Other";
                const isActive = filterBucket === bucket;
                const activeStyles = isActive
                  ? BUCKET_CLASS[bucketKey] ?? BUCKET_CLASS.other
                  : "bg-secondary/60 text-muted-foreground border-border hover:border-border/80 hover:bg-secondary";
                return (
                  <button
                    key={bucket}
                    onClick={() => setFilterBucket(isActive ? null : bucket)}
                    aria-pressed={isActive}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider transition-colors ${activeStyles}`}
                  >
                    {dot} {label} <span className="font-mono font-normal opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="max-h-96 overflow-y-auto rounded border border-border/60">
            <table className="w-full text-left border-collapse text-[10px] font-mono">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Pg</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Sheet Title</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Classification</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Source</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Level</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, i) => {
                  const bucketKey = row.bucket in BUCKET_CLASS ? row.bucket : "other";
                  const dot = BUCKET_DOT[bucketKey] ?? "⬜";
                  const pillCls = BUCKET_CLASS[bucketKey] ?? BUCKET_CLASS.other;
                  const displayBucket = row.source === "inferred" ? `~ ${row.bucket}` : row.bucket;
                  return (
                    <tr
                      key={`${row.pdfPage}-${i}`}
                      className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? "" : "bg-secondary/30"}`}
                    >
                      <td className="px-2 py-1 font-mono">
                        <button
                          onClick={() => openPdfInNewTab(jobId, fileId, `page-${row.pdfPage}.pdf`, row.pdfPage).catch(() => {})}
                          title={`Open PDF at page ${row.pdfPage}`}
                          className="text-primary/70 hover:text-primary underline underline-offset-2 transition-colors"
                        >
                          {row.pdfPage}
                        </button>
                      </td>
                      <td className="px-2 py-1 text-foreground/80 max-w-[160px] truncate font-mono" title={row.sheetTitle || undefined}>
                        {row.sheetTitle || "—"}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-0.5 px-1.5 py-px rounded border text-[9px] font-bold uppercase tracking-wider ${pillCls}`}>
                          {dot} {displayBucket}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground whitespace-nowrap font-mono text-[9px]">
                        {sourceBadgeLabel(row.source)}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground font-mono">
                        {row.level || "—"}
                      </td>
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

// ─── ROOM INVENTORY PANEL ─────────────────────────────────────────────────────

interface RoomRecord {
  roomNumber: string | null;
  roomName: string;
  level: string;
  pdfPage: number;
  occupantLoad: number | null;
  occupancyGroup: string | null;
  isRestroom: boolean;
  isStair: boolean;
  isElevator: boolean;
  isVestibule: boolean;
  isCorridorOrHall: boolean;
  isVehicleBay: boolean;
  isMepUnoccupied: boolean;
  isVariableUse: boolean;
  isPublicFacing: boolean;
  isStaffOnly: boolean;
  isAssembly: boolean;
  extractionConfidence: number;
  aiEnriched?: boolean;
}

interface RoomInventoryData {
  rooms: RoomRecord[];
  occupantLoadTableFound: boolean;
  warnings: string[];
  sourcePages: number[];
}

function RoomFlagChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border-emerald-500/25 whitespace-nowrap">
      {label}
    </span>
  );
}

function roomFlags(r: RoomRecord): string[] {
  const flags: string[] = [];
  if (r.isRestroom) flags.push("Restroom");
  if (r.isStair) flags.push("Stair");
  if (r.isElevator) flags.push("Elevator");
  if (r.isVestibule) flags.push("Vestibule");
  if (r.isCorridorOrHall) flags.push("Corridor");
  if (r.isVehicleBay) flags.push("Vehicle Bay");
  if (r.isMepUnoccupied) flags.push("MEP");
  if (r.isVariableUse) flags.push("Variable Use");
  if (r.isPublicFacing) flags.push("Public");
  if (r.isStaffOnly) flags.push("Staff Only");
  if (r.isAssembly) flags.push("Assembly");
  return flags;
}

function RoomInventoryPanel({ inventory }: { inventory: RoomInventoryData }) {
  const [open, setOpen] = useState(false);
  const { rooms, occupantLoadTableFound, warnings } = inventory;

  if (rooms.length === 0) return null;

  const restroomCount = rooms.filter((r) => r.isRestroom).length;
  const stairCount = rooms.filter((r) => r.isStair).length;
  const elevatorCount = rooms.filter((r) => r.isElevator).length;
  const assemblyCount = rooms.filter((r) => r.isAssembly).length;
  const corridorCount = rooms.filter((r) => r.isCorridorOrHall).length;

  return (
    <div className="mt-3 pt-2 border-t border-border/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        {open
          ? <ChevronDown className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
        }
        <span className="text-[10px] font-display font-bold uppercase tracking-wider text-emerald-400">
          Room Inventory
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/60">
          {rooms.length} rooms
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/45">·</span>
        {restroomCount > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground/60">{restroomCount} restroom{restroomCount !== 1 ? "s" : ""}</span>
        )}
        {stairCount > 0 && (
          <>
            <span className="text-[10px] font-mono text-muted-foreground/45">·</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">{stairCount} stair{stairCount !== 1 ? "s" : ""}</span>
          </>
        )}
        {elevatorCount > 0 && (
          <>
            <span className="text-[10px] font-mono text-muted-foreground/45">·</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">{elevatorCount} elevator{elevatorCount !== 1 ? "s" : ""}</span>
          </>
        )}
        {assemblyCount > 0 && (
          <>
            <span className="text-[10px] font-mono text-muted-foreground/45">·</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">{assemblyCount} assembly</span>
          </>
        )}
        {corridorCount > 0 && (
          <>
            <span className="text-[10px] font-mono text-muted-foreground/45">·</span>
            <span className="text-[10px] font-mono text-muted-foreground/60">{corridorCount} corridor{corridorCount !== 1 ? "s" : ""}</span>
          </>
        )}
        {occupantLoadTableFound && (
          <span className="ml-1 text-[9px] font-mono text-emerald-400/60 bg-emerald-500/10 border border-emerald-500/20 px-1 rounded">occ loads ✓</span>
        )}
      </button>

      {open && (
        <div className="mt-2">
          {warnings.length > 0 && (
            <div className="mb-1 space-y-0.5">
              {warnings.slice(0, 3).map((w, i) => (
                <div key={i} className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                  ⚠ {w}
                </div>
              ))}
              {warnings.length > 3 && (
                <div className="text-[10px] text-muted-foreground/50 font-mono px-2">
                  +{warnings.length - 3} more warnings
                </div>
              )}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto rounded border border-border/60">
            <table className="w-full text-left border-collapse text-[10px] font-mono">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Room #</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Name</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Level</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground">Flags</th>
                  <th className="px-2 py-1 text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Occ Load</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room, i) => {
                  const flags = roomFlags(room);
                  return (
                    <tr
                      key={`${room.roomName}-${room.roomNumber}-${i}`}
                      className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? "" : "bg-secondary/30"}`}
                    >
                      <td className="px-2 py-1 text-muted-foreground font-mono">
                        {room.roomNumber ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-foreground/80 max-w-[140px] truncate font-mono" title={room.roomName}>
                        {room.roomName}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground font-mono">
                        {room.level}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex flex-wrap gap-0.5 items-center">
                          {room.aiEnriched && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-wider bg-violet-500/10 text-violet-400 border-violet-500/25 whitespace-nowrap">
                              AI
                            </span>
                          )}
                          {flags.length > 0 ? (
                            flags.map((f) => <RoomFlagChip key={f} label={f} />)
                          ) : (
                            !room.aiEnriched && <span className="text-muted-foreground/40">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground font-mono">
                        {room.occupantLoad != null ? room.occupantLoad : "—"}
                      </td>
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

function SheetsPanel({
  files,
  onOpenSpec,
  allSigns,
  hiddenSigns,
  toggleHidden,
  jobId,
  toggleRejectedPage,
}: {
  files: FileWithInventory[];
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
    const psAny = f.pageStats as unknown as Record<string, unknown> | null | undefined;
    const both = psAny?.bothPages instanceof Array ? (psAny.bothPages as number[]).length : 0;
    return sum + ss + both;
  }, 0);
  const totalFloorPlan = files.reduce((sum, f) => sum + (f.pageStats?.floorPlanPages?.length ?? 0), 0);

  // Collect all manifest warnings across all files (deduplicated)
  const allManifestWarnings = Array.from(new Set(
    files.flatMap((f) => f.pageStats?.manifestWarnings ?? [])
  ));

  // Find the first file that has sign spec pages (sign schedule OR both)
  const firstSpecFile = files.find(
    (f) => (f.pageStats?.signSchedulePages?.length ?? 0) > 0 ||
      (((f.pageStats as unknown as Record<string, unknown>)?.bothPages as number[] | undefined)?.length ?? 0) > 0
  );

  // Build the combined spec page list for a given file's pageStats
  const getSpecPages = (stats: NonNullable<typeof firstSpecFile>["pageStats"]): number[] => {
    const ss = stats?.signSchedulePages ?? [];
    const both = (stats as unknown as Record<string, unknown>)?.bothPages as number[] | undefined ?? [];
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
            {allManifestWarnings.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wider">
                ⚠ {allManifestWarnings.length} {allManifestWarnings.length === 1 ? "Warning" : "Warnings"}
              </span>
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
            {allManifestWarnings.length > 0 && (
              <div className="flex flex-col gap-1">
                {allManifestWarnings.map((w) => (
                  <div
                    key={w}
                    className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-400"
                  >
                    <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1.5a.5.5 0 0 1 .447.276l6 12A.5.5 0 0 1 14 14.5H2a.5.5 0 0 1-.447-.724l6-12A.5.5 0 0 1 8 1.5zM8 5.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 1 0V6a.5.5 0 0 0-.5-.5zm0 6a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"/>
                    </svg>
                    <span className="text-xs">{w}</span>
                  </div>
                ))}
              </div>
            )}
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

                      {/* All Pages manifest table */}
                      <PageManifestTable
                        stats={f.pageStats}
                        fileId={f.id}
                        jobId={jobId}
                        originalName={f.originalName}
                      />

                      {/* Room Inventory — Phase 4 */}
                      {(() => {
                        const ri = f.roomInventory;
                        if (!ri || ri.rooms.length === 0) return null;
                        return <RoomInventoryPanel inventory={ri} />;
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
