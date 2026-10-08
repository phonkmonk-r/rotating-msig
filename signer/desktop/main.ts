import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadTreeFile, type TreeFile } from "@rotating-msig/core";
import { seedSource, type AddressSource } from "@rotating-msig/keys";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { isHex, type Hex } from "viem";

import { createSession } from "../src/create.js";
import { JoinError, joinSafe, type JoinProgress } from "../src/join.js";
import type { SignerSession } from "../src/session.js";
import { DappBrowser, type Bounds } from "./browser.js";
import { createVault, readVault, unlockVault } from "./vault.js";

/** Saved between launches. The seed lives only in the encrypted vault (`vault.json`); the tree is public data. */
interface Settings {
  chainId: number;
  safe: string;
  slotId: number;
  base: number;
  /** Optional overrides; the default public RPCs are used otherwise. */
  rpc?: string;
  executionRpc?: string;
  txServiceUrl?: string;
}

/** Optional overrides the signer can set under Advanced. */
interface Advanced {
  chainId?: number;
  rpc?: string;
  executionRpc?: string;
}

interface TreeSummary {
  safe: string;
  chainId: number;
  slotId: number;
  size: number;
  base: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const appRoot = () => app.getAppPath();

if (process.env.ROTATION_SIGNER_USER_DATA) app.setPath("userData", process.env.ROTATION_SIGNER_USER_DATA);
const settingsPath = () => join(app.getPath("userData"), "settings.json");
const vaultPath = () => join(app.getPath("userData"), "vault.json");
const treePath = (settings: Pick<Settings, "chainId" | "safe" | "slotId">) =>
  join(app.getPath("userData"), "trees", `${settings.chainId}-${settings.safe.toLowerCase()}-slot${settings.slotId}.json`);

let session: SignerSession | undefined;
/** Present only while the wallet is unlocked: the decrypted seed never leaves this process. */
let source: AddressSource | undefined;
let sessionError: string | undefined;

function readSettings(): Settings | undefined {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return undefined;
  }
}

function summarize(tree: TreeFile): TreeSummary {
  return { safe: tree.safe, chainId: tree.chainId, slotId: tree.slotId, size: tree.size, base: tree.base };
}

/** Builds a session from settings with the unlocked wallet, and proves it works by resolving the current owner key. */
async function start(settings: Settings): Promise<void> {
  if (!source) throw new Error("unlock your wallet first");
  session = undefined;
  browser?.close();
  const tree = loadTreeFile(readFileSync(treePath(settings), "utf8")).file;
  const { session: next } = createSession(
    { tree, rpc: settings.rpc || undefined, executionRpc: settings.executionRpc || undefined, txServiceUrl: settings.txServiceUrl, safeApiKey: process.env.SAFE_API_KEY },
    source,
  );
  const status = await next.status();
  if (!status.me) throw new Error(status.meError ?? "your current owner key could not be resolved");
  session = next;
  sessionError = undefined;
}

async function lock() {
  session = undefined;
  browser?.close();
  await source?.close();
  source = undefined;
}

/** After unlocking, resumes the saved configuration if there is one; problems are shown on the setup screen. */
async function resume() {
  const settings = readSettings();
  if (!settings || settings.slotId === undefined || !existsSync(treePath(settings))) return;
  try {
    await start(settings);
  } catch (error) {
    sessionError = (error as Error).message;
  }
}

/** Every handler returns a Result so error messages reach the UI unchanged. Only the app's own UI may call them. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T) {
  ipcMain.handle(channel, async (event, ...args: A): Promise<Result<T>> => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: "not allowed" };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
}

function requireSession(): SignerSession {
  if (!session) throw new Error("the signer is not configured");
  return session;
}

function requireHash(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new Error("expected a 32-byte hex hash");
  return value;
}

/**
 * Joins a Safe with the unlocked wallet: finds the network and this signer's slot, rebuilds the tree, checks it
 * against the chain, then saves everything and starts signing.
 */
async function joinWith(safe: string, advanced: Advanced, sendProgress: (progress: JoinProgress) => void): Promise<void> {
  if (!source) throw new Error("unlock your wallet first");
  const joined = await joinSafe({ source, safe, chainId: advanced.chainId || undefined, rpc: advanced.rpc || undefined, onProgress: sendProgress });
  const settings: Settings = {
    chainId: joined.chainId,
    safe: joined.safe,
    slotId: joined.slotId,
    base: joined.base,
    rpc: advanced.rpc || undefined,
    executionRpc: advanced.executionRpc || undefined,
  };
  const existing = readSettings();
  if (existing?.txServiceUrl) settings.txServiceUrl = existing.txServiceUrl;
  mkdirSync(dirname(treePath(settings)), { recursive: true });
  writeFileSync(treePath(settings), JSON.stringify(joined.tree));
  await start(settings);
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

handle("app:state", () => {
  const settings = readSettings();
  let tree: TreeSummary | undefined;
  try {
    if (settings?.slotId !== undefined) tree = summarize(loadTreeFile(readFileSync(treePath(settings), "utf8")).file);
  } catch {
    // Reported through sessionError.
  }
  let vault: { exists: boolean; unlocked: boolean; operator?: string } = { exists: false, unlocked: false };
  try {
    const file = readVault(vaultPath());
    vault = { exists: file !== undefined, unlocked: source !== undefined, operator: file?.operator };
  } catch (error) {
    sessionError = (error as Error).message;
  }
  return {
    vault,
    configured: session !== undefined,
    settings: settings
      ? { safe: settings.safe, chainId: settings.chainId, slotId: settings.slotId, rpc: settings.rpc ?? "", executionRpc: settings.executionRpc ?? "" }
      : undefined,
    tree,
    error: sessionError,
  };
});

handle("vault:create", async (mnemonic: string, password: string) => {
  createVault(vaultPath(), String(mnemonic), String(password));
  source = seedSource(unlockVault(vaultPath(), String(password)));
  await resume();
  return true;
});

let mainWindow: BrowserWindow | undefined;
function sendToWindow(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload);
}

