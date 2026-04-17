import { useState } from "react";
import { Link, useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  FileUp,
  FolderOpen,
  AlertCircle,
  BookOpen,
  Clock,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobsList } from "@/hooks/use-takeoff";
import { format } from "date-fns";
import { useClerk, useUser } from "@clerk/react";
import { useUserRole } from "@/hooks/use-user-role";
import { isGuestMode, clearGuestToken } from "@/lib/apiClient";

const SIDEBAR_ACTION_LABELS: Record<string, string> = {
  job_opened: "opened",
  scan_run: "ran scan on",
  sign_updated: "edited signs in",
  xlsx_exported: "exported XLSX for",
  pdf_exported: "exported PDF for",
};

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const [location, setLocation] = useLocation();
  const { data, isLoading } = useJobsList();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { role, isAdmin, isSuperAdmin } = useUserRole();

  function handleSignOut() {
    if (isGuestMode()) {
      clearGuestToken();
      setLocation("/");
      window.location.reload();
    } else {
      signOut();
    }
  }

  const mainNavItems = [
    { href: "/new-upload", label: "New Upload", icon: FileUp },
    { href: "/jobs", label: "All Jobs", icon: FolderOpen },
    { href: "/activity", label: "Activity", icon: Clock },
    { href: "/training", label: "Training Import", icon: BookOpen },
  ];

  const adminNavItems = isAdmin && !isSuperAdmin
    ? [
        { href: "/settings", label: "Company Settings", icon: Settings },
        { href: "/settings/users", label: "Users", icon: Users },
      ]
    : [];

  const superAdminNavItems = isSuperAdmin
    ? [{ href: "/admin", label: "Admin Panel", icon: Shield }]
    : [];

  const guestMode = isGuestMode();

  const initials = user
    ? (((user.firstName?.[0] ?? "") + (user.lastName?.[0] ?? "")).toUpperCase() ||
        (user.emailAddresses?.[0]?.emailAddress?.[0]?.toUpperCase() ?? "?"))
    : guestMode
      ? "SA"
      : "?";

  const displayName = user
    ? user.fullName ?? user.emailAddresses?.[0]?.emailAddress ?? "User"
    : guestMode
      ? "Super Admin (Guest)"
      : "User";

  const roleLabel =
    role === "SUPER_ADMIN"
      ? "Super Admin"
      : role === "ADMIN"
        ? "Admin"
        : role === "ESTIMATOR"
          ? "Estimator"
          : role === "PROJECT_MANAGER"
            ? "Project Manager"
            : role === "SALES"
              ? "Sales"
              : role;

  function NavItem({ href, label, icon: Icon }: { href: string; label: string; icon: typeof FileUp }) {
    const isActive = location === href || (href !== "/" && location.startsWith(href + "/"));
    if (collapsed) {
      return (
        <NavTooltip label={label}>
          <Link
            href={href}
            className={cn(
              "flex items-center justify-center w-9 h-9 rounded-md transition-all duration-200 outline-none",
              isActive
                ? "bg-primary/15 text-primary border-l-2 border-l-primary"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            )}
          >
            <Icon className={cn("w-4 h-4", isActive ? "text-primary" : "opacity-70")} />
          </Link>
        </NavTooltip>
      );
    }
    return (
      <Link
        href={href}
        className={cn(
          "flex items-center gap-3 py-2 rounded-md text-sm font-medium transition-all duration-200 outline-none",
          isActive
            ? "pl-[calc(0.75rem-2px)] pr-3 border-l-2 border-l-primary bg-primary/10 text-primary"
            : "px-3 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        )}
      >
        <Icon className={cn("w-4 h-4", isActive ? "text-primary" : "opacity-70")} />
        {label}
      </Link>
    );
  }

  return (
    <div
      className={cn(
        "bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0 overflow-y-auto overflow-x-hidden z-30 transition-[width] duration-200",
        collapsed ? "w-12" : "w-64"
      )}
    >
      {/* Header */}
      <div className={cn("border-b border-border flex items-center", collapsed ? "p-2 justify-center" : "p-4")}>
        {collapsed ? (
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-primary-foreground stroke-current" strokeWidth="2">
              <path d="M4 22L20 2" strokeLinecap="round" />
              <path d="M4 12L12 4" strokeLinecap="round" />
              <path d="M12 20L20 12" strokeLinecap="round" />
            </svg>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-primary-foreground stroke-current" strokeWidth="2">
                <path d="M4 22L20 2" strokeLinecap="round" />
                <path d="M4 12L12 4" strokeLinecap="round" />
                <path d="M12 20L20 12" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-bold text-sm leading-tight text-foreground truncate">SIGN TAKEOFF IQ</h1>
              <p className="text-[10px] text-primary tracking-widest font-mono uppercase">Precision Portal</p>
            </div>
          </div>
        )}
      </div>

      {/* Main nav */}
      <nav aria-label="Main navigation" className={cn("space-y-1", collapsed ? "p-1.5 pt-2" : "p-4")}>
        {mainNavItems.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}
      </nav>

      {/* Admin nav */}
      {adminNavItems.length > 0 && (
        <div className={cn(collapsed ? "px-1.5 pb-1" : "px-4 pb-2")}>
          {!collapsed && (
            <h3 className="text-[10px] font-display font-semibold text-muted-foreground tracking-wider uppercase mb-2 px-3">
              Settings
            </h3>
          )}
          {collapsed && <div className="h-px bg-border my-1.5" />}
          <nav aria-label="Settings navigation" className="space-y-1">
            {adminNavItems.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </nav>
        </div>
      )}

      {/* Super Admin nav */}
      {superAdminNavItems.length > 0 && (
        <div className={cn(collapsed ? "px-1.5 pb-1" : "px-4 pb-2")}>
          {!collapsed && (
            <h3 className="text-[10px] font-display font-semibold text-muted-foreground tracking-wider uppercase mb-2 px-3">
              Super Admin
            </h3>
          )}
          {collapsed && <div className="h-px bg-border my-1.5" />}
          <nav aria-label="Super admin navigation" className="space-y-1">
            {superAdminNavItems.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </nav>
        </div>
      )}

      {/* Recent jobs — hidden when collapsed */}
      {!collapsed && (
        <div className="mt-4 px-4 flex-1">
          <h3 className="text-xs font-display font-semibold text-muted-foreground tracking-wider uppercase mb-3 px-3">
            Recent Jobs
          </h3>
          <div className="space-y-1">
            {isLoading ? (
              <div className="animate-pulse space-y-2 px-3">
                <div className="h-10 bg-secondary rounded-md"></div>
                <div className="h-10 bg-secondary rounded-md"></div>
              </div>
            ) : data?.jobs?.length === 0 ? (
              <p className="text-xs text-muted-foreground px-3">No jobs found</p>
            ) : (
              data?.jobs?.slice(0, 5).map((job) => {
                const jobAny = job as typeof job & {
                  recentUsers?: { userName: string; userInitials: string; at: string; eventType?: string }[];
                };
                const recentUsers = jobAny.recentUsers ?? [];
                return (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className={cn(
                      "flex flex-col gap-1 px-3 py-2 rounded-md border border-transparent transition-all outline-none",
                      location === `/jobs/${job.id}`
                        ? "bg-secondary border-border"
                        : "hover:bg-secondary/30"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground truncate">
                        {job.name ?? job.id.split("-")[0]}
                      </span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {recentUsers.length > 0 && (
                          <div className="flex">
                            {recentUsers.map((u, i) => {
                              const action = u.eventType ? (SIDEBAR_ACTION_LABELS[u.eventType] ?? "touched") : "last active in";
                              const relTime = formatDistanceToNow(new Date(u.at), { addSuffix: true });
                              return (
                                <span
                                  key={u.userName + i}
                                  title={`${u.userName} ${action} this plan ${relTime}`}
                                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-[9px] font-bold flex-shrink-0 ring-1 ring-card"
                                  style={{ marginLeft: i > 0 ? "-5px" : undefined }}
                                >
                                  {u.userInitials}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <StatusDot status={job.status} />
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {format(new Date(job.createdAt), "MMM d, HH:mm")}
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}

      {collapsed && <div className="flex-1" />}

      {/* Footer */}
      <div className={cn("border-t border-border space-y-1", collapsed ? "p-1.5" : "p-4")}>
        {collapsed ? (
          <>
            <NavTooltip label={`${displayName} · ${roleLabel}`}>
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/20 text-primary text-xs font-bold cursor-default select-none">
                {initials}
              </div>
            </NavTooltip>
            <NavTooltip label={guestMode ? "Exit guest mode" : "Sign out"}>
              <button
                onClick={handleSignOut}
                className="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-all"
              >
                <LogOut className="w-4 h-4 opacity-70" />
              </button>
            </NavTooltip>
            <NavTooltip label="Expand sidebar">
              <button
                onClick={onToggle}
                className="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </NavTooltip>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-border/50 bg-secondary/30 mb-2">
              <div className="w-7 h-7 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0 select-none">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">{displayName}</p>
                <p className="text-[10px] text-muted-foreground truncate">{roleLabel}</p>
              </div>
              <button
                onClick={handleSignOut}
                title={guestMode ? "Exit guest mode" : "Sign out"}
                className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={onToggle}
              className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
              Collapse sidebar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function NavTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 pointer-events-none">
          <div className="bg-popover border border-border text-popover-foreground text-xs font-medium px-2 py-1 rounded shadow-lg whitespace-nowrap">
            {label}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "completed") return <div className="w-2 h-2 rounded-full bg-accent animate-pulse" title="Completed" />;
  if (status === "processing") return <div className="w-2 h-2 rounded-full bg-primary animate-ping" title="Processing" />;
  if (status === "failed") return <AlertCircle className="w-3 h-3 text-destructive" aria-label="Failed" />;
  return <div className="w-2 h-2 rounded-full bg-muted-foreground" title="Pending" />;
}
