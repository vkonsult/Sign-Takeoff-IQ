import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => {
  const catchFn = vi.fn().mockResolvedValue(undefined);
  const valuesFn = vi.fn().mockReturnValue({ catch: catchFn });
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
  return { insertFn, valuesFn, catchFn };
});

vi.mock("@workspace/db", () => ({
  db: { insert: dbMocks.insertFn },
  aiCallLogsTable: { _brand: "aiCallLogsTable" },
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn() },
}));

import { logAiCall } from "./ai-call-logger";
import * as dbModule from "@workspace/db";

describe("logAiCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.catchFn.mockResolvedValue(undefined);
    dbMocks.valuesFn.mockReturnValue({ catch: dbMocks.catchFn });
    dbMocks.insertFn.mockReturnValue({ values: dbMocks.valuesFn });
  });

  it("calls db.insert with aiCallLogsTable", () => {
    logAiCall({
      jobId: "job-uuid-1",
      pageNumber: 3,
      callType: "bbox_detection",
      prompt: "Describe the image",
      responseJson: { signs: [] },
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 250,
    });

    expect(dbMocks.insertFn).toHaveBeenCalledOnce();
    expect(dbMocks.insertFn).toHaveBeenCalledWith(dbModule.aiCallLogsTable);
  });

  it("inserts a correctly shaped row with all fields", () => {
    logAiCall({
      jobId: "job-uuid-1",
      pageNumber: 3,
      callType: "bbox_detection",
      prompt: "Describe the image",
      responseJson: { signs: ["A101"] },
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 250,
    });

    expect(dbMocks.valuesFn).toHaveBeenCalledOnce();
    const [row] = dbMocks.valuesFn.mock.calls[0]!;
    expect(row).toMatchObject({
      jobId: "job-uuid-1",
      pageNumber: 3,
      callType: "bbox_detection",
      prompt: "Describe the image",
      responseJson: { signs: ["A101"] },
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 250,
    });
  });

  it("coerces undefined jobId and pageNumber to null", () => {
    logAiCall({
      callType: "project_info",
      prompt: "What is the project name?",
      responseJson: { name: "Acme HQ" },
      inputTokens: 20,
      outputTokens: 10,
      durationMs: 80,
    });

    const [row] = dbMocks.valuesFn.mock.calls[0]!;
    expect(row.jobId).toBeNull();
    expect(row.pageNumber).toBeNull();
  });

  it("coerces explicit null jobId and pageNumber to null", () => {
    logAiCall({
      jobId: null,
      pageNumber: null,
      callType: "vision_fallback",
      prompt: "test",
      responseJson: {},
      inputTokens: 5,
      outputTokens: 3,
      durationMs: 12,
    });

    const [row] = dbMocks.valuesFn.mock.calls[0]!;
    expect(row.jobId).toBeNull();
    expect(row.pageNumber).toBeNull();
  });

  it("attaches a .catch() handler so the insert is fire-and-forget", () => {
    logAiCall({
      callType: "project_info",
      prompt: "test",
      responseJson: {},
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    });

    expect(dbMocks.catchFn).toHaveBeenCalledOnce();
    expect(typeof dbMocks.catchFn.mock.calls[0]![0]).toBe("function");
  });

  it("does not throw synchronously when the db insert rejects", async () => {
    const err = new Error("db down (test)");
    dbMocks.valuesFn.mockReturnValueOnce(Promise.reject(err));

    expect(() =>
      logAiCall({
        callType: "vision_fallback",
        prompt: "test",
        responseJson: null,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      })
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
