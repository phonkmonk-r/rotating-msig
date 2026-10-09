import type { DappCall, ProposalInput } from "@rotating-msig/core";

import type { DappRequest } from "../../src/dapp.js";
import type { DraftItem, DraftView, Execution, Exposure, ProposalResult, QueueItem, Refill, SignerView, StatusView, TokenInfo } from "../../src/session.js";
import type { Simulation } from "../../src/simulate.js";

export type { DappCall, DappRequest, DraftItem, DraftView, Execution, Exposure, ProposalInput, ProposalResult, QueueItem, Refill, Simulation, SignerView, StatusView, TokenInfo };

/** A page the user saved for quick access in the dApp browser. */
export interface Bookmark {
  url: string;
  title: string;
  /** The site's icon as a data URL, when it had one. */
  icon?: string;
}

/** One open page in the dApp browser; a new tab has no URL until something is opened in it. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  /** The page's icon as a data URL. */
  icon?: string;
}

/** The dApp browser's selected page and every open tab, as the main process reports them. */
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  tabs: BrowserTab[];
  activeTab?: number;
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

/** A signing identity: an encrypted seed or a Ledger, each with its own Safe. */
export interface Profile {
  id: string;
  name: string;
  kind: "seed" | "ledger";
  operator: string;
  createdAt: string;
}

export interface ProfileView extends Profile {
  /** The Safe this profile shows, if any. */
  safe?: string;
  chainId?: number;
  /** How many Safes this profile signs for. */
  safeCount: number;
}

/** One Safe of the profile in use, for the switcher. */
export interface SafeSummary {
  key: string;
  safe: string;
  chainId: number;
  chainName: string;
  slotId: number;
  active: boolean;
  /** Its session started; otherwise `error` says why. */
  running: boolean;
  error?: string;
  /** Pending transactions waiting for this signer (unknown if not running). */
  needsYou?: number;
  queued: number;
}

export interface DesktopState {
  profiles: ProfileView[];
  /** The profile in use; `vault` describes whether it is unlocked. */
  profile?: Profile;
  /** How many Safes the profile in use signs for. */
  safeCount: number;
  vault: { exists: boolean; unlocked: boolean; operator?: string };
  configured: boolean;
  /** A new Safe is being set up (as its creator or as an invited signer). */
  creating: boolean;
  settings?: DesktopSettings;
  tree?: TreeSummary;
  error?: string;
}

/** A new Safe being set up, as the setup screens show it. */
export interface CreatingView {
  role: "creator" | "signer";
  safe: string;
  chainId: number;
  chainName: string;
  threshold: number;
  inviteCode: string;
  slots: { slotId: number; operator: string; isMe: boolean; received: boolean }[];
  /** This signer's slot package, to send to the creator. */
  myPackage?: string;
  /** Every package is in. */
  ready: boolean;
  /** Creator only: the operator account's balance and a generous estimate of the gas cost, in wei. */
  balance?: string;
  estimatedCost?: string;
}

/** This signer being added to an existing Safe, waiting for the slot to be created. */
export interface AddingView {
  safe: string;
  chainId: number;
  chainName: string;
  slotId: number;
  myPackage: string;
}

