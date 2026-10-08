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
import { openLedgerSource, OPERATOR_ACCOUNT, seedSource, type AddressSource } from "@rotating-msig/keys";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { isHex, type Hex } from "viem";

import { createSession } from "../src/create.js";
import { detectChains, JoinError, joinSafe, readClient, type JoinProgress } from "../src/join.js";
import { chainFor } from "../src/networks.js";
import { createSafe, planSafe, prepareNewSlot, prepareSlot, type NewSafeContext } from "../src/newsafe.js";
import type { SignerSession } from "../src/session.js";
import { DappBrowser, type Bounds } from "./browser.js";
import { ProfileStore, type ProfileEntry } from "./profiles.js";
import { readVault, unlockVault } from "./vault.js";

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
const profiles = new ProfileStore(app.getPath("userData"));
/** The profile in use; its seed or Ledger is unlocked separately (`source`). */
let activeId: string | undefined;

function activeProfile(): ProfileEntry {
  const profile = activeId ? profiles.get(activeId) : undefined;
  if (!profile) throw new Error("choose a profile first");
  return profile;
}

const profileDir = () => profiles.dir(activeProfile().id);
const settingsPath = () => join(profileDir(), "settings.json");
const vaultPath = () => join(profileDir(), "vault.json");
const creatingPath = () => join(profileDir(), "creating.json");
const addingPath = () => join(profileDir(), "adding.json");
const treePath = (settings: Pick<Settings, "chainId" | "safe" | "slotId">) =>
  join(profileDir(), "trees", `${settings.chainId}-${settings.safe.toLowerCase()}-slot${settings.slotId}.json`);

let session: SignerSession | undefined;
let stopAutoRefill: (() => void) | undefined;
/** Present only while the wallet is unlocked: the decrypted seed never leaves this process. */
let source: AddressSource | undefined;
let sessionError: string | undefined;

function readSettings(dir = activeId ? profileDir() : undefined): Settings | undefined {
  if (!dir) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Settings;
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
  stopAutoRefill?.();
  stopAutoRefill = undefined;
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
  stopAutoRefill = next.startAutoRefill();
}

