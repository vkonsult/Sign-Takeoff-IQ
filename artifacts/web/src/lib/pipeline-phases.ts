/**
 * SignTakeoff IQ — Pipeline Phase Definitions
 *
 * Maps the 6 phases from SignTakeoff System Prompt v1.1 to concrete pipeline
 * step keys emitted by the backend via recordStep(). Used by the Timeline UI
 * to group steps into phases and show per-phase status.
 *
 * LEGACY MAPPING: each phase lists the old step keys it supersedes so the UI
 * can correctly classify steps from jobs processed before the new pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 — Intake
 *   New step keys:  intake_project_info, intake_building_type
 *   Legacy keys:    project_info, spec_processing
 *   Replaces:       ad-hoc project metadata extraction scattered through the
 *                   spatial pre-pass.  New: explicit cover-sheet + index parse.
 *
 * Phase 2 — Sheet Manifest (was: spatial pre-pass)
 *   New step keys:  sheet_manifest_<fileId>, sheet_manifest_ai_fallback_<fileId>
 *   Legacy keys:    spatial_prepass_<fileId>
 *   Replaces:       3-bucket rule set (floor_plan / sign_schedule / other).
 *                   New: 10-bucket cascade with AI fallback for "other" pages.
 *
 * Phase 3 — Sign Schedule Extraction (was: sign schedule parse inside text_extraction)
 *   New step keys:  sign_schedule_extract_<fileId>, sign_schedule_enrich_<fileId>
 *   Legacy keys:    text_extraction_<fileId> (sign_schedule pages only),
 *                   visual_verification_<fileId>
 *   Replaces:       signage-schedule-parser.ts called inside the main text
 *                   extraction loop. New: dedicated Gemini visual read of
 *                   rasterized schedule pages + structured plaque table output.
 *
 * Phase 4 — Room Inventory (NEW — no equivalent in legacy pipeline)
 *   New step keys:  room_inventory_<fileId>, occupant_loads_<fileId>
 *   Legacy keys:    (none — this capability did not exist)
 *   Replaces:       Nothing. Adds: systematic room label extraction from
 *                   floor plan pages, occupant load cross-reference via
 *                   Gemini-first image extraction (Phase 4b), and
 *                   room-flag derivation (is_restroom, is_stair, etc.)
 *
 * Phase 5 — Apply Rules R1-R15 (was: extraction-heuristic + extraction-classification)
 *   New step keys:  rule_application, rule_application_<fileId>
 *   Legacy keys:    extraction, word_match, text_extraction_<fileId>,
 *                   visual_verification_<fileId>
 *   Replaces:       extraction-heuristic.ts + extraction-classification.ts
 *                   keyword/regex sign detection. New: deterministic R1-R15
 *                   rule engine operating on room_inventory output.
 *
 * Phase 6 — Verify & Output (was: deduplication + db_insert)
 *   New step keys:  verification, output_db_insert
 *   Legacy keys:    deduplication, db_insert, bbox_persist
 *   Replaces:       Simple dedup by location string. New: mandatory checks
 *                   (every room accounted for, stair/elevator counts correct,
 *                   EXIT count ≥ IBC requirement) before writing final results.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type PhaseStatus = "complete" | "running" | "pending" | "skipped";

export interface PipelinePhaseStep {
  /** Exact step key or prefix (matched via startsWith) */
  key: string;
  /** Whether this is a prefix match (true) or exact match (false) */
  prefix?: boolean;
}

export interface PipelinePhase {
  id: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  shortName: string;
  description: string;
  icon: string;
  color: string;
  /** Step keys / prefixes that belong to this phase in the NEW pipeline */
  stepKeys: PipelinePhaseStep[];
  /** Step keys / prefixes from the OLD pipeline that map to this phase */
  legacyStepKeys: PipelinePhaseStep[];
  /** Which legacy modules / files are replaced (for documentation) */
  legacyModulesReplaced: string[];
  /** Which new module / function implements this phase */
  newModule: string | null;
  /** Task reference that implements this phase (e.g. "#338") */
  taskRef: string | null;
}

