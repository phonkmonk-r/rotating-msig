#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, isAddress, isHex, type Address } from "viem";

import { readSecret } from "./prompt.js";
import { openLedgerSource } from "./sources/ledger.js";
import { seedSource } from "./sources/seed.js";
import { PATH_TEMPLATE, type AddressSource } from "./sources/source.js";
import { createTreeFile, loadTreeFile, proofFor, slotConfig, stageEntries, validateMeta, type TreeMeta } from "@rotating-msig/core";

/** Account indexes below this are where wallets put everyday accounts, whose keys may already be exposed. */
export const MIN_BASE = 1000;
export const DEFAULT_SIZE = 10_000;
export const MAINNET_CHAIN_ID = 1;

const USAGE = `rotation-tree: offline generator for RotationGuard signer trees

Commands:
  generate  --safe <address> --slot <id> --base <account> --out <file>
            [--size ${DEFAULT_SIZE}] [--chain-id ${MAINNET_CHAIN_ID}] [--source seed|ledger] [--mnemonic-file <file>]
            [--passphrase] [--allow-low-base] [--force]
      Derives <size> addresses at ${PATH_TEMPLATE} for account = base..base+size-1 and writes the tree file.
  verify    --tree <file> [--root <hex>] [--source seed|ledger] [--mnemonic-file <file>] [--passphrase] [--sample <n>]
      Rebuilds the root from the file, optionally compares it with an expected (on-chain) root, and optionally
      re-derives addresses from the seed or device to confirm the file is yours.
  proof     --tree <file> --index <n>                  Prints one staging entry.
  entries   --tree <file> --from <n> --count <n>       Prints staging entries for RotationGuard.stage.
  config    --tree <file> [--index 0] [--cid <cid>]    Prints a SlotConfig for initialize / addSlot.

Secrets are never accepted as command-line arguments. The mnemonic is read from a hidden prompt or --mnemonic-file.`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readSecret(question: string): Promise<string>;
  openLedger(): Promise<AddressSource>;
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readSecret,
  openLedger: openLedgerSource,
};

