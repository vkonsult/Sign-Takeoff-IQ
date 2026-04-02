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
} from "lucide-react";

const EVENT_LABELS: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  job_opened: { label: "Opened Plan", icon: FolderOpen },
  scan_run: { label: "Ran Scan", icon: Zap },
  sign_updated: { label: "Sign Updated", icon: PenLine },
  xlsx_exported: { label: "Exported XLSX", icon: FileSpreadsheet },
  pdf_exported: { label: "Exported PDF", icon: FileSpreadsheet },
};

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
  const meta = EVENT_LABELS[eventType] ?? { label: eventType, icon: Clock };
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{meta.label}</span>
    </div>
  );
}

export default function ActivityPage() {
  const { isAdmin, isSuperAdmin } = useUserRole();

  const [offset, setOffset] = useState(0);
  const [filterEventType, setFilterEventType] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string>("");
  const [filterTo, setFilterTo] = useState<string>("");
  const [filterOrgId, setFilterOrgId] = useState<string>("");
  const [showFilters, setShowFilters] = useState(false);

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    if (filterEventType) params.set("eventType", filterEventType);
    if (filterFrom) params.set("from", filterFrom);
    if (filterTo) params.set("to", filterTo);
    if (filterOrgId && isSuperAdmin) params.set("orgId", filterOrgId);
    return params.toString();
  }, [offset, filterEventType, filterFrom, filterTo, filterOrgId, isSuperAdmin]);

  const { data, isLoading } = useQuery({
    queryKey: ["activity", offset, filterEventType, filterFrom, filterTo, filterOrgId],
    queryFn: async () => {
      const res = await apiFetch(`/api/activity?${buildQueryString()}`);
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json() as Promise<{ activities: ActivityRow[]; limit: number; offset: number }>;
    },
    staleTime: 30_000,
  });

  const activities = data?.activities ?? [];
  const hasNext = activities.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  const applyFilters = () => {
    setOffset(0);
  };

  const clearFilters = () => {
    setFilterEventType("");
    setFilterFrom("");
    setFilterTo("");
    setFilterOrgId("");
    setOffset(0);
  };

  const hasActiveFilters = filterEventType || filterFrom || filterTo || filterOrgId;

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
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors
              ${showFilters || hasActiveFilters
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-secondary border-border text-muted-foreground hover:text-foreground"}`}
          >
            <Filter className="w-4 h-4" />
            Filters
            {hasActiveFilters && (
              <span className="ml-1 w-2 h-2 rounded-full bg-primary inline-block" />
            )}
          </button>
        </header>

        {showFilters && (
          <div className="mb-6 p-4 bg-card border border-border rounded-xl flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs font-display font-semibold uppercase tracking-wider text-muted-foreground">
                Event Type
              </label>
              <select
                value={filterEventType}
                onChange={(e) => setFilterEventType(e.target.value)}
                className="h-9 rounded-md border border-border bg-background text-sm px-2 text-foreground"
              >
                <option value="">All events</option>
                {Object.entries(EVENT_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 min-w-[150px]">
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

            <div className="flex flex-col gap-1 min-w-[150px]">
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
                  Org ID (filter)
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
              <button
                onClick={applyFilters}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium"
              >
                Apply
              </button>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="h-9 px-3 rounded-md bg-secondary border border-border text-sm text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>
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
            <button
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={!hasPrev}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </button>
            <span className="text-xs text-muted-foreground">
              Showing {offset + 1}–{offset + activities.length}
            </span>
            <button
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={!hasNext}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
