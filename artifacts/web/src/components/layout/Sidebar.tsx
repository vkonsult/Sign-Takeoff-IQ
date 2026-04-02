import { useState } from "react";
import { Link, useLocation } from "wouter";
import { FileUp, FolderOpen, AlertCircle, BookOpen, ChevronLeft, ChevronRight, LogOut, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobsList } from "@/hooks/use-takeoff";
import { format } from "date-fns";
import { useClerk, useUser } from "@clerk/react";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const [location] = useLocation();
  const { data, isLoading } = useJobsList();
  const { signOut } = useClerk();
  const { user } = useUser();

  const navItems = [
    { href: "/new-upload", label: "New Upload", icon: FileUp },
    { href: "/jobs", label: "All Jobs", icon: FolderOpen },
    { href: "/training", label: "Training Import", icon: BookOpen },
  ];

  const initials = user
    ? (((user.firstName?.[0] ?? "") + (user.lastName?.[0] ?? "")).toUpperCase() ||
      (user.emailAddresses?.[0]?.emailAddress?.[0]?.toUpperCase() ?? "?"))
    : "?";

  const displayName = user
    ? user.fullName ?? user.emailAddresses?.[0]?.emailAddress ?? "User"
    : "User";

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
              <path d="M4 22L20 2" strokeLinecap="round"/>
              <path d="M4 12L12 4" strokeLinecap="round"/>
              <path d="M12 20L20 12" strokeLinecap="round"/>
            </svg>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-primary-foreground stroke-current" strokeWidth="2">
                <path d="M4 22L20 2" strokeLinecap="round"/>
                <path d="M4 12L12 4" strokeLinecap="round"/>
                <path d="M12 20L20 12" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="font-display font-bold text-sm leading-tight text-foreground truncate">SIGN TAKEOFF IQ</h1>
              <p className="text-[10px] text-primary tracking-widest font-mono uppercase">Precision Portal</p>
            </div>
          </div>
        )}
      </div>

      {/* Nav items */}
      <nav className={cn("space-y-1", collapsed ? "p-1.5" : "p-4")}>
        {navItems.map((item) => {
          const isActive = location === item.href;
          if (collapsed) {
            return (
              <NavTooltip key={item.href} label={item.label}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center justify-center w-9 h-9 rounded-md transition-all duration-200",
                    isActive
                      ? "bg-secondary text-primary border border-border"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  )}
                >
                  <item.icon className={cn("w-4 h-4", isActive ? "text-primary" : "opacity-70")} />
                </Link>
              </NavTooltip>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-secondary text-primary border border-border"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              <item.icon className={cn("w-4 h-4", isActive ? "text-primary" : "opacity-70")} />
              {item.label}
            </Link>
          );
        })}
      </nav>

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
              data?.jobs?.slice(0, 5).map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className={cn(
                    "flex flex-col gap-1 px-3 py-2 rounded-md border border-transparent transition-all",
                    location === `/jobs/${job.id}`
                      ? "bg-secondary border-border"
                      : "hover:bg-secondary/30"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground truncate">
                      {job.name ?? job.id.split('-')[0]}
                    </span>
                    <StatusDot status={job.status} />
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {format(new Date(job.createdAt), "MMM d, HH:mm")}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      )}

      {/* Spacer when collapsed so toggle stays at bottom */}
      {collapsed && <div className="flex-1" />}

      {/* Footer: user profile + toggle */}
      <div className={cn("border-t border-border space-y-1", collapsed ? "p-1.5" : "p-4")}>
        {collapsed ? (
          <>
            <NavTooltip label={displayName}>
              <div className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/20 text-primary text-xs font-bold cursor-default select-none">
                {initials}
              </div>
            </NavTooltip>
            <NavTooltip label="Sign out">
              <button
                onClick={() => signOut()}
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
                <p className="text-[10px] text-muted-foreground truncate">
                  {user?.emailAddresses?.[0]?.emailAddress ?? ""}
                </p>
              </div>
              <button
                onClick={() => signOut()}
                title="Sign out"
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
  if (status === 'completed') return <div className="w-2 h-2 rounded-full bg-accent animate-pulse" title="Completed" />;
  if (status === 'processing') return <div className="w-2 h-2 rounded-full bg-primary animate-ping" title="Processing" />;
  if (status === 'failed') return <AlertCircle className="w-3 h-3 text-destructive" aria-label="Failed" />;
  return <div className="w-2 h-2 rounded-full bg-muted-foreground" title="Pending" />;
}
