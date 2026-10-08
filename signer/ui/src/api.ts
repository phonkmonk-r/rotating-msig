import type { ExecuteResult, QueueItem, StatusView } from "../../src/session.js";

export type { ExecuteResult, QueueItem, StatusView };

const TOKEN_KEY = "rotation-signer-token";

/** Takes the session token from the URL fragment once, then keeps it for this tab only. */
function sessionToken(): string {
  const match = window.location.hash.match(/token=([\w-]+)/);
  if (match?.[1]) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // Storage unavailable: the token still works until reload.
    }
    window.history.replaceState(null, "", window.location.pathname);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const token = sessionToken();

export const hasToken = token !== "";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body as T;
}

export const api = {
  status: () => call<StatusView>("/api/status"),
  queue: () => call<QueueItem[]>("/api/queue"),
  confirm: (safeTxHash: string) => call<{ owner: string }>("/api/confirm", { method: "POST", body: JSON.stringify({ safeTxHash }) }),
  execute: (safeTxHash: string) => call<ExecuteResult>("/api/execute", { method: "POST", body: JSON.stringify({ safeTxHash }) }),
};
