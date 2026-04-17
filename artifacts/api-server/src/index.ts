import * as Sentry from "@sentry/node";

const release = process.env.SENTRY_RELEASE;
const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  release,
  environment: process.env.NODE_ENV ?? "development",
  enabled: !!dsn,
});

import app from "./app";
import { logger } from "./lib/logger";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, release: release ?? "unset" }, "Server listening");
});
