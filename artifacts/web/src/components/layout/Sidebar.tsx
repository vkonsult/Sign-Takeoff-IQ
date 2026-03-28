import { Link, useLocation } from "wouter";
import { LayoutDashboard, FileUp, FolderOpen, Settings, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJobsList } from "@/hooks/use-takeoff";
import { format } from "date-fns";

export function Sidebar() {
  const [location] = useLocation();
  const { data, isLoading } = useJobsList();

  const navItems = [
    { href: "/", label: "New Upload", icon: FileUp },
    { href: "/jobs", label: "All Jobs", icon: FolderOpen },
  ];

  return (
    <div className="w-64 bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0 overflow-y-auto">
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(180 70% 35%) 100%)'}}>
            <svg viewBox="0 0 28 28" fill="none" className="w-6 h-6">
              <rect x="3" y="4" width="22" height="14" rx="2" fill="white" fillOpacity="0.15" stroke="white" strokeWidth="1.5"/>
              <rect x="3" y="4" width="22" height="14" rx="2" fill="white" fillOpacity="0.08"/>
              <line x1="14" y1="18" x2="14" y2="24" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="10" y1="24" x2="18" y2="24" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M10 8.5L12.5 11.5L16 7L18 13" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-base leading-tight text-foreground tracking-wide">SIGN TAKEOFF</h1>
            <p className="text-[11px] text-primary tracking-[0.2em] font-mono uppercase font-semibold">IQ</p>
          </div>
        </div>
      </div>

      <nav className="p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location === item.href;
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
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-foreground truncate max-w-[120px]">
                    {job.id.split('-')[0]}
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

      <div className="p-4 border-t border-border">
        <button className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all">
          <Settings className="w-4 h-4 opacity-70" />
          Settings
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'completed') return <div className="w-2 h-2 rounded-full bg-accent animate-pulse" title="Completed" />;
  if (status === 'processing') return <div className="w-2 h-2 rounded-full bg-primary animate-ping" title="Processing" />;
  if (status === 'failed') return <AlertCircle className="w-3 h-3 text-destructive" aria-label="Failed" />;
  return <div className="w-2 h-2 rounded-full bg-muted-foreground" title="Pending" />;
}