async function lock() {
  stopAutoRefill?.();
  stopAutoRefill = undefined;
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
const CREATE_GAS = 1_500_000n;
const INSTALL_GAS_PER_SLOT = 1_600_000n;

function readCreating(): Creating | undefined {
  if (!activeId) return undefined;
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
  return activeId ? profiles.get(activeId)?.operator : undefined;
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

/** Being added to an existing guarded Safe: this signer's package for the next slot, until the slot exists. */
interface Adding {
  chainId: number;
  safe: string;
  package: SlotPackage;
}

function readAdding(): Adding | undefined {
  if (!activeId) return undefined;
  try {
    return JSON.parse(readFileSync(addingPath(), "utf8")) as Adding;
  } catch {
    return undefined;
  }
}

handle("adding:state", () => {
  const adding = readAdding();
  if (!adding) return null;
  return { safe: adding.safe, chainId: adding.chainId, chainName: chainFor(adding.chainId).name, slotId: adding.package.slotId, myPackage: encodePackage(adding.package) };
});

handle("adding:prepare", async (safe: unknown) => {
  if (!source) throw new Error("unlock your wallet first");
  const address = String(safe).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("that is not a Safe address");
  const chains = await detectChains(address as `0x${string}`, readSettings()?.rpc);
  if (chains.length === 0) throw new Error("no Safe at this address on Ethereum or Sepolia");
  const chainId = chains[0]!;
  const { tree, package: pkg } = await prepareNewSlot(newSafeContext(chainId), source, address as `0x${string}`, (done, total) =>
    sendToWindow("app:progress", { stage: "deriving", done, total }),
  );
  const path = treePath({ chainId, safe: tree.safe, slotId: tree.slotId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tree));
  writeFileSync(addingPath(), JSON.stringify({ chainId, safe: tree.safe, package: pkg } satisfies Adding, null, 2));
  return true;
});

/** Joins once the Safe has this signer's new slot. */
handle("adding:check", async () => {
  const adding = readAdding();
  if (!adding) throw new Error("you are not being added to a Safe");
  const state = await readSafeState(newSafeContext(adding.chainId).client, adding.safe as `0x${string}`);
  const slot = state.slots.find((candidate) => candidate.slotId === adding.package.slotId);
  if (!slot || slot.root !== adding.package.config.root) return false;
  await joinWith(adding.safe, { chainId: adding.chainId }, (progress) => sendToWindow("app:progress", progress));
  rmSync(addingPath(), { force: true });
  return true;
});

handle("adding:cancel", () => {
  rmSync(addingPath(), { force: true });
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
  const profile = activeId ? profiles.get(activeId) : undefined;
  const vault = { exists: profile !== undefined, unlocked: source !== undefined, operator: profile?.operator };
  return {
    profiles: profiles.list().map((entry) => {
      const saved = readSettings(profiles.dir(entry.id));
      return { ...entry, safe: saved?.safe, chainId: saved?.chainId };
    }),
    profile,
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

/** Makes `id` the profile in use, locking whichever one was unlocked. */
async function activate(id: string | undefined) {
  await lock();
  activeId = id;
  sessionError = undefined;
  profiles.setLastUsed(id);
}

/** Opens the connected Ledger, with plain-language errors for the usual setup problems. */
async function connectLedger(): Promise<{ source: AddressSource; operator: string }> {
  let device: AddressSource;
  try {
    device = await openLedgerSource();
  } catch (error) {
    throw new Error(`no Ledger found: connect it and unlock it (${(error as Error).message})`);
  }
  try {
    return { source: device, operator: await device.address(OPERATOR_ACCOUNT) };
  } catch (error) {
    await device.close();
    throw new Error(`open the Ethereum app on the Ledger and try again (${(error as Error).message})`);
  }
}

handle("profiles:addSeed", async (name: unknown, mnemonic: unknown, password: unknown) => {
  const entry = profiles.addSeed(String(name), String(mnemonic), String(password));
  await activate(entry.id);
  source = seedSource(unlockVault(vaultPath(), String(password)));
  await resume();
  return entry;
});

handle("profiles:addLedger", async (name: unknown) => {
  const device = await connectLedger();
  let entry: ProfileEntry;
  try {
    entry = profiles.addLedger(String(name), device.operator as `0x${string}`);
  } catch (error) {
    await device.source.close();
    throw error;
  }
  await activate(entry.id);
  source = device.source;
  await resume();
  return entry;
});

handle("profiles:select", async (id: unknown) => {
  if (!profiles.get(String(id))) throw new Error("no such profile");
  await activate(String(id));
  return true;
});

handle("profiles:deselect", async () => {
  await activate(undefined);
  return true;
});

handle("profiles:rename", (id: unknown, name: unknown) => profiles.rename(String(id), String(name)));

handle("profiles:remove", async (id: unknown) => {
  if (activeId === id) await activate(undefined);
  profiles.remove(String(id));
  return true;
});

/** Unlocks a Ledger profile: the connected device must be the one the profile was created with. */
handle("ledger:connect", async () => {
  const profile = activeProfile();
  if (profile.kind !== "ledger") throw new Error("this profile uses a seed phrase");
  const device = await connectLedger();
  if (device.operator.toLowerCase() !== profile.operator.toLowerCase()) {
    await device.source.close();
    throw new Error(`this is a different Ledger (its first account is ${device.operator}); connect the one for "${profile.name}"`);
  }
  await lock();
  source = device.source;
  await resume();
  return true;
});

let mainWindow: BrowserWindow | undefined;
function sendToWindow(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload);
}

handle("vault:unlock", async (password: string) => {
  if (activeProfile().kind !== "seed") throw new Error("this profile uses a Ledger");
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
handle("signer:refill", () => requireSession().refill());
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
  profiles.migrateLegacy();
  activeId = profiles.lastUsed()?.id;
  // Test hooks only: unlock (and optionally join) without the UI, so smoke tests can reach the dashboard.
  if (process.env.ROTATION_SIGNER_TEST_PASSWORD && activeId && readVault(vaultPath())) {
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
