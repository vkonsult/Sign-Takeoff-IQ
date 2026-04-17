import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getGuestToken } from "./lib/apiClient";

setAuthTokenGetter(() => getGuestToken());

createRoot(document.getElementById("root")!).render(<App />);
