import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/apiClient";

/**
 * Fetches a PDF from an authenticated API route and holds the raw bytes in
 * memory as an ArrayBuffer.  Callers must create a FRESH copy via
 *   new Uint8Array(pdfBuffer.slice(0))
 * before passing the data to react-pdf or pdfjs — both transfer the underlying
 * ArrayBuffer, which would detach it and break subsequent reads.
 */
export function usePdfBlob(url: string | null): {
  pdfBuffer: ArrayBuffer | null;
  blobError: string | null;
} {
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setPdfBuffer(null);
      setBlobError(null);
      return;
    }

    let cancelled = false;
    setPdfBuffer(null);
    setBlobError(null);

    apiFetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) setPdfBuffer(buf);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setBlobError((err instanceof Error ? err.message : null) ?? "Failed to load PDF");
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { pdfBuffer, blobError };
}