const OPTIONS = {
  safe: { type: "string" },
  slot: { type: "string" },
  base: { type: "string" },
  size: { type: "string" },
  "chain-id": { type: "string" },
  source: { type: "string" },
  "mnemonic-file": { type: "string" },
  passphrase: { type: "boolean" },
  "allow-low-base": { type: "boolean" },
  force: { type: "boolean" },
  out: { type: "string" },
  tree: { type: "string" },
  root: { type: "string" },
  sample: { type: "string" },
  index: { type: "string" },
  from: { type: "string" },
  count: { type: "string" },
  cid: { type: "string" },
  help: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const command = positionals[0];
    if (values.help || !command) {
      io.stdout(`${USAGE}\n`);
      return command || values.help ? 0 : 1;
    }
    switch (command) {
      case "generate":
        return await generate(values, io);
      case "verify":
        return await verify(values, io);
      case "proof": {
        const { file, tree } = loadTreeFile(readFileSync(required(values.tree, "--tree"), "utf8"));
        printJson(io, proofFor(tree, file, integer(values.index, "--index")));
        return 0;
      }
      case "entries": {
        const { file, tree } = loadTreeFile(readFileSync(required(values.tree, "--tree"), "utf8"));
        printJson(io, stageEntries(tree, file, integer(values.from, "--from"), integer(values.count, "--count")));
        return 0;
      }
      case "config": {
        const { file, tree } = loadTreeFile(readFileSync(required(values.tree, "--tree"), "utf8"));
        printJson(io, slotConfig(tree, file, values.index === undefined ? 0 : integer(values.index, "--index"), values.cid ?? ""));
        return 0;
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}\n`);
    return 1;
  }
}

async function generate(values: Values, io: Io): Promise<number> {
  const safe = required(values.safe, "--safe");
  if (!isAddress(safe, { strict: false })) throw new Error(`invalid --safe address: ${safe}`);
  const meta: TreeMeta = {
    chainId: values["chain-id"] === undefined ? MAINNET_CHAIN_ID : integer(values["chain-id"], "--chain-id"),
    safe: getAddress(safe),
    slotId: integer(values.slot, "--slot"),
    base: integer(values.base, "--base"),
  };
  const size = values.size === undefined ? DEFAULT_SIZE : integer(values.size, "--size");
  validateMeta(meta, size);
  if (meta.base < MIN_BASE && !values["allow-low-base"]) {
    throw new Error(`--base ${meta.base} overlaps everyday wallet accounts (below ${MIN_BASE}); pass --allow-low-base to override`);
  }
  const out = required(values.out, "--out");
  if (existsSync(out) && !values.force) throw new Error(`${out} already exists; pass --force to overwrite`);

  const source = await openSource(values, io);
  const addresses: Address[] = [];
  try {
    for (let i = 0; i < size; i++) {
      addresses.push(await source.address(meta.base + i));
      if ((i + 1) % 500 === 0 || i + 1 === size) io.stderr(`derived ${i + 1}/${size}\r`);
    }
    io.stderr("\n");
  } finally {
    await source.close();
  }

  const file = createTreeFile(meta, PATH_TEMPLATE, addresses);
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, out);

  io.stdout(
    [
      `wrote ${out}`,
      `root      ${file.root}`,
      `safe      ${file.safe} (chain ${file.chainId}), slot ${file.slotId}`,
      `accounts  ${file.base}..${file.base + file.size - 1} at ${PATH_TEMPLATE}`,
      `index 0   ${file.addresses[0]}`,
      "Before the setup transaction is signed, check that this root is the one committed for your slot.",
      "",
    ].join("\n"),
  );
  return 0;
}

async function verify(values: Values, io: Io): Promise<number> {
  const { file } = loadTreeFile(readFileSync(required(values.tree, "--tree"), "utf8"));
  io.stdout(`tree ok   ${file.size} addresses, root ${file.root}\n`);

  if (values.root !== undefined) {
    if (!isHex(values.root) || values.root.length !== 66) throw new Error(`invalid --root: ${values.root}`);
    if (values.root.toLowerCase() !== file.root.toLowerCase()) {
      throw new Error(`root mismatch: expected ${values.root}, tree file has ${file.root}`);
    }
    io.stdout("root ok   matches the expected root\n");
  }

  if (values.source !== undefined) {
    const indexes = sampleIndexes(file.size, values.sample === undefined ? file.size : integer(values.sample, "--sample"));
    const source = await openSource(values, io);
    try {
      for (const index of indexes) {
        const derived = await source.address(file.base + index);
        if (derived !== file.addresses[index]) {
          throw new Error(`address ${index} does not match: derived ${derived}, tree file has ${file.addresses[index]}`);
        }
      }
    } finally {
      await source.close();
    }
    io.stdout(`derive ok ${indexes.length} of ${file.size} addresses re-derived from the ${values.source}\n`);
  }
  return 0;
}

async function openSource(values: Values, io: Io): Promise<AddressSource> {
  const kind = values.source ?? "seed";
  if (kind === "ledger") return io.openLedger();
  if (kind !== "seed") throw new Error(`unknown --source: ${kind}`);
  const mnemonic = values["mnemonic-file"] !== undefined
    ? readFileSync(values["mnemonic-file"], "utf8")
    : await io.readSecret("mnemonic: ");
  const passphrase = values.passphrase ? await io.readSecret("BIP-39 passphrase: ") : "";
  return seedSource(mnemonic, passphrase);
}

/** Always checks the first and last index; spreads the rest evenly. */
export function sampleIndexes(size: number, sample: number): number[] {
  if (sample >= size) return Array.from({ length: size }, (_, i) => i);
  if (sample < 2) return [0, size - 1];
  const step = (size - 1) / (sample - 1);
  return [...new Set(Array.from({ length: sample }, (_, i) => Math.round(i * step)))];
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new Error(`${flag} is required`);
  return value;
}

function integer(value: string | undefined, flag: string): number {
  const text = required(value, flag);
  if (!/^\d+$/.test(text)) throw new Error(`${flag} must be a non-negative integer: ${text}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large: ${text}`);
  return parsed;
}

function printJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
