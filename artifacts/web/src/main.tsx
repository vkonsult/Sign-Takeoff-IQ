import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getGuestToken } from "./lib/apiClient";

if (!import.meta.env.DEV && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: "production",
  });
}

setAuthTokenGetter(() => getGuestToken());

createRoot(document.getElementById("root")!).render(<App />);
