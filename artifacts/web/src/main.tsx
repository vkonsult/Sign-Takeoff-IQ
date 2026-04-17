import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getGuestToken } from "./lib/apiClient";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

Sentry.init({
  dsn,
  release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
  environment: import.meta.env.MODE,
  enabled: !!dsn,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

setAuthTokenGetter(() => getGuestToken());

createRoot(document.getElementById("root")!).render(<App />);
