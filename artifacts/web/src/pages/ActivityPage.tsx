import { useState, useCallback } from "react";
import { AppShell } from "@/components/layout/Shell";
import { apiFetch } from "@/lib/apiClient";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import { useUserRole } from "@/hooks/use-user-role";
import {
  Clock,
  FolderOpen,
  Zap,
  PenLine,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  SlidersHorizontal,
  Bot,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type EventKey = "job_opened" | "scan_run" | "sign_updated" | "xlsx_exported" | "pdf_exported";

const EVENT_META: Record<EventKey, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  job_opened: { label: "Opened Plan", icon: FolderOpen },
  scan_run: { label: "Ran Scan", icon: Zap },
  sign_updated: { label: "Sign Updated", icon: PenLine },
  xlsx_exported: { label: "Exported XLSX", icon: FileSpreadsheet },
  pdf_exported: { label: "Exported PDF", icon: FileSpreadsheet },
};

const ALL_EVENT_KEYS = Object.keys(EVENT_META) as EventKey[];

const PAGE_SIZE = 50;

interface ActivityRow {
  id: string;
  organizationId: string | null;
  userId: string;
  userName: string;
  userInitials: string;
  jobId: string | null;
  jobName: string | null;
  eventType: string;
  createdAt: string;
  orgName?: string | null;
}

interface AiCallRow {
  id: string;
  jobId: string | null;
  jobName?: string | null;
  pageNumber: number | null;
  callType: string;
  prompt: string;
  responseJson: unknown;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
}

type TabId = "activity" | "ai";

function UserBadge({ initials, name }: { initials: string; name: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        title={name}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex-shrink-0"
      >
        {initials}
      </span>
      <span className="text-sm text-foreground truncate max-w-[120px]">{name}</span>
    </div>
  );
}

function EventBadge({ eventType }: { eventType: string }) {
  const meta = EVENT_META[eventType as EventKey] ?? { label: eventType, icon: Clock };
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{meta.label}</span>
    </div>
  );
}

const CALL_TYPE_LABELS: Record<string, string> = {
  project_info: "Project Info",
  floor_plan_text: "Floor Plan Text",
  vision_fallback: "Vision Fallback",
  bbox_detection: "Bbox Detection",
  title_block_vision: "Title Block Vision",
  sign_schedule_enrich: "Schedule Enrich",
};

function CallTypeBadge({ callType }: { callType: string }) {
  const label = CALL_TYPE_LABELS[callType] ?? callType;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 text-xs font-medium border border-violet-500/20">
      <Bot className="w-3 h-3 flex-shrink-0" />
      {label}
    </span>
  );
}

function AiCallExpandedRow({ row }: { row: AiCallRow }) {
  return (
    <div className="grid grid-cols-2 gap-4 px-4 pb-4 pt-2 bg-secondary/20 border-t border-border">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Prompt
        </div>
        <pre className="text-xs font-mono text-foreground bg-background rounded-lg border border-border p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words leading-relaxed">
          {row.prompt || "(no prompt recorded)"}
        </pre>
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Response JSON
        </div>
        <pre className="text-xs font-mono text-foreground bg-background rounded-lg border border-border p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words leading-relaxed">
          {row.responseJson != null
            ? JSON.stringify(row.responseJson, null, 2)
            : "(no response recorded)"}
        </pre>
      </div>
    </div>
  );
}

interface JobOption {
  id: string;
  name: string;
}

const AI_CALL_TYPES = [
  "project_info",
  "floor_plan_text",
  "vision_fallback",
  "bbox_detection",
  "title_block_vision",
  "sign_schedule_enrich",
] as const;

