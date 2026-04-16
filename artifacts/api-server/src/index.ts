import * as Sentry from "@sentry/node";

const sentryDsn = process.env["SENTRY_DSN"];
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn });
}

import app from "./app";
import { logger } from "./lib/logger";
import { unwatchAllPdfFiles } from "./lib/pdf-file-watcher";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal — closing file watchers");
  unwatchAllPdfFiles();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
