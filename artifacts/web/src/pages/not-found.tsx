import { AppShell } from "@/components/layout/Shell";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";

export default function NotFound() {
  return (
    <AppShell>
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <AlertTriangle className="w-16 h-16 text-primary mb-6 opacity-80" />
        <h1 className="text-4xl font-display font-bold text-foreground mb-4">404 - Not Found</h1>
        <p className="text-muted-foreground mb-8 max-w-md">
          The page or job you are looking for doesn't exist or has been removed.
        </p>
        <Link 
          href="/"
          className="px-6 py-3 bg-secondary text-foreground hover:bg-secondary/80 border border-border rounded-lg font-medium transition-colors"
        >
          Return to Dashboard
        </Link>
      </div>
    </AppShell>
  );
}
