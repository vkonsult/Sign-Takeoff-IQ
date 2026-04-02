import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/apiClient";

export function usePdfBlob(url: string | null): {
  pdfData: Uint8Array | null;
  blobError: string | null;
} {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setPdfData(null);
      setBlobError(null);
      return;
    }

    let cancelled = false;
    setPdfData(null);
    setBlobError(null);

    apiFetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) setPdfData(new Uint8Array(buf));
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setBlobError((err instanceof Error ? err.message : null) ?? "Failed to load PDF");
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { pdfData, blobError };
}