export type CreateStage = "deploying" | "installing" | "done" | "joining";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The desktop app's preload bridge (`desktop/preload.cjs`); absent when the UI runs in a browser from the CLI. */
interface DesktopBridge {
  state(): Promise<Result<DesktopState>>;
  join(safe: string, advanced: Advanced): Promise<Result<true>>;
  onProgress(listener: (progress: JoinProgress) => void): () => void;
  addSeedProfile(name: string, mnemonic: string, password: string): Promise<Result<Profile>>;
  addLedgerProfile(name: string): Promise<Result<Profile>>;
  selectProfile(id: string): Promise<Result<true>>;
  deselectProfile(): Promise<Result<true>>;
  renameProfile(id: string, name: string): Promise<Result<Profile>>;
  removeProfile(id: string): Promise<Result<true>>;
  connectLedger(): Promise<Result<true>>;
  listSafes(): Promise<Result<SafeSummary[]>>;
  selectSafe(key: string): Promise<Result<true>>;
  removeSafe(key: string): Promise<Result<true>>;
  unlock(password: string): Promise<Result<true>>;
  lock(): Promise<Result<true>>;
  reset(): Promise<Result<true>>;
  status(): Promise<Result<StatusView>>;
  queue(): Promise<Result<QueueItem[]>>;
  confirm(hash: string): Promise<Result<{ owner: string }>>;
  execute(hash: string): Promise<Result<Execution>>;
  execution(hash: string): Promise<Result<Execution>>;
  executions(): Promise<Result<Execution[]>>;
  speedUp(hash: string): Promise<Result<Execution>>;
  recover(preview: boolean): Promise<Result<ProposalResult & { slotIds: number[] }>>;
  propose(input: ProposalInput, preview: boolean): Promise<Result<ProposalResult>>;
  token(address: string): Promise<Result<TokenInfo>>;
  refill(): Promise<Result<Refill | null>>;
  skipUsedKeys(): Promise<Result<ProposalInput>>;
  renewKeys(): Promise<Result<ProposalInput>>;
  browserQueue(id: string): Promise<Result<DraftItem>>;
  draft(): Promise<Result<DraftView>>;
  draftMode(enabled: boolean): Promise<Result<DraftView>>;
  draftAdd(input: ProposalInput): Promise<Result<DraftItem>>;
  draftRemove(id: string): Promise<Result<DraftView>>;
  draftMove(id: string, offset: number): Promise<Result<DraftView>>;
  draftClear(): Promise<Result<DraftView>>;
  draftSimulate(): Promise<Result<Simulation>>;
  draftPropose(preview: boolean): Promise<Result<ProposalResult>>;
  browserOpen(url: string): Promise<Result<BrowserState>>;
  bookmarksList(): Promise<Result<Bookmark[]>>;
  bookmarksAdd(url: string, icon?: string): Promise<Result<Bookmark[]>>;
  bookmarksRename(url: string, title: string): Promise<Result<Bookmark[]>>;
  bookmarksRemove(url: string): Promise<Result<Bookmark[]>>;
  browserNewTab(url?: string): Promise<Result<BrowserState>>;
  browserSelectTab(id: number): Promise<Result<BrowserState>>;
  browserCloseTab(id: number): Promise<Result<BrowserState>>;
  browserBounds(bounds: Bounds | null): Promise<Result<null>>;
  browserNavigate(action: "back" | "forward" | "reload" | "stop"): Promise<Result<null>>;
  browserState(): Promise<Result<BrowserState>>;
  browserClose(): Promise<Result<null>>;
  browserPending(): Promise<Result<DappRequest | null>>;
  browserPreview(id: string): Promise<Result<ProposalResult>>;
  browserApprove(id: string): Promise<Result<ProposalResult>>;
  browserReject(id: string): Promise<Result<null>>;
  creatingState(): Promise<Result<CreatingView | null>>;
  createPlan(chainId: number, coSigners: string[], threshold: number): Promise<Result<true>>;
  createAccept(code: string): Promise<Result<true>>;
  createAdd(code: string): Promise<Result<number>>;
  createLaunch(): Promise<Result<true>>;
  createCheck(): Promise<Result<boolean>>;
  createCancel(): Promise<Result<true>>;
  addingState(): Promise<Result<AddingView | null>>;
  addingPrepare(safe: string): Promise<Result<true>>;
  addingCheck(): Promise<Result<boolean>>;
  addingCancel(): Promise<Result<true>>;
  onCreateStage(listener: (stage: CreateStage) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onBrowserRequest(listener: (request: DappRequest | null) => void): () => void;
  onBookmarks(listener: (list: Bookmark[]) => void): () => void;
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

const draftHttp = <T>(body: object) => http<T>("/api/draft", { method: "POST", body: JSON.stringify(body) });

const post = (safeTxHash: string) => ({ method: "POST", body: JSON.stringify({ safeTxHash }) });

export const api = {
  status: () => (bridge ? unwrap(bridge.status()) : http<StatusView>("/api/status")),
  queue: () => (bridge ? unwrap(bridge.queue()) : http<QueueItem[]>("/api/queue")),
  confirm: (hash: string) => (bridge ? unwrap(bridge.confirm(hash)) : http<{ owner: string }>("/api/confirm", post(hash))),
  execute: (hash: string) => (bridge ? unwrap(bridge.execute(hash)) : http<Execution>("/api/execute", post(hash))),
  execution: (hash: string) => (bridge ? unwrap(bridge.execution(hash)) : http<Execution>(`/api/executions/${hash}`)),
  executions: () => (bridge ? unwrap(bridge.executions()) : http<Execution[]>("/api/executions")),
  speedUp: (hash: string) => (bridge ? unwrap(bridge.speedUp(hash)) : http<Execution>("/api/speed-up", post(hash))),
  recover: (preview: boolean) =>
    bridge ? unwrap(bridge.recover(preview)) : http<ProposalResult & { slotIds: number[] }>("/api/recover", { method: "POST", body: JSON.stringify({ preview }) }),
  propose: (input: ProposalInput, preview: boolean) =>
    bridge ? unwrap(bridge.propose(input, preview)) : http<ProposalResult>("/api/propose", { method: "POST", body: JSON.stringify({ input, preview }) }),
  draft: () => (bridge ? unwrap(bridge.draft()) : http<DraftView>("/api/draft")),
  draftMode: (enabled: boolean) => (bridge ? unwrap(bridge.draftMode(enabled)) : draftHttp<DraftView>({ action: "mode", enabled })),
  draftAdd: (input: ProposalInput) => (bridge ? unwrap(bridge.draftAdd(input)) : draftHttp<DraftItem>({ action: "add", input })),
  draftRemove: (id: string) => (bridge ? unwrap(bridge.draftRemove(id)) : draftHttp<DraftView>({ action: "remove", id })),
  draftMove: (id: string, offset: number) => (bridge ? unwrap(bridge.draftMove(id, offset)) : draftHttp<DraftView>({ action: "move", id, offset })),
  draftClear: () => (bridge ? unwrap(bridge.draftClear()) : draftHttp<DraftView>({ action: "clear" })),
  draftSimulate: () => (bridge ? unwrap(bridge.draftSimulate()) : draftHttp<Simulation>({ action: "simulate" })),
  draftPropose: (preview: boolean) => (bridge ? unwrap(bridge.draftPropose(preview)) : draftHttp<ProposalResult>({ action: "propose", preview })),
  renewKeys: () => (bridge ? unwrap(bridge.renewKeys()) : http<ProposalInput>("/api/renew-keys", { method: "POST", body: "{}" })),
  skipUsedKeys: () => (bridge ? unwrap(bridge.skipUsedKeys()) : http<ProposalInput>("/api/skip-used-keys", { method: "POST", body: "{}" })),
  refill: () => (bridge ? unwrap(bridge.refill()) : http<Refill | null>("/api/refill", { method: "POST", body: "{}" })),
  token: (address: string) => (bridge ? unwrap(bridge.token(address)) : http<TokenInfo>(`/api/token?address=${encodeURIComponent(address)}`)),
};

/** Desktop-only calls; never used in browser mode. */
export const desktop = bridge
  ? {
      state: () => unwrap(bridge.state()),
      join: (safe: string, advanced: Advanced) => unwrap(bridge.join(safe, advanced)),
      onProgress: (listener: (progress: JoinProgress) => void) => bridge.onProgress(listener),
      addSeedProfile: (name: string, mnemonic: string, password: string) => unwrap(bridge.addSeedProfile(name, mnemonic, password)),
      addLedgerProfile: (name: string) => unwrap(bridge.addLedgerProfile(name)),
      selectProfile: (id: string) => unwrap(bridge.selectProfile(id)),
      deselectProfile: () => unwrap(bridge.deselectProfile()),
      renameProfile: (id: string, name: string) => unwrap(bridge.renameProfile(id, name)),
      removeProfile: (id: string) => unwrap(bridge.removeProfile(id)),
      connectLedger: () => unwrap(bridge.connectLedger()),
      listSafes: () => unwrap(bridge.listSafes()),
      selectSafe: (key: string) => unwrap(bridge.selectSafe(key)),
      removeSafe: (key: string) => unwrap(bridge.removeSafe(key)),
      unlock: (password: string) => unwrap(bridge.unlock(password)),
      lock: () => unwrap(bridge.lock()),
      reset: () => unwrap(bridge.reset()),
      creatingState: () => unwrap(bridge.creatingState()),
      createPlan: (chainId: number, coSigners: string[], threshold: number) => unwrap(bridge.createPlan(chainId, coSigners, threshold)),
      createAccept: (code: string) => unwrap(bridge.createAccept(code)),
      createAdd: (code: string) => unwrap(bridge.createAdd(code)),
      createLaunch: () => unwrap(bridge.createLaunch()),
      createCheck: () => unwrap(bridge.createCheck()),
      createCancel: () => unwrap(bridge.createCancel()),
      addingState: () => unwrap(bridge.addingState()),
      addingPrepare: (safe: string) => unwrap(bridge.addingPrepare(safe)),
      addingCheck: () => unwrap(bridge.addingCheck()),
      addingCancel: () => unwrap(bridge.addingCancel()),
      onCreateStage: (listener: (stage: CreateStage) => void) => bridge.onCreateStage(listener),
    }
  : undefined;

/** The dApp browser; desktop only. */
export const browser = bridge
  ? {
      open: (url: string) => unwrap(bridge.browserOpen(url)),
      newTab: (url?: string) => unwrap(bridge.browserNewTab(url)),
      bookmarks: () => unwrap(bridge.bookmarksList()),
      addBookmark: (url: string, icon?: string) => unwrap(bridge.bookmarksAdd(url, icon)),
      renameBookmark: (url: string, title: string) => unwrap(bridge.bookmarksRename(url, title)),
      removeBookmark: (url: string) => unwrap(bridge.bookmarksRemove(url)),
      onBookmarks: (listener: (list: Bookmark[]) => void) => bridge.onBookmarks(listener),
      selectTab: (id: number) => unwrap(bridge.browserSelectTab(id)),
      closeTab: (id: number) => unwrap(bridge.browserCloseTab(id)),
      bounds: (bounds: Bounds | null) => unwrap(bridge.browserBounds(bounds)),
      navigate: (action: "back" | "forward" | "reload" | "stop") => unwrap(bridge.browserNavigate(action)),
      state: () => unwrap(bridge.browserState()),
      close: () => unwrap(bridge.browserClose()),
      pending: () => unwrap(bridge.browserPending()),
      preview: (id: string) => unwrap(bridge.browserPreview(id)),
      approve: (id: string) => unwrap(bridge.browserApprove(id)),
      reject: (id: string) => unwrap(bridge.browserReject(id)),
      queue: (id: string) => unwrap(bridge.browserQueue(id)),
      onState: (listener: (state: BrowserState) => void) => bridge.onBrowserState(listener),
      onRequest: (listener: (request: DappRequest | null) => void) => bridge.onBrowserRequest(listener),
    }
  : undefined;