handle("vault:unlock", async (password: string) => {
  const phrase = unlockVault(vaultPath(), String(password));
  await lock();
  source = seedSource(phrase);
  await resume();
  return true;
});

handle("vault:lock", async () => {
  await lock();
  return true;
});

handle("app:join", async (safe: string, advanced: Advanced = {}) => {
  try {
    await joinWith(String(safe), advanced, (progress) => sendToWindow("app:progress", progress));
  } catch (error) {
    throw error instanceof JoinError ? new Error(`${error.kind}: ${error.message}`) : error;
  }
  return true;
});

handle("app:reset", async () => {
  session = undefined;
  return true;
});

handle("signer:status", () => requireSession().status());
handle("signer:queue", () => requireSession().queue());
handle("signer:confirm", (hash: unknown) => requireSession().confirm(requireHash(hash)));
handle("signer:execute", (hash: unknown) => requireSession().execute(requireHash(hash)));
handle("signer:execution", (hash: unknown) => requireSession().execution(requireHash(hash)));
handle("signer:propose", (input: unknown, preview: unknown) => requireSession().propose(input as never, preview === true));
handle("signer:token", (address: unknown) => requireSession().tokenInfo(String(address)));

let browser: DappBrowser | undefined;
function requireBrowser(): DappBrowser {
  if (!browser) throw new Error("the browser is not ready");
  return browser;
}
handle("browser:open", (url: unknown) => {
  requireSession();
  return requireBrowser().open(String(url));
});
handle("browser:bounds", (bounds: Bounds | null) => browser?.setBounds(bounds) ?? null);
handle("browser:navigate", (action: unknown) => {
  if (action === "back" || action === "forward" || action === "reload" || action === "stop") browser?.navigate(action);
  return null;
});
handle("browser:state", () => requireBrowser().state());
handle("browser:close", () => browser?.close() ?? null);
handle("browser:pending", () => browser?.pendingRequest() ?? null);
handle("browser:preview", (id: unknown) => requireBrowser().preview(String(id)));
handle("browser:approve", (id: unknown) => requireBrowser().approve(String(id)));
handle("browser:reject", (id: unknown) => requireBrowser().reject(String(id)) ?? null);

function createWindow() {
  const window = (mainWindow = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 420,
    title: "Rotation Signer",
    backgroundColor: "#f6f7f8",
    webPreferences: { preload: join(appRoot(), "desktop/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  }));
  // The UI never navigates; links (block explorers) open in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  browser ??= new DappBrowser({
    window: () => mainWindow,
    session: () => session,
    preload: join(appRoot(), "desktop/dapp-preload.cjs"),
    send: sendToWindow,
  });
  const page = process.env.ROTATION_SIGNER_TEST_PAGE;
  void window.loadFile(join(appRoot(), "ui/dist/index.html"), page ? { hash: `page=${page}` } : undefined);

  const screenshot = process.env.ROTATION_SIGNER_SCREENSHOT;
  if (screenshot) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
        const page = await browser?.capture();
        if (page) writeFileSync(screenshot.replace(/\.png$/, "-dapp.png"), page);
        app.quit();
      }, Number(process.env.ROTATION_SIGNER_SCREENSHOT_DELAY ?? 2500));
    });
  }
}

app.whenReady().then(async () => {
  // Test hooks only: unlock (and optionally join) without the UI, so smoke tests can reach the dashboard.
  if (process.env.ROTATION_SIGNER_TEST_PASSWORD && readVault(vaultPath())) {
    try {
      source = seedSource(unlockVault(vaultPath(), process.env.ROTATION_SIGNER_TEST_PASSWORD));
      if (process.env.ROTATION_SIGNER_TEST_JOIN) await joinWith(process.env.ROTATION_SIGNER_TEST_JOIN, {}, () => undefined);
      else await resume();
    } catch (error) {
      sessionError = (error as Error).message;
    }
  }
  createWindow();
  if (process.env.ROTATION_SIGNER_TEST_BROWSE && session) browser?.open(process.env.ROTATION_SIGNER_TEST_BROWSE);
});

app.on("window-all-closed", () => {
  void lock().then(() => app.quit());
});
