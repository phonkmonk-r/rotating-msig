import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadTreeFile, type TreeFile } from "@rotating-msig/core";
import { seedSource, type AddressSource } from "@rotating-msig/keys";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isHex, type Hex } from "viem";

import { createSession } from "../src/create.js";
import type { SignerSession } from "../src/session.js";

/** Saved between launches. Paths only: the seed itself is never written anywhere by this app. */
interface Settings {
  treePath: string;
  seedPath: string;
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

let session: SignerSession | undefined;
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

/** Builds a session from settings and proves it works by resolving the signer's current owner key. */
async function start(settings: Settings): Promise<void> {
  await stop();
  const tree = loadTreeFile(readFileSync(settings.treePath, "utf8")).file;
  const nextSource = seedSource(readFileSync(settings.seedPath, "utf8"));
  try {
    const { session: next } = createSession(
      { tree, rpc: settings.rpc, executionRpc: settings.executionRpc || undefined, txServiceUrl: settings.txServiceUrl, safeApiKey: process.env.SAFE_API_KEY },
      nextSource,
    );
    const status = await next.status();
    if (!status.me) throw new Error(status.meError ?? "your current owner key could not be resolved");
    session = next;
    source = nextSource;
    sessionError = undefined;
  } catch (error) {
    await nextSource.close();
    throw error;
  }
}

async function stop() {
  session = undefined;
  await source?.close();
  source = undefined;
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
  return {
    configured: session !== undefined,
    settings: settings ? { treePath: settings.treePath, seedPath: settings.seedPath, rpc: settings.rpc, executionRpc: settings.executionRpc ?? "" } : undefined,
    tree,
    error: sessionError,
  };
});

handle("app:pickTree", async () => {
  const picked = await dialog.showOpenDialog({ title: "Choose your tree file", properties: ["openFile"], filters: [{ name: "Tree file", extensions: ["json"] }] });
  const path = picked.filePaths[0];
  if (picked.canceled || !path) return undefined;
  return { path, tree: summarize(loadTreeFile(readFileSync(path, "utf8")).file) };
});

handle("app:pickSeed", async () => {
  const picked = await dialog.showOpenDialog({ title: "Choose your seed phrase file", properties: ["openFile"] });
  const path = picked.filePaths[0];
  return picked.canceled || !path ? undefined : { path };
});

handle("app:configure", async (input: Settings) => {
  if (!input?.treePath || !input.seedPath || !input.rpc) throw new Error("tree file, seed file and RPC URL are all required");
  const settings: Settings = { treePath: input.treePath, seedPath: input.seedPath, rpc: input.rpc.trim(), executionRpc: input.executionRpc?.trim() || undefined };
  const existing = readSettings();
  if (existing?.txServiceUrl) settings.txServiceUrl = existing.txServiceUrl;
  await start(settings);
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return true;
});

handle("app:reset", async () => {
  await stop();
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
  const settings = readSettings();
  if (settings && existsSync(settings.treePath) && existsSync(settings.seedPath)) {
    try {
      await start(settings);
    } catch (error) {
      sessionError = (error as Error).message;
    }
  }
  createWindow();
});

app.on("window-all-closed", () => {
  void stop().then(() => app.quit());
});
