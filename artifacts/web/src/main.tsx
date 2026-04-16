import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getGuestToken } from "./lib/apiClient";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

Sentry.init({
  dsn: sentryDsn,
  environment: import.meta.env.MODE,
  tracesSampleRate: 1.0,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.captureConsoleIntegration({ levels: ["error"] }),
  ],
  enabled: !!sentryDsn,
});

setAuthTokenGetter(() => getGuestToken());

createRoot(document.getElementById("root")!).render(<App />);
