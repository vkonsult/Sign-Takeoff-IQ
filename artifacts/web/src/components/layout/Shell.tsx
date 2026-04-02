import { ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";

const LS_KEY = "sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY, String(next)); } catch {}
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <main className={`flex-1 min-w-0 flex flex-col transition-[margin] duration-200 ${collapsed ? "ml-12" : "ml-64"}`}>
        {children}
      </main>
    </div>
  );
}
