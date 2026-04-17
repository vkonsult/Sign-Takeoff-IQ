import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useUploadFiles, 
  useProcessJob, 
  useRetryFileExtraction,
  useGetJob, 
  useListJobs,
  getGetJobQueryKey,
  getListJobsQueryKey
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/apiClient";

export function useJobsList(includeArchived = false) {
  const standardQueryKey = getListJobsQueryKey();
  const archivedQueryKey = [...standardQueryKey, "includeArchived"];

  const hasProcessingJob = (data: unknown): boolean => {
    const jobs = (data as { jobs?: { status?: string }[] } | undefined)?.jobs ?? [];
    return jobs.some((j) => j.status === "processing" || j.status === "pending");
  };

  const standardResult = useListJobs({
    query: {
      queryKey: standardQueryKey,
      refetchInterval: (query) => hasProcessingJob(query.state.data) ? 5000 : false,
      enabled: !includeArchived,
    },
  });

  const archivedResult = useQuery({
    queryKey: archivedQueryKey,
    queryFn: async () => {
      const res = await apiFetch("/api/jobs?includeArchived=true");
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json() as Promise<{ jobs: unknown[] }>;
    },
    refetchInterval: (query) => hasProcessingJob(query.state.data) ? 5000 : false,
    enabled: includeArchived,
  });

  return includeArchived ? archivedResult : standardResult;
}

export function useJobDetails(jobId: string) {
  const queryKey = getGetJobQueryKey(jobId);
  return useGetJob(jobId, {
    query: {
      queryKey,
      refetchInterval: (query) => {
        const status = (query.state.data as { job?: { status?: string } } | undefined)?.job?.status;
        return status === "processing" || status === "pending" ? 3000 : false;
      },
    },
  });
}

export function useUploadJobFiles() {
  const queryClient = useQueryClient();
  return useUploadFiles({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
    }
  });
}

export function useStartExtraction() {
  const queryClient = useQueryClient();
  return useProcessJob({
    mutation: {
      onSuccess: (_result, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(variables.jobId) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
    }
  });
}

export function useRetryFile() {
  const queryClient = useQueryClient();
  return useRetryFileExtraction({
    mutation: {
      onSuccess: (_result, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(variables.jobId) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
    }
  });
}

export function useUpdateJobName(jobId: string) {
  const queryClient = useQueryClient();
  return async (name: string) => {
    const res = await apiFetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error("Failed to update job name");
    queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
  };
}

export async function downloadExport(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/export`);
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
  a.download = filenameMatch?.[1] ?? `sign-takeoff-${jobId}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
