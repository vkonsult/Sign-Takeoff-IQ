import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { logger } from "@/lib/logger";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  routeName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("Uncaught render error", error);
    Sentry.captureException(error, {
      extra: {
        componentStack: info.componentStack,
        routeName: this.props.routeName,
      },
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 gap-4">
          <div className="flex flex-col items-center gap-3 max-w-md text-center">
            <AlertTriangle className="h-10 w-10 text-destructive" />
            <h2 className="text-lg font-semibold">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
              {this.props.routeName
                ? `The ${this.props.routeName} page ran into an unexpected error.`
                : "This page ran into an unexpected error."}
              {" "}The rest of the app is still available.
            </p>
            {import.meta.env.DEV && this.state.error && (
              <pre className="mt-2 w-full rounded bg-muted p-3 text-left text-xs text-muted-foreground overflow-auto max-h-40">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-2 mt-2">
              <Button variant="outline" onClick={this.handleReset} size="sm">
                <RefreshCw className="h-4 w-4 mr-1" />
                Try again
              </Button>
              <Button variant="ghost" size="sm" onClick={() => history.back()}>
                Go back
              </Button>
              <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