export const PIPELINE_PHASES: PipelinePhase[] = [
  {
    id: 1,
    name: "Intake",
    shortName: "Intake",
    description:
      "Read the drawing index, identify project name / jurisdiction / level count, classify building type.",
    icon: "📋",
    color: "blue",
    stepKeys: [
      { key: "intake_project_info" },
      { key: "intake_building_type" },
      { key: "spec_processing" },
    ],
    legacyStepKeys: [
      { key: "project_info" },
      { key: "spec_processing" },
    ],
    legacyModulesReplaced: [],
    newModule: null,
    taskRef: "#344",
  },
  {
    id: 2,
    name: "Sheet Manifest",
    shortName: "Classification",
    description:
      "Classify every PDF page into one of 10 buckets (floor_plan, signage_schedule, life_safety, …) using a 3-pass rule cascade plus an AI fallback for unclassified pages.",
    icon: "🗂️",
    color: "violet",
    stepKeys: [
      { key: "sheet_manifest_", prefix: true },
      { key: "sheet_manifest_ai_fallback_", prefix: true },
    ],
    legacyStepKeys: [
      { key: "spatial_prepass_", prefix: true },
    ],
    legacyModulesReplaced: [
      "pdf-words.ts → classifyPageFromPhrases()",
      "pdf-processor.ts → spatial pre-pass block (~lines 162-370)",
    ],
    newModule: "sheet-manifest.ts → buildSheetManifest()",
    taskRef: "#338",
  },
  {
    id: 3,
    name: "Sign Schedule Extraction",
    shortName: "Sign Schedule",
    description:
      "Gemini visual-reads rasterized signage schedule pages to produce a structured plaque table: identifier, display name, letter height, braille, insert, and trigger condition.",
    icon: "📑",
    color: "amber",
    stepKeys: [
      { key: "sign_schedule_extract_", prefix: true },
      { key: "sign_schedule_enrich_", prefix: true },
    ],
    legacyStepKeys: [
      { key: "text_extraction_", prefix: true },
      { key: "visual_verification_", prefix: true },
    ],
    legacyModulesReplaced: [
      "signage-schedule-parser.ts (text extraction path)",
      "ai-processor.ts → sign_schedule_enrich (on-demand only → now in-pipeline)",
    ],
    newModule: "sign-schedule-extractor.ts → extractSignSchedule()",
    taskRef: "#356",
  },
  {
    id: 4,
    name: "Room Inventory",
    shortName: "Room Inventory",
    description:
      "Read every room label from floor plan pages, cross-reference occupant loads, and derive flags: is_restroom, is_stair, is_elevator, is_corridor, is_assembly, is_mep_unoccupied.",
    icon: "🏛️",
    color: "emerald",
    stepKeys: [
      { key: "room_inventory_", prefix: true },
      { key: "room_inventory_ai_", prefix: true },
      { key: "occupant_loads", prefix: false },
      { key: "occupant_loads_", prefix: true },
    ],
    legacyStepKeys: [],
    legacyModulesReplaced: [
      "No equivalent in legacy pipeline — new capability",
    ],
    newModule: "room-inventory.ts → buildRoomInventory() + enrichAmbiguousRoomsWithAI()",
    taskRef: "#357",
  },
  {
    id: 5,
    name: "Apply Rules R1–R15",
    shortName: "Apply Rules",
    description:
      "Apply the 15 sign assignment rules to each room in the inventory: Room ID (R1), restrooms (R7-R8), EXIT (R9), capacity (R10), stair/elevator (R11-R12), evacuation map (R13), directory (R14).",
    icon: "⚡",
    color: "orange",
    stepKeys: [
      { key: "rule_application" },
      { key: "rule_application_", prefix: true },
    ],
    legacyStepKeys: [
      { key: "extraction" },
      { key: "word_match" },
      { key: "text_extraction_", prefix: true },
    ],
    legacyModulesReplaced: [
      "extraction-heuristic.ts → extractSignsHeuristic()",
      "extraction-classification.ts → classifySign()",
      "pdf-processor.ts → sign extraction loop",
    ],
    newModule: "rule-engine.ts → applySignRules()",
    taskRef: "#360",
  },
  {
    id: 6,
    name: "Verify & Output",
    shortName: "Verify",
    description:
      "Mandatory pre-output checks: every room accounted for, stair plaque total = stairs × levels, EXIT count ≥ IBC Table 1006.3, 'In Case of Fire' = elevator count. Writes verified results to DB.",
    icon: "✅",
    color: "teal",
    stepKeys: [
      { key: "verification" },
      { key: "output_db_insert" },
    ],
    legacyStepKeys: [
      { key: "deduplication" },
      { key: "db_insert" },
      { key: "bbox_persist" },
    ],
    legacyModulesReplaced: [
      "pdf-processor.ts → deduplication block",
      "pdf-processor.ts → db_insert block",
    ],
    newModule: "verifier.ts → verifyRuleEngineResult()",
    taskRef: "#372",
  },
];

