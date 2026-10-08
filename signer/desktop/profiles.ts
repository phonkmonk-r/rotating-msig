import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, type Address } from "viem";

import { createVault, readVault } from "./vault.js";

/** One signing identity: an encrypted seed or a Ledger, each with its own Safe settings and trees. */
export interface ProfileEntry {
  id: string;
  name: string;
  kind: "seed" | "ledger";
  /** Account 0 of the seed or device: identifies it, and pays for gas. */
  operator: Address;
  createdAt: string;
}

interface ProfilesFile {
  version: 1;
  profiles: ProfileEntry[];
  lastUsed?: string;
}

/** Files that belong to one profile, moved together when an old single-wallet install is migrated. */
const PROFILE_FILES = ["vault.json", "settings.json", "creating.json", "trees"];

/**
 * Profiles under `root` (the app's data folder): `profiles.json` lists them, and each lives in `profiles/<id>/` with
 * its own vault (seed profiles only), settings, trees and in-progress Safe creation.
 */
export class ProfileStore {
  constructor(private readonly root: string) {}

  private get indexPath(): string {
    return join(this.root, "profiles.json");
  }

  dir(id: string): string {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("invalid profile id");
    return join(this.root, "profiles", id);
  }

  private read(): ProfilesFile {
    if (!existsSync(this.indexPath)) return { version: 1, profiles: [] };
    return JSON.parse(readFileSync(this.indexPath, "utf8")) as ProfilesFile;
  }

  private write(file: ProfilesFile): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.indexPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(file, null, 2));
    renameSync(temporary, this.indexPath);
  }

  list(): ProfileEntry[] {
    return this.read().profiles;
  }

  get(id: string): ProfileEntry | undefined {
    return this.read().profiles.find((profile) => profile.id === id);
  }

  lastUsed(): ProfileEntry | undefined {
    const file = this.read();
    return file.profiles.find((profile) => profile.id === file.lastUsed);
  }

  setLastUsed(id: string | undefined): void {
    const file = this.read();
    this.write({ ...file, lastUsed: id });
  }

  /** Moves a pre-profiles install (vault and settings directly in the data folder) into a first profile. */
  migrateLegacy(): ProfileEntry | undefined {
    const legacyVault = join(this.root, "vault.json");
    if (!existsSync(legacyVault) || existsSync(this.indexPath)) return undefined;
    const vault = readVault(legacyVault);
    if (!vault) return undefined;
    const entry = this.add("Wallet 1", "seed", vault.operator);
    for (const name of PROFILE_FILES) {
      const from = join(this.root, name);
      if (existsSync(from)) renameSync(from, join(this.dir(entry.id), name));
    }
    this.setLastUsed(entry.id);
    return entry;
  }

  /** Encrypts the seed into a new profile. */
  addSeed(name: string, mnemonic: string, password: string): ProfileEntry {
    const id = newId();
    const dir = join(this.root, "profiles", id);
    mkdirSync(dir, { recursive: true });
    try {
      const vault = createVault(join(dir, "vault.json"), mnemonic, password);
      this.checkUnique(vault.operator);
      return this.add(name, "seed", vault.operator, id);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** A Ledger profile stores no secret: only the device's account 0 address, to recognize it later. */
  addLedger(name: string, operator: Address): ProfileEntry {
    this.checkUnique(operator);
    return this.add(name, "ledger", operator);
  }

  rename(id: string, name: string): ProfileEntry {
    const file = this.read();
    const profile = file.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error("no such profile");
    profile.name = cleanName(name);
    this.write(file);
    return profile;
  }

  /** Deletes the profile and its folder, including the encrypted seed. */
  remove(id: string): void {
    const file = this.read();
    if (!file.profiles.some((profile) => profile.id === id)) throw new Error("no such profile");
    rmSync(this.dir(id), { recursive: true, force: true });
    this.write({ ...file, profiles: file.profiles.filter((profile) => profile.id !== id), lastUsed: file.lastUsed === id ? undefined : file.lastUsed });
  }

  private checkUnique(operator: Address): void {
    const existing = this.list().find((profile) => profile.operator === getAddress(operator));
    if (existing) throw new Error(`this wallet is already the profile "${existing.name}"`);
  }

  private add(name: string, kind: ProfileEntry["kind"], operator: Address, id = newId()): ProfileEntry {
    const entry: ProfileEntry = { id, name: cleanName(name), kind, operator: getAddress(operator), createdAt: new Date().toISOString() };
    mkdirSync(this.dir(id), { recursive: true });
    const file = this.read();
    this.write({ ...file, profiles: [...file.profiles, entry] });
    return entry;
  }
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

function cleanName(name: string): string {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error("give the profile a name");
  return trimmed;
}
