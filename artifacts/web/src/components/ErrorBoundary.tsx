import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { logger } from "@/lib/logger";
import { AlertTriangle, RefreshCw, WifiOff, LockKeyhole, DatabaseZap } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ErrorKind = "network" | "auth" | "data" | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  heading: string;
  detail: string;
}

export function classifyError(error: Error): ClassifiedError {
  const msg = error.message?.toLowerCase() ?? "";
  const name = error.name?.toLowerCase() ?? "";

  const isNetwork =
    (name === "typeerror" && (
      msg.includes("failed to fetch") ||
      msg.includes("networkerror") ||
      msg.includes("network request failed") ||
      msg.includes("load failed")
    )) ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("timeout");

  const isAuth =
    msg.includes("unauthorized") ||
    msg.includes("unauthenticated") ||
    msg.includes("403") ||
    msg.includes("401") ||
    msg.includes("forbidden") ||
    msg.includes("not logged in") ||
    msg.includes("session expired") ||
    name.includes("autherror");

  const isData =
    msg.includes("undefined is not an object") ||
    msg.includes("cannot read propert") ||
    msg.includes("null is not an object") ||
    msg.includes("is not defined") ||
    msg.includes("missing required") ||
    msg.includes("invalid data") ||
    msg.includes("parse error") ||
    msg.includes("unexpected token") ||
    name === "syntaxerror";

  if (isNetwork) {
    return {
      kind: "network",
      heading: "Connection problem",
      detail:
        "We couldn't reach the server. Check your internet connection and try again.",
    };
  }

  if (isAuth) {
    return {
      kind: "auth",
      heading: "Access denied",
      detail:
        "Your session may have expired or you don't have permission to view this page. Try refreshing or signing in again.",
    };
  }

  if (isData) {
    return {
      kind: "data",
      heading: "Data error",
      detail:
        "We received unexpected data and couldn't display this page. Refreshing usually fixes it.",
    };
  }

  return {
    kind: "unknown",
    heading: "Something went wrong",
    detail: "",
  };
}

const kindIcon: Record<ErrorKind, ReactNode> = {
  network: <WifiOff className="h-10 w-10 text-destructive" />,
  auth: <LockKeyhole className="h-10 w-10 text-destructive" />,
  data: <DatabaseZap className="h-10 w-10 text-destructive" />,
  unknown: <AlertTriangle className="h-10 w-10 text-destructive" />,
};

interface Props {
  children: ReactNode;
  routeName?: string;
  /**
   * Override the detail line shown in the fallback UI. Useful when a specific
   * page wants to provide more actionable guidance than the default copy.
   */
  fallbackMessage?: string;
  /**
   * Provide a custom classifier that replaces the built-in one.
   * Return a {@link ClassifiedError} to control the icon, heading, and detail copy.
   */
  classifyError?: (error: Error) => ClassifiedError;
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
      const classifier = this.props.classifyError ?? classifyError;
      const classified = this.state.error
        ? classifier(this.state.error)
        : { kind: "unknown" as ErrorKind, heading: "Something went wrong", detail: "" };

      const pageName = this.props.routeName
        ? `The ${this.props.routeName} page`
        : "This page";

      const detail =
        this.props.fallbackMessage ??
        (classified.detail ||
        `${pageName} ran into an unexpected error. The rest of the app is still available.`);

      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 gap-4">
          <div className="flex flex-col items-center gap-3 max-w-md text-center">
            {kindIcon[classified.kind]}
            <h2 className="text-lg font-semibold">{classified.heading}</h2>
            <p className="text-sm text-muted-foreground">{detail}</p>
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
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
