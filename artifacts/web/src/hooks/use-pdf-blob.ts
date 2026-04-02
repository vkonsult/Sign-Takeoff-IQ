import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/apiClient";

export function usePdfBlob(url: string | null): { blobUrl: string | null; blobError: string | null } {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setBlobUrl(null);
      setBlobError(null);
      return;
    }

    let objectUrl: string | null = null;
    setBlobUrl(null);
    setBlobError(null);

    apiFetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch((err: unknown) => {
        setBlobError((err instanceof Error ? err.message : null) ?? "Failed to load PDF");
      });

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return { blobUrl, blobError };
}