/**
 * Resolve which phase a given step key belongs to.
 * Checks new stepKeys first, then legacyStepKeys.
 * Returns null if the step doesn't belong to any phase (e.g. "total").
 */
export function resolvePhaseForStep(stepKey: string): PipelinePhase | null {
  for (const phase of PIPELINE_PHASES) {
    for (const sk of [...phase.stepKeys, ...phase.legacyStepKeys]) {
      if (sk.prefix ? stepKey.startsWith(sk.key) : stepKey === sk.key) {
        return phase;
      }
    }
  }
  return null;
}

/**
 * Derive the status of a phase given the set of completed step keys from a job log.
 * - "complete"  → at least one step for this phase is present in the log
 * - "skipped"   → phase has no new stepKeys defined yet (taskRef is null) and
 *                 no legacy steps matched either — phase not yet built
 * - "pending"   → phase has stepKeys defined but none are in the log yet
 *                 (job hasn't reached this phase yet)
 * - "running"   → reserved for real-time use (not computed here)
 */
export function derivePhaseStatus(
  phase: PipelinePhase,
  completedStepKeys: string[],
): PhaseStatus {
  const allKeys = [...phase.stepKeys, ...phase.legacyStepKeys];
  const hasAny = completedStepKeys.some((ck) =>
    allKeys.some((sk) => (sk.prefix ? ck.startsWith(sk.key) : ck === sk.key))
  );
  if (hasAny) return "complete";
  if (phase.taskRef === null) return "skipped";
  return "pending";
}

/**
 * Hex color values for each Tailwind color name used by PIPELINE_PHASES.
 * Single source of truth — add new colors here when new phases are introduced.
 */
const TAILWIND_COLOR_HEX: Record<string, string> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  emerald: "#10b981",
  orange: "#f97316",
  teal: "#14b8a6",
};

/** Fallback hex used when a phase has no colour mapping (e.g. legacy/unknown). */
export const PHASE_COLOR_FALLBACK = "#6b7280";

/**
 * Hex color keyed by phase label string ("phase-1" … "phase-6").
 * Derived from PIPELINE_PHASES so it can never drift out of sync.
 */
export const PHASE_COLOR_HEX: Record<string, string> = Object.fromEntries(
  PIPELINE_PHASES.map((p) => [
    `phase-${p.id}`,
    TAILWIND_COLOR_HEX[p.color] ?? PHASE_COLOR_FALLBACK,
  ])
);

/** Color utility — returns Tailwind classes for each phase color */
export function phaseColorClasses(color: string, variant: "badge" | "bar" | "border" | "text") {
  const map: Record<string, Record<string, string>> = {
    blue: {
      badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
      bar: "bg-blue-500",
      border: "border-blue-500/40",
      text: "text-blue-400",
    },
    violet: {
      badge: "bg-violet-500/15 text-violet-400 border-violet-500/30",
      bar: "bg-violet-500",
      border: "border-violet-500/40",
      text: "text-violet-400",
    },
    amber: {
      badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      bar: "bg-amber-500",
      border: "border-amber-500/40",
      text: "text-amber-400",
    },
    emerald: {
      badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
      bar: "bg-emerald-500",
      border: "border-emerald-500/40",
      text: "text-emerald-400",
    },
    orange: {
      badge: "bg-orange-500/15 text-orange-400 border-orange-500/30",
      bar: "bg-orange-500",
      border: "border-orange-500/40",
      text: "text-orange-400",
    },
    teal: {
      badge: "bg-teal-500/15 text-teal-400 border-teal-500/30",
      bar: "bg-teal-500",
      border: "border-teal-500/40",
      text: "text-teal-400",
    },
  };
  return map[color]?.[variant] ?? "";
}
