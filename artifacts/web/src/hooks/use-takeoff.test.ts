import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useJobsList, useJobDetails } from "./use-takeoff";

let capturedStandardOptions: { query: { refetchInterval: (q: unknown) => unknown } } | null = null;
let capturedArchivedOptions: { refetchInterval: (q: unknown) => unknown } | null = null;
let capturedJobDetailOptions: { query: { refetchInterval: (q: unknown) => unknown } } | null = null;

vi.mock("@workspace/api-client-react", () => ({
  useListJobs: vi.fn((options: typeof capturedStandardOptions) => {
    capturedStandardOptions = options;
    return {};
  }),
  useGetJob: vi.fn((_jobId: string, options: typeof capturedJobDetailOptions) => {
    capturedJobDetailOptions = options;
    return {};
  }),
  useUploadFiles: vi.fn(() => ({})),
  useProcessJob: vi.fn(() => ({})),
  getListJobsQueryKey: vi.fn(() => ["jobs"]),
  getGetJobQueryKey: vi.fn((id: string) => ["job", id]),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: vi.fn((options: typeof capturedArchivedOptions) => {
      capturedArchivedOptions = options;
      return {};
    }),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock("@/lib/apiClient", () => ({
  apiFetch: vi.fn(),
}));

function makeQuery(jobs: { status: string }[]) {
  return { state: { data: { jobs } } };
}

describe("useJobsList — refetchInterval for standard (non-archived) queries", () => {
  beforeEach(() => {
    capturedStandardOptions = null;
    capturedArchivedOptions = null;
    capturedJobDetailOptions = null;
  });

  it("polls every 5 s when a job has status 'pending'", () => {
    renderHook(() => useJobsList(false));
    expect(capturedStandardOptions).not.toBeNull();
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([{ status: "pending" }])
    );
    expect(interval).toBe(5000);
  });

  it("polls every 5 s when a job has status 'processing'", () => {
    renderHook(() => useJobsList(false));
    expect(capturedStandardOptions).not.toBeNull();
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([{ status: "processing" }])
    );
    expect(interval).toBe(5000);
  });

  it("polls every 5 s when the list contains a mix of active and terminal jobs", () => {
    renderHook(() => useJobsList(false));
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([{ status: "complete" }, { status: "pending" }])
    );
    expect(interval).toBe(5000);
  });

  it("stops polling when all jobs are 'complete'", () => {
    renderHook(() => useJobsList(false));
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([{ status: "complete" }, { status: "complete" }])
    );
    expect(interval).toBe(false);
  });

  it("stops polling when all jobs are 'failed'", () => {
    renderHook(() => useJobsList(false));
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([{ status: "failed" }])
    );
    expect(interval).toBe(false);
  });

  it("stops polling when the job list is empty", () => {
    renderHook(() => useJobsList(false));
    const interval = capturedStandardOptions!.query.refetchInterval(
      makeQuery([])
    );
    expect(interval).toBe(false);
  });

  it("stops polling when data is undefined (initial load)", () => {
    renderHook(() => useJobsList(false));
    const interval = capturedStandardOptions!.query.refetchInterval(
      { state: { data: undefined } }
    );
    expect(interval).toBe(false);
  });
});

describe("useJobsList — refetchInterval for archived queries", () => {
  beforeEach(() => {
    capturedStandardOptions = null;
    capturedArchivedOptions = null;
    capturedJobDetailOptions = null;
  });

  it("polls every 5 s when an archived job has status 'pending'", () => {
    renderHook(() => useJobsList(true));
    expect(capturedArchivedOptions).not.toBeNull();
    const interval = capturedArchivedOptions!.refetchInterval(
      makeQuery([{ status: "pending" }])
    );
    expect(interval).toBe(5000);
  });

  it("polls every 5 s when an archived job has status 'processing'", () => {
    renderHook(() => useJobsList(true));
    const interval = capturedArchivedOptions!.refetchInterval(
      makeQuery([{ status: "processing" }])
    );
    expect(interval).toBe(5000);
  });

  it("stops polling for archived list when all jobs are terminal", () => {
    renderHook(() => useJobsList(true));
    const interval = capturedArchivedOptions!.refetchInterval(
      makeQuery([{ status: "complete" }, { status: "failed" }])
    );
    expect(interval).toBe(false);
  });

  it("stops polling for archived list when data is undefined", () => {
    renderHook(() => useJobsList(true));
    const interval = capturedArchivedOptions!.refetchInterval(
      { state: { data: undefined } }
    );
    expect(interval).toBe(false);
  });
});

function makeJobQuery(status: string | undefined) {
  return { state: { data: status !== undefined ? { job: { status } } : undefined } };
}

describe("useJobDetails — refetchInterval", () => {
  beforeEach(() => {
    capturedStandardOptions = null;
    capturedArchivedOptions = null;
    capturedJobDetailOptions = null;
  });

  it("polls every 3 s when the job status is 'pending'", () => {
    renderHook(() => useJobDetails("job-1"));
    expect(capturedJobDetailOptions).not.toBeNull();
    const interval = capturedJobDetailOptions!.query.refetchInterval(
      makeJobQuery("pending")
    );
    expect(interval).toBe(3000);
  });

  it("polls every 3 s when the job status is 'processing'", () => {
    renderHook(() => useJobDetails("job-1"));
    const interval = capturedJobDetailOptions!.query.refetchInterval(
      makeJobQuery("processing")
    );
    expect(interval).toBe(3000);
  });

  it("stops polling when the job status is 'complete'", () => {
    renderHook(() => useJobDetails("job-1"));
    const interval = capturedJobDetailOptions!.query.refetchInterval(
      makeJobQuery("complete")
    );
    expect(interval).toBe(false);
  });

  it("stops polling when the job status is 'failed'", () => {
    renderHook(() => useJobDetails("job-1"));
    const interval = capturedJobDetailOptions!.query.refetchInterval(
      makeJobQuery("failed")
    );
    expect(interval).toBe(false);
  });

  it("stops polling when data is undefined (initial load)", () => {
    renderHook(() => useJobDetails("job-1"));
    const interval = capturedJobDetailOptions!.query.refetchInterval(
      makeJobQuery(undefined)
    );
    expect(interval).toBe(false);
  });
});
