import { useQueryClient } from "@tanstack/react-query";
import { 
  useUploadFiles, 
  useProcessJob, 
  useGetJob, 
  useListJobs,
  getGetJobQueryKey,
  getListJobsQueryKey
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/apiClient";

export function useJobsList() {
  const queryKey = getListJobsQueryKey();
  return useListJobs({
    query: {
      queryKey,
      refetchInterval: 10000,
    },
  });
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

export function downloadExport(jobId: string) {
  window.location.href = `/api/jobs/${jobId}/export`;
}
