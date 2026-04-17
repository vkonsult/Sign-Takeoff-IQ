import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJobsList, useJobDetails, useUploadJobFiles, useStartExtraction, useUpdateJobName } from "./use-takeoff";

let capturedStandardOptions: { query: { refetchInterval: (q: unknown) => unknown } } | null = null;
let capturedArchivedOptions: { refetchInterval: (q: unknown) => unknown } | null = null;
let capturedJobDetailOptions: { query: { refetchInterval: (q: unknown) => unknown } } | null = null;
let capturedUploadMutationOptions: { onSuccess?: (result: unknown, variables: unknown) => void } | null = null;
let capturedProcessMutationOptions: { onSuccess?: (result: unknown, variables: unknown) => void } | null = null;

const mockInvalidateQueries = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListJobs: vi.fn((options: typeof capturedStandardOptions) => {
    capturedStandardOptions = options;
    return {};
  }),
  useGetJob: vi.fn((_jobId: string, options: typeof capturedJobDetailOptions) => {
    capturedJobDetailOptions = options;
    return {};
  }),
  useUploadFiles: vi.fn((options: { mutation?: typeof capturedUploadMutationOptions }) => {
    capturedUploadMutationOptions = options?.mutation ?? null;
    return {};
  }),
  useProcessJob: vi.fn((options: { mutation?: typeof capturedProcessMutationOptions }) => {
    capturedProcessMutationOptions = options?.mutation ?? null;
    return {};
  }),
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
    useQueryClient: vi.fn(() => ({ invalidateQueries: mockInvalidateQueries })),
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

describe("useUploadJobFiles — cache invalidation", () => {
  beforeEach(() => {
    capturedUploadMutationOptions = null;
    mockInvalidateQueries.mockClear();
  });

  it("invalidates the jobs list query on success", () => {
    renderHook(() => useUploadJobFiles());
    expect(capturedUploadMutationOptions).not.toBeNull();
    capturedUploadMutationOptions!.onSuccess?.(undefined, undefined);
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["jobs"] });
  });
});

describe("useStartExtraction — cache invalidation", () => {
  beforeEach(() => {
    capturedProcessMutationOptions = null;
    mockInvalidateQueries.mockClear();
  });

  it("invalidates the individual job query on success", () => {
    renderHook(() => useStartExtraction());
    expect(capturedProcessMutationOptions).not.toBeNull();
    capturedProcessMutationOptions!.onSuccess?.(undefined, { jobId: "job-42" });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["job", "job-42"] });
  });

  it("invalidates the jobs list query on success", () => {
    renderHook(() => useStartExtraction());
    capturedProcessMutationOptions!.onSuccess?.(undefined, { jobId: "job-42" });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["jobs"] });
  });

  it("invalidates both the job detail and jobs list queries on success", () => {
    renderHook(() => useStartExtraction());
    capturedProcessMutationOptions!.onSuccess?.(undefined, { jobId: "job-99" });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
  });
});

describe("useUpdateJobName — PATCH request and cache invalidation", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
  });

  it("sends a PATCH request to the correct endpoint", async () => {
    const { apiFetch } = await import("@/lib/apiClient");
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true } as Response);

    const { result } = renderHook(() => useUpdateJobName("job-7"));
    await act(async () => {
      await result.current("New Name");
    });

    expect(mockApiFetch).toHaveBeenCalledWith("/api/jobs/job-7", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
  });

  it("invalidates the individual job query after a successful PATCH", async () => {
    const { apiFetch } = await import("@/lib/apiClient");
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true } as Response);

    const { result } = renderHook(() => useUpdateJobName("job-7"));
    await act(async () => {
      await result.current("New Name");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["job", "job-7"] });
  });

  it("invalidates the jobs list query after a successful PATCH", async () => {
    const { apiFetch } = await import("@/lib/apiClient");
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: true } as Response);

    const { result } = renderHook(() => useUpdateJobName("job-7"));
    await act(async () => {
      await result.current("New Name");
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["jobs"] });
  });

  it("throws when the PATCH request fails", async () => {
    const { apiFetch } = await import("@/lib/apiClient");
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: false } as Response);

    const { result } = renderHook(() => useUpdateJobName("job-7"));
    await expect(
      act(async () => {
        await result.current("Bad Name");
      })
    ).rejects.toThrow("Failed to update job name");
  });

  it("does not invalidate queries when the PATCH request fails", async () => {
    const { apiFetch } = await import("@/lib/apiClient");
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockResolvedValue({ ok: false } as Response);

    const { result } = renderHook(() => useUpdateJobName("job-7"));
    await act(async () => {
      await result.current("Bad Name").catch(() => {});
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});
