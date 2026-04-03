import { useQuery } from "@tanstack/react-query";
import { AdminShell } from "@/components/layout/AdminShell";
import { apiFetch } from "@/lib/apiClient";
import { Link } from "wouter";
import { Building2, Users, FolderOpen, ArrowRight, TrendingUp } from "lucide-react";

type Stats = { organizations: number; users: number; jobs: number };

export default function AdminDashboard() {
  const statsQuery = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/stats");
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json() as Promise<Stats>;
    },
  });

  const stats = statsQuery.data;

  const cards = [
    {
      label: "Organizations",
      value: stats?.organizations ?? "—",
      icon: Building2,
      href: "/admin/organizations",
      color: "text-blue-400",
      bg: "bg-blue-900/20",
      description: "Active tenants on the platform",
    },
    {
      label: "Total Users",
      value: stats?.users ?? "—",
      icon: Users,
      href: "/admin/users",
      color: "text-purple-400",
      bg: "bg-purple-900/20",
      description: "All users across all organizations",
    },
    {
      label: "Total Jobs",
      value: stats?.jobs ?? "—",
      icon: FolderOpen,
      href: null,
      color: "text-green-400",
      bg: "bg-green-900/20",
      description: "Sign takeoff jobs processed",
    },
  ];

  return (
    <AdminShell section="super">
      <div className="flex-1 p-8">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-display font-bold text-foreground">Platform Dashboard</h1>
          </div>
          <p className="text-sm text-muted-foreground">Overview of all tenants, users, and activity</p>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-5 mb-8">
          {cards.map((card) => (
            <div
              key={card.label}
              className="bg-card border border-border rounded-xl p-5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <div className={`w-9 h-9 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <card.icon className={`w-4.5 h-4.5 ${card.color}`} />
                </div>
                {card.href && (
                  <Link href={card.href} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    View <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
              <div>
                <p className="text-3xl font-display font-bold text-foreground">
                  {statsQuery.isLoading ? (
                    <span className="animate-pulse bg-secondary rounded inline-block w-8 h-7" />
                  ) : (
                    stats ? card.value : "—"
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.label}</p>
              </div>
              <p className="text-xs text-muted-foreground border-t border-border pt-2">{card.description}</p>
            </div>
          ))}
        </div>

        {/* Quick links */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/admin/organizations"
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors group">
              <Building2 className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <div>
                <p className="text-sm font-medium text-foreground">Manage Organizations</p>
                <p className="text-xs text-muted-foreground">Create & view tenants</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
            <Link href="/admin/users"
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/30 hover:bg-secondary transition-colors group">
              <Users className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              <div>
                <p className="text-sm font-medium text-foreground">View All Users</p>
                <p className="text-xs text-muted-foreground">Cross-organization user list</p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
