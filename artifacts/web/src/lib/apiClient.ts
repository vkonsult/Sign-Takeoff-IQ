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
