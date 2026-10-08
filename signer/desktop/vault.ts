import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getAddress, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";

/** scrypt cost: about 0.3-0.5 s per unlock on a laptop, which makes offline password guessing expensive. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 10;

/** On-disk vault. Everything except `operator` is ciphertext or KDF parameters. */
export interface VaultFile {
  version: 1;
  /** Public: shown on the unlock screen so the signer knows which wallet this is. */
  operator: Address;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; data: string };
  createdAt: string;
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
}

/** The seed's standard first account: the signer's initial owner, later their gas and staging account. */
export function operatorAddress(mnemonic: string): Address {
  return mnemonicToAccount(normalizeMnemonic(mnemonic), { addressIndex: 0 }).address;
}

function deriveKey(password: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
}

/** Encrypts a validated seed phrase into `path` (owner-only permissions). Refuses to overwrite an existing vault. */
export function createVault(path: string, mnemonic: string, password: string): VaultFile {
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase, wordlist)) throw new Error("that is not a valid seed phrase (check the words and their order)");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  if (existsSync(path)) throw new Error("a wallet already exists on this computer; remove it first to import another");

  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, salt, SCRYPT), iv);
  const data = Buffer.concat([cipher.update(phrase, "utf8"), cipher.final()]);
  const vault: VaultFile = {
    version: 1,
    operator: operatorAddress(phrase),
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") },
    createdAt: new Date().toISOString(),
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return vault;
}

export function readVault(path: string): VaultFile | undefined {
  if (!existsSync(path)) return undefined;
  const vault = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  if (vault.version !== 1 || vault.kdf?.name !== "scrypt" || vault.cipher?.name !== "aes-256-gcm") throw new Error("unsupported wallet file format");
  return vault;
}

/** Decrypts the seed phrase. A wrong password and a modified file both fail authentication. */
export function unlockVault(path: string, password: string): string {
  const vault = readVault(path);
  if (!vault) throw new Error("no wallet on this computer yet");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, Buffer.from(vault.kdf.salt, "base64"), vault.kdf), Buffer.from(vault.cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(vault.cipher.tag, "base64"));
  let phrase: string;
  try {
    phrase = Buffer.concat([decipher.update(Buffer.from(vault.cipher.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong password");
  }
  if (getAddress(operatorAddress(phrase)) !== getAddress(vault.operator)) throw new Error("the wallet file is inconsistent");
  return phrase;
}
