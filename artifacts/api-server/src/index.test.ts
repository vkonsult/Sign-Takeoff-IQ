import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// ── Mocks (hoisted before any import) ─────────────────────────────────────

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("./app", () => ({
  default: {
    listen: vi.fn((_port: number, cb: (err?: Error) => void) => cb()),
  },
}));

vi.mock("./lib/pdf-file-watcher", () => ({
  unwatchAllPdfFiles: vi.fn(),
  registerExistingFileWatchers: vi.fn().mockResolvedValue(undefined),
  watchPdfFile: vi.fn(),
  unwatchPdfFile: vi.fn(),
  __watchers: new Map(),
}));

vi.mock("./lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe("index.ts — shutdown signal handlers", () => {
  let unwatchSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let sigtermHandler: () => void;
  let sigintHandler: () => void;
  let sigtermRegistrationCount: number;
  let sigintRegistrationCount: number;

  beforeAll(async () => {
    process.env["PORT"] = "3099";

    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    const onSpy = vi.spyOn(process, "on");

    // Importing the module registers the signal handlers as a side-effect.
    await import("./index");

    // Locate the handlers that were registered during module initialisation.
    const calls = onSpy.mock.calls as Array<[string, () => void]>;
    const sigtermCalls = calls.filter(([sig]) => sig === "SIGTERM");
    const sigintCalls = calls.filter(([sig]) => sig === "SIGINT");

    sigtermRegistrationCount = sigtermCalls.length;
    sigintRegistrationCount = sigintCalls.length;
    sigtermHandler = sigtermCalls[0]![1];
    sigintHandler = sigintCalls[0]![1];

    const watcherMod = await import("./lib/pdf-file-watcher");
    unwatchSpy = vi.mocked(watcherMod.unwatchAllPdfFiles);

    onSpy.mockRestore();
  });

  afterAll(() => {
    exitSpy.mockRestore();
    delete process.env["PORT"];
  });

  it("registers SIGTERM exactly once", () => {
    expect(sigtermRegistrationCount).toBe(1);
  });

  it("registers SIGINT exactly once", () => {
    expect(sigintRegistrationCount).toBe(1);
  });

  it("SIGTERM handler calls unwatchAllPdfFiles() before process.exit(0)", () => {
    unwatchSpy.mockClear();
    exitSpy.mockClear();

    sigtermHandler();

    expect(unwatchSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify unwatchAllPdfFiles is invoked before process.exit
    const unwatchOrder = unwatchSpy.mock.invocationCallOrder[0]!;
    const exitOrder = exitSpy.mock.invocationCallOrder[0]!;
    expect(unwatchOrder).toBeLessThan(exitOrder);
  });

  it("SIGINT handler calls unwatchAllPdfFiles() before process.exit(0)", () => {
    unwatchSpy.mockClear();
    exitSpy.mockClear();

    sigintHandler();

    expect(unwatchSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify unwatchAllPdfFiles is invoked before process.exit
    const unwatchOrder = unwatchSpy.mock.invocationCallOrder[0]!;
    const exitOrder = exitSpy.mock.invocationCallOrder[0]!;
    expect(unwatchOrder).toBeLessThan(exitOrder);
  });
});