function AiCallsTab({ isAdmin, isSuperAdmin }: { isAdmin: boolean; isSuperAdmin: boolean }) {
  const [offset, setOffset] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedCallType, setSelectedCallType] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [promptSearch, setPromptSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data: jobsData } = useQuery({
    queryKey: ["jobs-for-ai-filter"],
    queryFn: async () => {
      const res = await apiFetch("/api/jobs");
      if (!res.ok) return { jobs: [] as JobOption[] };
      const raw = await res.json() as { jobs?: Array<{ id: string; name: string }> };
      return { jobs: (raw.jobs ?? []).map((j) => ({ id: j.id, name: j.name })) as JobOption[] };
    },
    staleTime: 60_000,
  });
  const jobOptions = jobsData?.jobs ?? [];

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    if (selectedJobId) params.set("jobId", selectedJobId);
    if (selectedCallType) params.set("callType", selectedCallType);
    if (filterFrom) params.set("from", filterFrom);
    if (filterTo) params.set("to", filterTo);
    if (promptSearch.trim()) params.set("prompt", promptSearch.trim());
    return params.toString();
  }, [offset, selectedJobId, selectedCallType, filterFrom, filterTo, promptSearch]);

  const { data, isLoading } = useQuery({
    queryKey: ["ai-calls", offset, selectedJobId, selectedCallType, filterFrom, filterTo, promptSearch],
    queryFn: async () => {
      const res = await apiFetch(`/api/activity/ai-calls?${buildQuery()}`);
      if (!res.ok) throw new Error("Failed to load AI call logs");
      return res.json() as Promise<{ aiCalls: AiCallRow[]; limit: number; offset: number }>;
    },
    staleTime: 30_000,
  });

  const aiCalls = data?.aiCalls ?? [];
  const hasNext = aiCalls.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasActiveFilters = !!(selectedJobId || selectedCallType || filterFrom || filterTo || promptSearch.trim());

  const clearFilters = () => {
    setSelectedJobId("");
    setSelectedCallType("");
    setFilterFrom("");
    setFilterTo("");
    setPromptSearch("");
    setOffset(0);
  };

  if (!isAdmin && !isSuperAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        Admin access is required to view AI call logs.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Job
          </label>
          <select
            value={selectedJobId}
            onChange={(e) => { setSelectedJobId(e.target.value); setOffset(0); }}
            className="h-8 rounded-md border border-border bg-background text-sm px-2 text-foreground w-56"
          >
            <option value="">All jobs</option>
            {jobOptions.map((j) => (
              <option key={j.id} value={j.id}>{j.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Call Type
          </label>
          <select
            value={selectedCallType}
            onChange={(e) => { setSelectedCallType(e.target.value); setOffset(0); }}
            className="h-8 rounded-md border border-border bg-background text-sm px-2 text-foreground w-48"
          >
            <option value="">All types</option>
            {AI_CALL_TYPES.map((t) => (
              <option key={t} value={t}>{CALL_TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            From
          </label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setOffset(0); }}
            className="h-8 rounded-md border border-border bg-background text-sm px-2 text-foreground"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            To
          </label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => { setFilterTo(e.target.value); setOffset(0); }}
            className="h-8 rounded-md border border-border bg-background text-sm px-2 text-foreground"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Prompt
          </label>
          <input
            type="text"
            value={promptSearch}
            onChange={(e) => { setPromptSearch(e.target.value); setOffset(0); }}
            placeholder="Search prompt text…"
            className="h-8 rounded-md border border-border bg-background text-sm px-2 text-foreground w-52"
          />
        </div>

        {hasActiveFilters && (
          <Button onClick={clearFilters} size="sm" variant="ghost" className="mb-0.5">
            <X className="w-3.5 h-3.5" />
            Clear
          </Button>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg">
        <div className="grid grid-cols-[160px_1fr_160px_120px_100px_140px_36px] gap-2 px-4 py-3 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
          <div>Time</div>
          <div>Job</div>
          <div>Call Type</div>
          <div>Tokens (in/out)</div>
          <div>Duration</div>
          <div>Page</div>
          <div />
        </div>

        <div className="divide-y divide-border">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse bg-secondary/30 mx-4 my-2 rounded" />
            ))
          ) : aiCalls.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              No AI call logs found. AI calls will appear here after running an AI scan on a job.
            </div>
          ) : (
            aiCalls.map((row) => (
              <div key={row.id}>
                <div
                  className="grid grid-cols-[160px_1fr_160px_120px_100px_140px_36px] gap-2 px-4 py-3 items-center hover:bg-secondary/30 transition-colors cursor-pointer"
                  onClick={() => toggleExpanded(row.id)}
                >
                  <div>
                    <div className="text-xs text-foreground font-mono">
                      {format(new Date(row.createdAt), "MMM d, HH:mm:ss")}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                    </div>
                  </div>

                  <div className="truncate">
                    {row.jobId ? (
                      <Link
                        href={`/jobs/${row.jobId}`}
                        className="text-xs text-primary hover:underline truncate"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {row.jobName ?? row.jobId.slice(0, 8) + "…"}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>

                  <div>
                    <CallTypeBadge callType={row.callType} />
                  </div>

                  <div className="text-xs text-muted-foreground font-mono">
                    {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                  </div>

                  <div className="text-xs text-muted-foreground font-mono">
                    {row.durationMs >= 1000
                      ? `${(row.durationMs / 1000).toFixed(1)}s`
                      : `${row.durationMs}ms`}
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {row.pageNumber != null ? (
                      <span
                        title={
                          row.callType === "floor_plan_text" || row.callType === "bbox_detection"
                            ? `First page of this API call's batch (tokens cover all pages in the batch)`
                            : `Page ${row.pageNumber}`
                        }
                      >
                        Page {row.pageNumber}
                      </span>
                    ) : "—"}
                  </div>

                  <button
                    type="button"
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(row.id); }}
                  >
                    {expandedIds.has(row.id) ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {expandedIds.has(row.id) && <AiCallExpandedRow row={row} />}
              </div>
            ))
          )}
        </div>
      </div>

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between">
          <Button
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={!hasPrev}
            variant="outline"
            size="sm"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Showing {offset + 1}–{offset + aiCalls.length}
          </span>
          <Button
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={!hasNext}
            variant="outline"
            size="sm"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function ActivityPage() {
  const { isAdmin, isSuperAdmin } = useUserRole();
  const [activeTab, setActiveTab] = useState<TabId>("activity");

  const [offset, setOffset] = useState(0);
  const [selectedEvents, setSelectedEvents] = useState<Set<EventKey>>(new Set());
  const [filterUser, setFilterUser] = useState<string>("");
  const [filterPlan, setFilterPlan] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string>("");
  const [filterTo, setFilterTo] = useState<string>("");
  const [filterOrgId, setFilterOrgId] = useState<string>("");
  const [showFilters, setShowFilters] = useState(false);

  const [appliedEvents, setAppliedEvents] = useState<Set<EventKey>>(new Set());
  const [appliedUser, setAppliedUser] = useState<string>("");
  const [appliedPlan, setAppliedPlan] = useState<string>("");
  const [appliedFrom, setAppliedFrom] = useState<string>("");
  const [appliedTo, setAppliedTo] = useState<string>("");
  const [appliedOrgId, setAppliedOrgId] = useState<string>("");

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    appliedEvents.forEach((e) => params.append("eventType", e));
    if (appliedUser) params.set("userName", appliedUser);
    if (appliedPlan) params.set("jobName", appliedPlan);
    if (appliedFrom) params.set("from", appliedFrom);
    if (appliedTo) params.set("to", appliedTo);
    if (appliedOrgId && isSuperAdmin) params.set("orgId", appliedOrgId);
    return params.toString();
  }, [offset, appliedEvents, appliedUser, appliedPlan, appliedFrom, appliedTo, appliedOrgId, isSuperAdmin]);

  const { data, isLoading } = useQuery({
    queryKey: ["activity", offset, [...appliedEvents].sort().join(","), appliedUser, appliedPlan, appliedFrom, appliedTo, appliedOrgId],
    queryFn: async () => {
      const res = await apiFetch(`/api/activity?${buildQueryString()}`);
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json() as Promise<{ activities: ActivityRow[]; limit: number; offset: number }>;
    },
    staleTime: 30_000,
    enabled: activeTab === "activity",
  });

  const activities = data?.activities ?? [];
  const hasNext = activities.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  const applyFilters = () => {
    setAppliedEvents(new Set(selectedEvents));
    setAppliedUser(filterUser);
    setAppliedPlan(filterPlan);
    setAppliedFrom(filterFrom);
    setAppliedTo(filterTo);
    setAppliedOrgId(filterOrgId);
    setOffset(0);
  };

  const clearFilters = () => {
    setSelectedEvents(new Set());
    setFilterUser("");
    setFilterPlan("");
    setFilterFrom("");
    setFilterTo("");
    setFilterOrgId("");
    setAppliedEvents(new Set());
    setAppliedUser("");
    setAppliedPlan("");
    setAppliedFrom("");
    setAppliedTo("");
    setAppliedOrgId("");
    setOffset(0);
  };

  const toggleEvent = (key: EventKey) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const hasActiveFilters = appliedEvents.size > 0 || appliedUser || appliedPlan || appliedFrom || appliedTo || appliedOrgId;

  return (
    <AppShell>
      <div className="flex-1 p-8 max-w-6xl mx-auto w-full">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-display text-foreground mb-2 flex items-center gap-3">
              <Clock className="w-8 h-8 text-primary" />
              Activity Log
            </h1>
            <p className="text-muted-foreground font-sans">
              {isAdmin && !isSuperAdmin
                ? "All activity for your organization."
                : isSuperAdmin
                  ? "All activity across all organizations."
                  : "Your recent activity."}
            </p>
          </div>
          {activeTab === "activity" && (
            <Button
              onClick={() => setShowFilters((v) => !v)}
              variant={showFilters || hasActiveFilters ? "outline" : "secondary"}
              size="sm"
              className={showFilters || hasActiveFilters ? "border-primary/40 text-primary bg-primary/10 hover:bg-primary/15" : ""}
            >
              <Filter className="w-4 h-4" />
              Filters
              {hasActiveFilters && (
                <span className="w-2 h-2 rounded-full bg-primary inline-block" />
              )}
            </Button>
          )}
        </header>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-border">
          <button
            type="button"
            onClick={() => setActiveTab("activity")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors border-b-2 -mb-px
              ${activeTab === "activity"
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50"}`}
          >
            <Clock className="w-4 h-4" />
            Activity
          </button>
          {(isAdmin || isSuperAdmin) && (
            <button
              type="button"
              onClick={() => setActiveTab("ai")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors border-b-2 -mb-px
                ${activeTab === "ai"
                  ? "border-primary text-primary bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50"}`}
            >
              <Bot className="w-4 h-4" />
              AI Calls
            </button>
          )}
        </div>

        {activeTab === "ai" ? (
          <AiCallsTab isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} />
        ) : (
          <>
            {showFilters && (
              <div className="mb-6 p-4 bg-card border border-border rounded-xl space-y-4">
                <div>
                  <label className="block text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Event Type
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_EVENT_KEYS.map((k) => {
                      const meta = EVENT_META[k];
                      const Icon = meta.icon;
                      const checked = selectedEvents.has(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => toggleEvent(k)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors
                            ${checked
                              ? "bg-primary/15 border-primary/50 text-primary"
                              : "bg-secondary border-border text-muted-foreground hover:text-foreground"}`}
                        >
                          <Icon className="w-3 h-3 flex-shrink-0" />
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 items-end">
                  <div className="flex flex-col gap-1 min-w-[160px]">
                    <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                      User Name
                    </label>
                    <input
                      type="text"
                      value={filterUser}
                      onChange={(e) => setFilterUser(e.target.value)}
                      placeholder="Search by name…"
                      className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="flex flex-col gap-1 min-w-[160px]">
                    <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                      Plan Name
                    </label>
                    <input
                      type="text"
                      value={filterPlan}
                      onChange={(e) => setFilterPlan(e.target.value)}
                      placeholder="Search plan name…"
                      className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="flex flex-col gap-1 min-w-[140px]">
                    <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                      From Date
                    </label>
                    <input
                      type="date"
                      value={filterFrom}
                      onChange={(e) => setFilterFrom(e.target.value)}
                      className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground"
                    />
                  </div>

                  <div className="flex flex-col gap-1 min-w-[140px]">
                    <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                      To Date
                    </label>
                    <input
                      type="date"
                      value={filterTo}
                      onChange={(e) => setFilterTo(e.target.value)}
                      className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground"
                    />
                  </div>

                  {isSuperAdmin && (
                    <div className="flex flex-col gap-1 min-w-[180px]">
                      <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                        Org ID
                      </label>
                      <input
                        type="text"
                        value={filterOrgId}
                        onChange={(e) => setFilterOrgId(e.target.value)}
                        placeholder="Paste org UUID…"
                        className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                  )}

                  <div className="flex gap-2 pb-0.5">
                    <Button onClick={applyFilters} size="sm">
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      Apply
                    </Button>
                    {(hasActiveFilters || selectedEvents.size > 0 || filterUser || filterPlan || filterFrom || filterTo || filterOrgId) && (
                      <Button onClick={clearFilters} variant="outline" size="sm">
                        <X className="w-3.5 h-3.5" />
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {hasActiveFilters && (
              <div className="mb-4 flex flex-wrap gap-2">
                {[...appliedEvents].map((e) => (
                  <span key={e} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium border border-primary/30">
                    {EVENT_META[e].label}
                  </span>
                ))}
                {appliedUser && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-foreground text-xs font-medium border border-border">
                    User: {appliedUser}
                  </span>
                )}
                {appliedPlan && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-foreground text-xs font-medium border border-border">
                    Plan: {appliedPlan}
                  </span>
                )}
                {appliedFrom && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-foreground text-xs font-medium border border-border">
                    From: {appliedFrom}
                  </span>
                )}
                {appliedTo && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-foreground text-xs font-medium border border-border">
                    To: {appliedTo}
                  </span>
                )}
              </div>
            )}

            <div className="bg-card rounded-xl border border-border overflow-hidden shadow-lg">
              <div className={`grid gap-3 px-4 py-3 border-b border-border bg-secondary/50 text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground
                ${isSuperAdmin ? "grid-cols-[180px_1fr_160px_180px_160px]" : "grid-cols-[180px_1fr_160px_180px]"}`}>
                <div>Date</div>
                <div>User</div>
                {isSuperAdmin && <div>Organization</div>}
                <div>Action</div>
                <div>Plan</div>
              </div>

              <div className="divide-y divide-border">
                {isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse bg-secondary/30 mx-4 my-2 rounded" />
                  ))
                ) : activities.length === 0 ? (
                  <div className="p-10 text-center text-muted-foreground">
                    No activity records found.
                  </div>
                ) : (
                  activities.map((row) => (
                    <div
                      key={row.id}
                      className={`grid gap-3 px-4 py-3 items-center hover:bg-secondary/30 transition-colors
                        ${isSuperAdmin ? "grid-cols-[180px_1fr_160px_180px_160px]" : "grid-cols-[180px_1fr_160px_180px]"}`}
                    >
                      <div>
                        <div className="text-xs text-foreground font-mono">
                          {format(new Date(row.createdAt), "MMM d, yyyy HH:mm")}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                        </div>
                      </div>

                      <UserBadge initials={row.userInitials} name={row.userName} />

                      {isSuperAdmin && (
                        <div className="text-xs text-muted-foreground truncate" title={row.orgName ?? row.organizationId ?? ""}>
                          {row.orgName ?? (row.organizationId ? row.organizationId.slice(0, 8) + "…" : "—")}
                        </div>
                      )}

                      <EventBadge eventType={row.eventType} />

                      <div className="truncate">
                        {row.jobId ? (
                          <Link
                            href={`/jobs/${row.jobId}`}
                            className="text-xs text-primary hover:underline truncate"
                          >
                            {row.jobName ?? row.jobId.slice(0, 8) + "…"}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {(hasPrev || hasNext) && (
              <div className="flex items-center justify-between mt-4">
                <Button
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  disabled={!hasPrev}
                  variant="outline"
                  size="sm"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Showing {offset + 1}–{offset + activities.length}
                </span>
                <Button
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={!hasNext}
                  variant="outline"
                  size="sm"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
