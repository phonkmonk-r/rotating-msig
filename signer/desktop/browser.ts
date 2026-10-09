import { appendFileSync, readFileSync } from "node:fs";

import { ipcMain, session as electronSession, shell, WebContentsView, type BrowserWindow } from "electron";

import { DappProvider, ProviderError, USER_REJECTED, type DappRequest } from "../src/dapp.js";
import type { DraftItem, ProposalResult, SignerSession } from "../src/session.js";

/** Cookies and storage of dApps live in their own partition, apart from the app's UI. */
const PARTITION = "persist:dapps";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

/** Clears every dApp's cookies and storage, for when no profile is left on this computer. */
export async function clearDappStorage(): Promise<void> {
  await electronSession.fromPartition(PARTITION).clearStorageData();
}

function allowed(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

/** https anywhere, plain http only for a dApp running on this machine. A bare host gets https://. */
export function browsableUrl(input: string): string {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (!allowed(url)) throw new Error("only https:// pages can be opened");
  return url.toString();
}

function navigable(url: string): boolean {
  try {
    return allowed(new URL(url));
  } catch {
    return false;
  }
}

interface Pending {
  request: DappRequest;
  resolve: (result: ProposalResult | { queued: DraftItem }) => void;
  reject: (error: Error) => void;
}

/**
 * The dApp browser: a sandboxed view inside the main window whose pages see the Safe as their wallet. Pages get no
 * Node, no access to the app's IPC beyond `dapp:request`, and no permissions; every transaction they ask for waits
 * for the user's review in the app's own UI, where the view is hidden.
 */
export class DappBrowser {
  private view?: WebContentsView;
  private pending?: Pending;
  readonly provider: DappProvider;

  constructor(
    private readonly deps: {
      window: () => BrowserWindow | undefined;
      session: () => SignerSession | undefined;
      preload: string;
      /** Sends an event to the app's UI. */
      send: (channel: string, payload: unknown) => void;
    },
  ) {
    this.provider = new DappProvider({ session: deps.session, review: (request) => this.review(request) });

    const partition = electronSession.fromPartition(PARTITION);
    partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    partition.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");

    ipcMain.handle("dapp:request", async (event, method: unknown, params: unknown) => {
      if (!this.view || event.sender !== this.view.webContents) return { error: { code: 4100, message: "Unauthorized" } };
      const origin = event.senderFrame?.origin ?? "unknown";
      let reply: { result?: unknown; error?: { code: number; message: string; data?: string } };
      try {
        reply = { result: await this.provider.request(origin, String(method), params) };
      } catch (error) {
        reply = { error: { code: error instanceof ProviderError ? error.code : -32603, message: (error as Error).message, data: error instanceof ProviderError ? error.data : undefined } };
      }
      // Debugging aid for dApp compatibility: every request and reply, one JSON line each.
      const log = process.env.ROTATION_SIGNER_DEBUG_DAPP;
      if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), method, params, reply }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)).slice(0, 2000) + "\n");
      return reply;
    });
  }

  open(url: string): BrowserState {
    const target = browsableUrl(url);
    const view = this.ensureView();
    void view.webContents.loadURL(target);
    return this.state();
  }

  navigate(action: "back" | "forward" | "reload" | "stop"): void {
    const contents = this.view?.webContents;
    if (!contents) return;
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
    if (action === "stop") contents.stop();
  }

  /** Places the view over the UI's viewport, or hides it with `null`. */
  setBounds(bounds: Bounds | null): void {
    if (!this.view) return;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.view.setVisible(false);
      return;
    }
    this.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    this.view.setVisible(true);
  }

  state(): BrowserState {
    const contents = this.view?.webContents;
    if (!contents) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
  }

  /** Test hook: the page as an image (window captures leave out child views). */
  async capture(): Promise<Buffer | undefined> {
    return this.view ? (await this.view.webContents.capturePage()).toPNG() : undefined;
  }

  pendingRequest(): DappRequest | null {
    return this.pending?.request ?? null;
  }

  preview(id: string): Promise<ProposalResult> {
    return this.requireSession().propose(this.input(id), true);
  }

  /** Proposes exactly what the dApp asked for; the UI only names the request. */
  async approve(id: string): Promise<ProposalResult> {
    const result = await this.requireSession().propose(this.input(id));
    this.settle()?.resolve(result);
    return result;
  }

  /** Queues exactly what the dApp asked for instead of proposing it now. */
  async queue(id: string): Promise<DraftItem> {
    const request = this.pending?.request;
    if (!request || request.id !== id) throw new Error("this request is no longer waiting");
    const item = await this.requireSession().addToDraft(this.input(id), request.origin);
    this.settle()?.resolve({ queued: item });
    return item;
  }

  reject(id: string): void {
    if (this.pending?.request.id !== id) return;
    this.settle()?.reject(new ProviderError(USER_REJECTED, "User rejected the request"));
  }

  /** Closes the page and refuses any request waiting for review; used on lock and when the Safe changes. */
  close(): void {
    this.settle()?.reject(new ProviderError(4900, "Keyturn was locked"));
    if (!this.view) return;
    this.deps.window()?.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = undefined;
    this.deps.send("browser:state", this.state());
  }

  private review(request: DappRequest): Promise<ProposalResult | { queued: DraftItem }> {
    if (!this.deps.window()) return Promise.reject(new ProviderError(4900, "Keyturn is not open"));
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject };
      this.deps.send("browser:request", request);
      if (process.env.ROTATION_SIGNER_TEST_AUTOQUEUE) void this.queue(request.id).catch(reject);
    });
  }

  private settle(): Pending | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.deps.send("browser:request", null);
    return pending;
  }

  private input(id: string) {
    const request = this.pending?.request;
    if (!request || request.id !== id) throw new Error("this request is no longer waiting");
    return { kind: "calls" as const, origin: request.origin, calls: request.calls };
  }

  private requireSession(): SignerSession {
    const session = this.deps.session();
    if (!session) throw new Error("the signer is locked");
    return session;
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const window = this.deps.window();
    if (!window) throw new Error("no window");
    const view = new WebContentsView({
      webPreferences: { preload: this.deps.preload, partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    view.setVisible(false);
    window.contentView.addChildView(view);

    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      if (!navigable(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!navigable(event.url)) event.preventDefault();
    });
    const script = process.env.ROTATION_SIGNER_TEST_DAPP_SCRIPT;
    if (script) contents.once("did-finish-load", () => void contents.executeJavaScript(readFileSync(script, "utf8")).catch(() => undefined));
    const update = () => this.deps.send("browser:state", this.state());
    for (const name of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      contents.on(name as "did-start-loading", update);
    }
    this.view = view;
    return view;
  }
}
