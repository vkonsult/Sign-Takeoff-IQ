import { useQueryClient } from "@tanstack/react-query";
import { 
  useUploadFiles, 
  useProcessJob, 
  useGetJob, 
  useListJobs,
  getGetJobQueryKey,
  getListJobsQueryKey
} from "@workspace/api-client-react";

export function useJobsList() {
  return useListJobs({
    query: {
      refetchInterval: 10000,
    } as any,
  });
}

export function useJobDetails(jobId: string) {
  return useGetJob(jobId, {
    query: {
      refetchInterval: (query: { state: { data?: { job?: { status?: string } } } }) => {
        const status = query.state.data?.job?.status;
        return status === "processing" || status === "pending" ? 3000 : false;
      },
    } as any,
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
      onSuccess: (_: unknown, variables: { jobId: string }) => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(variables.jobId) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
    }
  });
}

export function downloadExport(jobId: string) {
  window.location.href = `/api/jobs/${jobId}/export`;
}
