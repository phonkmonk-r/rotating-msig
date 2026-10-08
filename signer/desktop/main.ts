import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  decodeInvite,
  decodePackage,
  encodeInvite,
  encodePackage,
  loadTreeFile,
  readSafeState,
  verifyPackages,
  type SafeInvite,
  type SlotPackage,
  type TreeFile,
} from "@rotating-msig/core";
import { seedSource, type AddressSource } from "@rotating-msig/keys";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { isHex, type Hex } from "viem";

import { createSession } from "../src/create.js";
import { JoinError, joinSafe, readClient, type JoinProgress } from "../src/join.js";
import { chainFor } from "../src/networks.js";
import { createSafe, planSafe, prepareSlot, type NewSafeContext } from "../src/newsafe.js";
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
const creatingPath = () => join(app.getPath("userData"), "creating.json");
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

/** A new Safe being set up: kept on disk so either side can close the app between steps. */
interface Creating {
  role: "creator" | "signer";
  invite: SafeInvite;
  /** Indexed by slot; the creator collects all of them, a signer holds only their own. */
  packages: (SlotPackage | null)[];
}

/** Rough gas for deploying a Safe and installing the guard, per the Sepolia runs (install grows with slots). */
const CREATE_GAS = 600_000n;
const INSTALL_GAS_PER_SLOT = 1_600_000n;

function readCreating(): Creating | undefined {
  try {
    return JSON.parse(readFileSync(creatingPath(), "utf8")) as Creating;
  } catch {
    return undefined;
  }
}

function writeCreating(creating: Creating | undefined) {
  if (!creating) {
    rmSync(creatingPath(), { force: true });
    return;
  }
  mkdirSync(dirname(creatingPath()), { recursive: true });
  writeFileSync(creatingPath(), JSON.stringify(creating, null, 2));
}

function operator(): string | undefined {
  try {
    return readVault(vaultPath())?.operator;
  } catch {
    return undefined;
  }
}

function newSafeContext(chainId: number): NewSafeContext {
  return { client: readClient(chainId, readSettings()?.rpc), chain: chainFor(chainId) };
}

/** What the setup screens show about a Safe being created. */
function creatingView(creating: Creating) {
  const me = operator()?.toLowerCase();
  const mySlot = creating.invite.owners.findIndex((owner) => owner.toLowerCase() === me);
  const mine = creating.packages[mySlot];
  return {
    role: creating.role,
    safe: creating.invite.safe,
    chainId: creating.invite.chainId,
    chainName: chainFor(creating.invite.chainId).name,
    threshold: creating.invite.threshold,
    inviteCode: encodeInvite(creating.invite),
    slots: creating.invite.owners.map((owner, slotId) => ({ slotId, operator: owner, isMe: slotId === mySlot, received: Boolean(creating.packages[slotId]) })),
    myPackage: mine ? encodePackage(mine) : undefined,
    ready: creating.packages.length === creating.invite.owners.length && creating.packages.every(Boolean),
  };
}

/** Generates this signer's keys for the invite's Safe and saves the tree where joining will look for it. */
async function prepareMySlot(invite: SafeInvite): Promise<SlotPackage> {
  if (!source) throw new Error("unlock your wallet first");
  const { tree, package: pkg } = await prepareSlot(newSafeContext(invite.chainId), source, invite, (done, total) =>
    sendToWindow("app:progress", { stage: "deriving", done, total }),
  );
  const path = treePath({ chainId: tree.chainId, safe: tree.safe, slotId: tree.slotId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tree));
  return pkg;
}

handle("create:state", async () => {
  const creating = readCreating();
  if (!creating) return null;
  const view = creatingView(creating);
  if (creating.role !== "creator") return { ...view, balance: undefined, estimatedCost: undefined };
  try {
    const { client } = newSafeContext(creating.invite.chainId);
    const [balance, gasPrice] = await Promise.all([client.getBalance({ address: operator() as `0x${string}` }), client.getGasPrice()]);
    const gas = CREATE_GAS + INSTALL_GAS_PER_SLOT * BigInt(creating.invite.owners.length);
    return { ...view, balance: balance.toString(), estimatedCost: ((gas * gasPrice * 3n) / 2n).toString() };
  } catch {
    return { ...view, balance: undefined, estimatedCost: undefined };
  }
});

handle("create:plan", async (chainId: unknown, coSigners: unknown, threshold: unknown) => {
  const me = operator();
  if (!me || !source) throw new Error("unlock your wallet first");
  const others = Array.isArray(coSigners) ? coSigners.map((value) => String(value).trim()) : [];
  const invite = await planSafe(newSafeContext(Number(chainId)), [me, ...others], Number(threshold));
  const pkg = await prepareMySlot(invite);
  writeCreating({ role: "creator", invite, packages: invite.owners.map((_, slot) => (slot === pkg.slotId ? pkg : null)) });
  return true;
});

handle("create:accept", async (code: unknown) => {
  const invite = decodeInvite(String(code));
  const pkg = await prepareMySlot(invite);
  writeCreating({ role: "signer", invite, packages: invite.owners.map((_, slot) => (slot === pkg.slotId ? pkg : null)) });
  return true;
});

handle("create:add", (code: unknown) => {
  const creating = readCreating();
  if (creating?.role !== "creator") throw new Error("there is no Safe being created");
  const pkg = decodePackage(String(code));
  if (!Number.isInteger(pkg.slotId) || pkg.slotId < 0 || pkg.slotId >= creating.invite.owners.length) throw new Error("this package is for a slot this Safe does not have");
  const trial = creating.invite.owners.map((_, slot) => (slot === pkg.slotId ? pkg : (creating.packages[slot] ?? null)));
  const prefix = `slot ${pkg.slotId}:`;
  const errors = verifyPackages(creating.invite, trial as SlotPackage[]).filter((error) => error.startsWith(prefix) && !error.endsWith("missing"));
  if (errors.length > 0) throw new Error(errors.map((error) => error.slice(prefix.length).trim()).join("; "));
  creating.packages = trial;
  writeCreating(creating);
  return pkg.slotId;
});

handle("create:launch", async () => {
  const creating = readCreating();
  if (creating?.role !== "creator") throw new Error("there is no Safe being created");
  if (!source) throw new Error("unlock your wallet first");
  const { invite } = creating;
  const state = await readSafeState(newSafeContext(invite.chainId).client, invite.safe).catch(() => undefined);
  if (!state?.installed) {
    await createSafe(newSafeContext(invite.chainId), source, invite, creating.packages as SlotPackage[], (stage) => sendToWindow("create:stage", stage));
  }
  sendToWindow("create:stage", "joining");
  await joinWith(invite.safe, { chainId: invite.chainId }, (progress) => sendToWindow("app:progress", progress));
  writeCreating(undefined);
  return true;
});

/** A signer waiting for the creator: joins once the Safe exists with the guard installed. */
handle("create:check", async () => {
  const creating = readCreating();
  if (!creating) throw new Error("there is no Safe being created");
  const { invite } = creating;
  const client = newSafeContext(invite.chainId).client;
  if (!(await client.getCode({ address: invite.safe }))) return false;
  const state = await readSafeState(client, invite.safe);
  if (!state.installed) return false;
  await joinWith(invite.safe, { chainId: invite.chainId }, (progress) => sendToWindow("app:progress", progress));
  writeCreating(undefined);
  return true;
});

handle("create:cancel", () => {
  writeCreating(undefined);
  return true;
});

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
    creating: readCreating() !== undefined,
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
