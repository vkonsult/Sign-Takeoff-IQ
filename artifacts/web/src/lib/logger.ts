import * as Sentry from "@sentry/react";

const isDev = import.meta.env.DEV;

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  return new Error(fallbackMessage);
}

export const logger = {
  log: (...args: unknown[]): void => {
    if (isDev) console.log(...args); // eslint-disable-line no-console
  },

  warn: (...args: unknown[]): void => {
    if (isDev) console.warn(...args); // eslint-disable-line no-console
  },

  error: (message: string, error?: unknown): void => {
    if (isDev) {
      console.error(message, error); // eslint-disable-line no-console
    } else {
      const err = toError(error, message);
      Sentry.captureException(err, {
        extra: { loggedMessage: message },
      });
    }
  },
};
