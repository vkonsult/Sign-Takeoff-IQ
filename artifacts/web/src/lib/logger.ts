const isDev = import.meta.env.DEV;

export const logger = {
  log: (...args: unknown[]): void => {
    if (isDev) console.log(...args); // eslint-disable-line no-console
  },
  warn: (...args: unknown[]): void => {
    if (isDev) console.warn(...args); // eslint-disable-line no-console
  },
  error: (...args: unknown[]): void => {
    if (isDev) console.error(...args); // eslint-disable-line no-console
  },
};
