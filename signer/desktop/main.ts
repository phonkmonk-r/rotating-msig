import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadTreeFile, type TreeFile } from "@rotating-msig/core";
import { seedSource, type AddressSource } from "@rotating-msig/keys";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isHex, type Hex } from "viem";

import { createSession } from "../src/create.js";
import type { SignerSession } from "../src/session.js";
import { createVault, readVault, unlockVault } from "./vault.js";

/** Saved between launches. The seed lives only in the encrypted vault (`vault.json`). */
interface Settings {
  treePath: string;
  rpc: string;
  executionRpc?: string;
  txServiceUrl?: string;
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
  const tree = loadTreeFile(readFileSync(settings.treePath, "utf8")).file;
  const { session: next } = createSession(
    { tree, rpc: settings.rpc, executionRpc: settings.executionRpc || undefined, txServiceUrl: settings.txServiceUrl, safeApiKey: process.env.SAFE_API_KEY },
    source,
  );
  const status = await next.status();
  if (!status.me) throw new Error(status.meError ?? "your current owner key could not be resolved");
  session = next;
  sessionError = undefined;
}

async function lock() {
  session = undefined;
  await source?.close();
  source = undefined;
}

/** After unlocking, resumes the saved configuration if there is one; problems are shown on the setup screen. */
async function resume() {
  const settings = readSettings();
  if (!settings || !existsSync(settings.treePath)) return;
  try {
    await start(settings);
  } catch (error) {
    sessionError = (error as Error).message;
  }
}

/** Every handler returns a Result so error messages reach the UI unchanged. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T) {
  ipcMain.handle(channel, async (_event, ...args: A): Promise<Result<T>> => {
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

handle("app:state", () => {
  const settings = readSettings();
  let tree: TreeSummary | undefined;
  try {
    if (settings) tree = summarize(loadTreeFile(readFileSync(settings.treePath, "utf8")).file);
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
    settings: settings ? { treePath: settings.treePath, rpc: settings.rpc, executionRpc: settings.executionRpc ?? "" } : undefined,
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

handle("app:pickTree", async () => {
  const picked = await dialog.showOpenDialog({ title: "Choose your tree file", properties: ["openFile"], filters: [{ name: "Tree file", extensions: ["json"] }] });
  const path = picked.filePaths[0];
  if (picked.canceled || !path) return undefined;
  return { path, tree: summarize(loadTreeFile(readFileSync(path, "utf8")).file) };
});

handle("app:configure", async (input: Settings) => {
  if (!input?.treePath || !input.rpc) throw new Error("tree file and RPC URL are both required");
  const settings: Settings = { treePath: input.treePath, rpc: input.rpc.trim(), executionRpc: input.executionRpc?.trim() || undefined };
  const existing = readSettings();
  if (existing?.txServiceUrl) settings.txServiceUrl = existing.txServiceUrl;
  await start(settings);
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
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

function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 420,
    title: "Rotation Signer",
    backgroundColor: "#f6f7f8",
    webPreferences: { preload: join(appRoot(), "desktop/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The UI never navigates; links (block explorers) open in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadFile(join(appRoot(), "ui/dist/index.html"));

  const screenshot = process.env.ROTATION_SIGNER_SCREENSHOT;
  if (screenshot) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.ROTATION_SIGNER_SCREENSHOT_DELAY ?? 2500));
    });
  }
}

app.whenReady().then(async () => {
  // Test hook only: unlocks without the UI so smoke tests can reach the dashboard.
  if (process.env.ROTATION_SIGNER_TEST_PASSWORD && readVault(vaultPath())) {
    try {
      source = seedSource(unlockVault(vaultPath(), process.env.ROTATION_SIGNER_TEST_PASSWORD));
      await resume();
    } catch (error) {
      sessionError = (error as Error).message;
    }
  }
  createWindow();
});

app.on("window-all-closed", () => {
  void lock().then(() => app.quit());
});
