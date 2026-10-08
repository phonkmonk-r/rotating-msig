import type { ProposalInput } from "@rotating-msig/core";

import type { DappRequest } from "../../src/dapp.js";
import type { Execution, ProposalResult, QueueItem, SignerView, StatusView, TokenInfo } from "../../src/session.js";

export type { DappRequest, Execution, ProposalInput, ProposalResult, QueueItem, SignerView, StatusView, TokenInfo };

/** The dApp browser's page, as the main process reports it. */
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreeSummary {
  safe: string;
  chainId: number;
  slotId: number;
  size: number;
  base: number;
}

export interface DesktopSettings {
  safe: string;
  chainId: number;
  slotId: number;
  rpc: string;
  executionRpc: string;
}

export interface Advanced {
  chainId?: number;
  rpc?: string;
  executionRpc?: string;
}

export interface JoinProgress {
  stage: "network" | "reading" | "finding" | "deriving" | "verifying";
  done?: number;
  total?: number;
}

export interface DesktopState {
  vault: { exists: boolean; unlocked: boolean; operator?: string };
  configured: boolean;
  settings?: DesktopSettings;
  tree?: TreeSummary;
  error?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The desktop app's preload bridge (`desktop/preload.cjs`); absent when the UI runs in a browser from the CLI. */
interface DesktopBridge {
  state(): Promise<Result<DesktopState>>;
  join(safe: string, advanced: Advanced): Promise<Result<true>>;
  onProgress(listener: (progress: JoinProgress) => void): () => void;
  createVault(mnemonic: string, password: string): Promise<Result<true>>;
  unlock(password: string): Promise<Result<true>>;
  lock(): Promise<Result<true>>;
  reset(): Promise<Result<true>>;
  status(): Promise<Result<StatusView>>;
  queue(): Promise<Result<QueueItem[]>>;
  confirm(hash: string): Promise<Result<{ owner: string }>>;
  execute(hash: string): Promise<Result<Execution>>;
  execution(hash: string): Promise<Result<Execution>>;
  propose(input: ProposalInput, preview: boolean): Promise<Result<ProposalResult>>;
  token(address: string): Promise<Result<TokenInfo>>;
  browserOpen(url: string): Promise<Result<BrowserState>>;
  browserBounds(bounds: Bounds | null): Promise<Result<null>>;
  browserNavigate(action: "back" | "forward" | "reload" | "stop"): Promise<Result<null>>;
  browserState(): Promise<Result<BrowserState>>;
  browserClose(): Promise<Result<null>>;
  browserPending(): Promise<Result<DappRequest | null>>;
  browserPreview(id: string): Promise<Result<ProposalResult>>;
  browserApprove(id: string): Promise<Result<ProposalResult>>;
  browserReject(id: string): Promise<Result<null>>;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onBrowserRequest(listener: (request: DappRequest | null) => void): () => void;
}

const bridge = (window as unknown as { signer?: DesktopBridge }).signer;

export const isDesktop = bridge !== undefined;

async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.error);
  return settled.value;
}

const TOKEN_KEY = "rotation-signer-token";

/** Browser mode only: takes the session token from the URL fragment once, then keeps it for this tab. */
function sessionToken(): string {
  if (isDesktop) return "";
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

/** Whether the UI can reach a signer: through the desktop bridge, or with a session token from the CLI. */
export const canConnect = isDesktop || token !== "";

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body as T;
}

const post = (safeTxHash: string) => ({ method: "POST", body: JSON.stringify({ safeTxHash }) });

export const api = {
  status: () => (bridge ? unwrap(bridge.status()) : http<StatusView>("/api/status")),
  queue: () => (bridge ? unwrap(bridge.queue()) : http<QueueItem[]>("/api/queue")),
  confirm: (hash: string) => (bridge ? unwrap(bridge.confirm(hash)) : http<{ owner: string }>("/api/confirm", post(hash))),
  execute: (hash: string) => (bridge ? unwrap(bridge.execute(hash)) : http<Execution>("/api/execute", post(hash))),
  execution: (hash: string) => (bridge ? unwrap(bridge.execution(hash)) : http<Execution>(`/api/executions/${hash}`)),
  propose: (input: ProposalInput, preview: boolean) =>
    bridge ? unwrap(bridge.propose(input, preview)) : http<ProposalResult>("/api/propose", { method: "POST", body: JSON.stringify({ input, preview }) }),
  token: (address: string) => (bridge ? unwrap(bridge.token(address)) : http<TokenInfo>(`/api/token?address=${encodeURIComponent(address)}`)),
};

/** Desktop-only calls; never used in browser mode. */
export const desktop = bridge
  ? {
      state: () => unwrap(bridge.state()),
      join: (safe: string, advanced: Advanced) => unwrap(bridge.join(safe, advanced)),
      onProgress: (listener: (progress: JoinProgress) => void) => bridge.onProgress(listener),
      createVault: (mnemonic: string, password: string) => unwrap(bridge.createVault(mnemonic, password)),
      unlock: (password: string) => unwrap(bridge.unlock(password)),
      lock: () => unwrap(bridge.lock()),
      reset: () => unwrap(bridge.reset()),
    }
  : undefined;

/** The dApp browser; desktop only. */
export const browser = bridge
  ? {
      open: (url: string) => unwrap(bridge.browserOpen(url)),
      bounds: (bounds: Bounds | null) => unwrap(bridge.browserBounds(bounds)),
      navigate: (action: "back" | "forward" | "reload" | "stop") => unwrap(bridge.browserNavigate(action)),
      state: () => unwrap(bridge.browserState()),
      close: () => unwrap(bridge.browserClose()),
      pending: () => unwrap(bridge.browserPending()),
      preview: (id: string) => unwrap(bridge.browserPreview(id)),
      approve: (id: string) => unwrap(bridge.browserApprove(id)),
      reject: (id: string) => unwrap(bridge.browserReject(id)),
      onState: (listener: (state: BrowserState) => void) => bridge.onBrowserState(listener),
      onRequest: (listener: (request: DappRequest | null) => void) => bridge.onBrowserRequest(listener),
    }
  : undefined;
