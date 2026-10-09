import { appendFileSync, readFileSync } from "node:fs";

import { ipcMain, session as electronSession, shell, WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from "electron";

import { DappProvider, ProviderError, USER_REJECTED, type DappRequest } from "../src/dapp.js";
import type { DraftItem, ProposalResult, SignerSession } from "../src/session.js";

/** Cookies and storage of dApps live in their own partition, apart from the app's UI. */
const PARTITION = "persist:dapps";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A page the user saved for quick access. */
export interface Bookmark {
  url: string;
  title: string;
  /** The site's icon as a data URL, when it had one. */
  icon?: string;
}

/** One open page; a new tab has no URL until something is opened in it. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  /** The page's icon as a data URL (the app's UI loads no remote images). */
  icon?: string;
}

/** The selected tab's page, plus every open tab in order. */
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

/** The close-tab shortcut: Cmd+W on macOS, Ctrl+W elsewhere. */
export function isCloseShortcut(input: { type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }): boolean {
  const modifier = process.platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && input.key.toLowerCase() === "w" && modifier && !input.shift && !input.alt;
}

/** Most an icon may weigh; it is sent to the UI as a data URL. */
const MAX_ICON_BYTES = 64 * 1024;

/** The first of a page's icons that loads, as a data URL, fetched in the dApp session; undefined if none does. */
async function fetchIcon(contents: WebContents, urls: readonly string[]): Promise<string | undefined> {
  for (const url of urls.slice(0, 3)) {
    if (!/^https?:\/\//.test(url)) continue;
    try {
      const response = await contents.session.fetch(url);
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) continue;
      return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
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
  /** Open tabs in display order. A page's popup or new window opens as another tab, keeping its opener. */
  private tabs: { id: number; view: WebContentsView; icon?: string }[] = [];
  private activeTab?: number;
  private nextTab = 1;
  /** Where the UI wants the selected page drawn, or null while it is hidden. */
  private bounds: Bounds | null = null;
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
      if (!this.tabs.some((tab) => tab.view.webContents === event.sender)) return { error: { code: 4100, message: "Unauthorized" } };
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

  /** Opens `url` in the selected tab, or in a new one if none is open. */
  open(url: string): BrowserState {
    const target = browsableUrl(url);
    const view = this.active()?.view ?? this.select(this.createTab()).view;
    void view.webContents.loadURL(target);
    return this.state();
  }

  /** Opens a new, empty tab (or one showing `url`) and selects it. */
  newTab(url?: string): BrowserState {
    const target = url ? browsableUrl(url) : undefined;
    const tab = this.select(this.createTab());
    if (target) void tab.view.webContents.loadURL(target);
    return this.state();
  }

  selectTab(id: number): BrowserState {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (tab) this.select(tab);
    return this.state();
  }

  /** Closes a tab; the one after it (or before, if it was last) becomes selected. */
  closeTab(id: number): BrowserState {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return this.state();
    const [tab] = this.tabs.splice(index, 1);
    this.deps.window()?.contentView.removeChildView(tab!.view);
    if (!tab!.view.webContents.isDestroyed()) tab!.view.webContents.close();
    if (this.activeTab === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1];
      this.activeTab = undefined;
      if (next) this.select(next);
    }
    this.update();
    return this.state();
  }

  navigate(action: "back" | "forward" | "reload" | "stop"): void {
    const contents = this.active()?.view.webContents;
    if (!contents) return;
    if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
    if (action === "stop") contents.stop();
  }

  /**
   * Closes the selected tab if the browser is on screen, for the close shortcut; false otherwise (the shortcut then
   * closes the window as usual).
   */
  closeShownTab(): boolean {
    const tab = this.active();
    if (!tab || this.bounds === null) return false;
    this.closeTab(tab.id);
    return true;
  }

  /** Places the selected tab over the UI's viewport, or hides it with `null`; other tabs stay hidden. */
  setBounds(bounds: Bounds | null): void {
    this.bounds = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
    this.layout();
  }

  state(): BrowserState {
    const tabs = this.tabs.map(({ id, view, icon }) => ({ id, url: view.webContents.getURL(), title: view.webContents.getTitle(), loading: view.webContents.isLoading(), icon }));
    const contents = this.active()?.view.webContents;
    if (!contents) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, tabs, activeTab: this.activeTab };
    return {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      tabs,
      activeTab: this.activeTab,
    };
  }

  /** Test hook: the selected page as an image (window captures leave out child views). */
  async capture(): Promise<Buffer | undefined> {
    const view = this.active()?.view;
    return view ? (await view.webContents.capturePage()).toPNG() : undefined;
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

  /** Closes every tab, forgets connected sites and refuses any request waiting for review; on lock and Safe change. */
  close(): void {
    this.settle()?.reject(new ProviderError(4900, "Cicada was locked"));
    this.provider.disconnectAll();
    for (const { view } of this.tabs) {
      this.deps.window()?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.tabs = [];
    this.activeTab = undefined;
    this.update();
  }

  private review(request: DappRequest): Promise<ProposalResult | { queued: DraftItem }> {
    if (!this.deps.window()) return Promise.reject(new ProviderError(4900, "Cicada is not open"));
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

  private active(): { id: number; view: WebContentsView; icon?: string } | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTab);
  }

  private select(tab: { id: number; view: WebContentsView }): { id: number; view: WebContentsView } {
    this.activeTab = tab.id;
    this.layout();
    this.update();
    return tab;
  }

  /** Shows only the selected tab, at the bounds the UI asked for. */
  private layout(): void {
    for (const { id, view } of this.tabs) {
      const visible = id === this.activeTab && this.bounds !== null;
      if (visible) {
        const { x, y, width, height } = this.bounds!;
        view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
      }
      view.setVisible(visible);
    }
  }

  private update(): void {
    this.deps.send("browser:state", this.state());
  }

  /**
   * A new tab: a fresh sandboxed page, or the page Chromium created for another tab's `window.open` (`opened`), which
   * keeps its opener so sign-in and connect popups can report back. Both get the wallet preload.
   */
  private createTab(opened?: BrowserWindowConstructorOptions): { id: number; view: WebContentsView } {
    const window = this.deps.window();
    if (!window) throw new Error("no window");
    const webPreferences = { preload: this.deps.preload, partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true };
    // Electron passes a popup's prepared page in `options.webContents`, outside the typings; it must be adopted as is.
    const webContents = (opened as { webContents?: WebContents } | undefined)?.webContents;
    const view = new WebContentsView(webContents ? { webContents, webPreferences: { ...opened?.webPreferences, ...webPreferences } } : { webPreferences });
    view.setVisible(false);
    window.contentView.addChildView(view);
    const tab: { id: number; view: WebContentsView; icon?: string } = { id: this.nextTab++, view };
    this.tabs.push(tab);

    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      // Popups often start blank and are navigated by their opener (sign-in, wallet connect).
      if (url !== "about:blank" && !navigable(url)) {
        if (url.startsWith("https://")) void shell.openExternal(url);
        return { action: "deny" };
      }
      return {
        action: "allow",
        createWindow: (options) => this.select(this.createTab(options)).view.webContents,
      };
    });
    contents.on("will-navigate", (event) => {
      if (!navigable(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!navigable(event.url)) event.preventDefault();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      void fetchIcon(contents, favicons).then((icon) => {
        tab.icon = icon;
        this.update();
      });
    });
    contents.on("did-navigate", () => {
      tab.icon = undefined;
    });
    // Cmd+W (Ctrl+W elsewhere) with the page focused closes its tab rather than the window.
    contents.on("before-input-event", (event, input) => {
      if (isCloseShortcut(input) && this.closeShownTab()) event.preventDefault();
    });
    // A popup that closes itself (window.close() after sign-in) closes its tab.
    contents.on("destroyed", () => {
      if (this.tabs.some((candidate) => candidate.id === tab.id)) this.closeTab(tab.id);
    });
    const script = process.env.ROTATION_SIGNER_TEST_DAPP_SCRIPT;
    if (script) contents.once("did-finish-load", () => void contents.executeJavaScript(readFileSync(script, "utf8")).catch(() => undefined));
    for (const name of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      contents.on(name as "did-start-loading", () => this.update());
    }
    return tab;
  }
}
