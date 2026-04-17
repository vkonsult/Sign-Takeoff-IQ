const GUEST_TOKEN_KEY = "sign_iq_guest_token";

export function setGuestToken(token: string) {
  sessionStorage.setItem(GUEST_TOKEN_KEY, token);
}

export function clearGuestToken() {
  sessionStorage.removeItem(GUEST_TOKEN_KEY);
}

export function getGuestToken(): string | null {
  return sessionStorage.getItem(GUEST_TOKEN_KEY);
}

export function isGuestMode(): boolean {
  return !!getGuestToken();
}

/** Fetches the PDF with proper auth headers and opens it in a new browser tab as a blob URL.
 *  Works for both Clerk-authenticated users and guest-token sessions.
 *  Pass an optional `page` number to jump directly to that page (appends `#page=N`). */
export async function openPdfInNewTab(jobId: string, fileId: string, originalName: string, page?: number): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/files/${fileId}/pdf`);
  if (!res.ok) throw new Error(`Failed to load PDF: ${res.status}`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const url = page != null ? `${blobUrl}#page=${page}` : blobUrl;
  const win = window.open(url, "_blank");
  if (!win) {
    // Pop-up blocked — fall back to creating a temporary <a> click
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.download = originalName;
    a.click();
  }
  // Revoke after 60 s to free memory — the tab will have loaded by then
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const guestToken = getGuestToken();
  if (guestToken) {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${guestToken}`);
    }
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
}
