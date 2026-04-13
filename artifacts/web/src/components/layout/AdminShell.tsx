import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Shield, Building2, Users, ChevronLeft, LogOut, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerk, useUser } from "@clerk/react";
import { useUserRole } from "@/hooks/use-user-role";
import { isGuestMode } from "@/lib/apiClient";

interface AdminShellProps {
  children: ReactNode;
  section: "super" | "tenant";
}

export function AdminShell({ children, section }: AdminShellProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { role, isSuperAdmin } = useUserRole();
  const guestMode = isGuestMode();

  const superNavItems = [
    { href: "/admin", label: "Dashboard", icon: Shield },
    { href: "/admin/organizations", label: "Organizations", icon: Building2 },
    { href: "/admin/users", label: "All Users", icon: Users },
  ];

  const tenantNavItems = [
    { href: "/settings", label: "Company Profile", icon: Building2 },
    { href: "/settings/users", label: "Team Members", icon: Users },
  ];

  const navItems = section === "super" ? superNavItems : tenantNavItems;

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

  const roleLabel = isSuperAdmin
    ? "Super Admin"
    : role === "ADMIN"
      ? "Organization Admin"
      : role;

  function isActive(href: string) {
    if (href === "/admin") return location === "/admin";
    if (href === "/settings") return location === "/settings";
    return location === href || location.startsWith(href + "/");
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Admin sidebar */}
      <div className="w-56 bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0 z-30">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 rounded bg-primary flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-primary-foreground stroke-current" strokeWidth="2">
                <path d="M4 22L20 2" strokeLinecap="round" />
                <path d="M4 12L12 4" strokeLinecap="round" />
                <path d="M12 20L20 12" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="font-display font-bold text-xs leading-tight text-foreground">SIGN TAKEOFF IQ</p>
              <p className="text-[9px] text-primary tracking-widest font-mono uppercase">
                {section === "super" ? "Admin Portal" : "Settings"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-secondary/50 border border-border/50">
            {section === "super" ? (
              <Shield className="w-3 h-3 text-purple-400 flex-shrink-0" />
            ) : (
              <Settings className="w-3 h-3 text-blue-400 flex-shrink-0" />
            )}
            <span className="text-[10px] font-medium text-muted-foreground truncate">
              {section === "super" ? "Super Admin" : "Organization Admin"}
            </span>
          </div>
        </div>

        {/* Nav */}
        <nav className="p-3 flex-1">
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 py-2 rounded-md text-sm font-medium transition-all",
                  isActive(item.href)
                    ? "pl-[calc(0.75rem-2px)] pr-3 border-l-2 border-l-primary bg-primary/10 text-primary"
                    : "px-3 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                )}
              >
                <item.icon className={cn("w-3.5 h-3.5 flex-shrink-0", isActive(item.href) ? "text-primary" : "opacity-60")} />
                {item.label}
              </Link>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-border">
            <Link
              href="/jobs"
              className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-all"
            >
              <ChevronLeft className="w-3.5 h-3.5 opacity-60" />
              Back to App
            </Link>
          </div>
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg border border-border/50 bg-secondary/30">
            <div className="w-6 h-6 rounded-full bg-primary/20 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{displayName}</p>
              <p className="text-[10px] text-muted-foreground truncate">{roleLabel}</p>
            </div>
            {!guestMode && (
              <button
                onClick={() => signOut()}
                title="Sign out"
                className="p-0.5 rounded text-muted-foreground hover:text-destructive transition-colors"
              >
                <LogOut className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 min-w-0 ml-56 flex flex-col">
        {children}
      </main>
    </div>
  );
}
