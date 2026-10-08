#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadTreeFile, type TreeFile } from "@rotating-msig/core";
import { openLedgerSource, readSecret, seedSource, type AddressSource } from "@rotating-msig/keys";
import { formatEther, type Chain } from "viem";

import { chainFor, createSession, DEFAULT_EXECUTION_RPC } from "./create.js";
import { serve } from "./server.js";

export { DEFAULT_EXECUTION_RPC };

export const DEFAULT_PORT = 7373;

const USAGE = `rotation-signer: confirm and execute Safe transactions with your current rotation key

  rotation-signer --tree <file> --rpc <url> [--mnemonic-file <file> [--passphrase] | --ledger]
                  [--execution-rpc <url>] [--port ${DEFAULT_PORT}]

  --tree           your tree file; it names the Safe, the chain and your slot
  --rpc            RPC used to read the chain (also read from RPC_URL)
  --execution-rpc  RPC used only to send executions; defaults to Flashbots Protect on mainnet, the read RPC on Sepolia
  --mnemonic-file  your seed phrase file; without it (and without --ledger) the seed is asked for, hidden
  --ledger         sign on a Ledger instead of a seed
  --port           local port for the UI (127.0.0.1 only)

The UI opens at the printed URL. It contains a session token: do not share it. SAFE_API_KEY, if set, is sent to the
Safe Transaction Service.`;

const OPTIONS = {
  tree: { type: "string" },
  rpc: { type: "string" },
  "execution-rpc": { type: "string" },
  "mnemonic-file": { type: "string" },
  passphrase: { type: "boolean" },
  ledger: { type: "boolean" },
  port: { type: "string" },
  help: { type: "boolean" },
} as const;

export interface CliConfig {
  tree: TreeFile;
  chain: Chain;
  rpc: string;
  executionRpc: string;
  port: number;
  key: { kind: "ledger" } | { kind: "seed"; mnemonicFile?: string; passphrase: boolean };
}

/** Validates arguments into a configuration. Exported for tests; never reads secrets. */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig | "help" {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  if (values.help) return "help";
  if (!values.tree) throw new Error("--tree is required");
  const tree = loadTreeFile(readFileSync(values.tree, "utf8")).file;
  const chain = chainFor(tree.chainId);
  const rpc = values.rpc ?? env.RPC_URL;
  if (!rpc) throw new Error("--rpc (or RPC_URL) is required");
  const executionRpc = values["execution-rpc"] ?? DEFAULT_EXECUTION_RPC[tree.chainId] ?? rpc;
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
  if (values.ledger && values["mnemonic-file"]) throw new Error("choose either --ledger or --mnemonic-file");
  if (values["mnemonic-file"] && !existsSync(values["mnemonic-file"])) throw new Error(`${values["mnemonic-file"]} does not exist`);
  return {
    tree,
    chain,
    rpc,
    executionRpc,
    port,
    key: values.ledger ? { kind: "ledger" } : { kind: "seed", mnemonicFile: values["mnemonic-file"], passphrase: values.passphrase ?? false },
  };
}

async function openSource(key: CliConfig["key"]): Promise<AddressSource> {
  if (key.kind === "ledger") return openLedgerSource();
  const mnemonic = key.mnemonicFile ? readFileSync(key.mnemonicFile, "utf8") : await readSecret("mnemonic: ");
  const passphrase = key.passphrase ? await readSecret("BIP-39 passphrase: ") : "";
  return seedSource(mnemonic, passphrase);
}

export async function main(argv: string[]): Promise<number> {
  let config: CliConfig | "help";
  try {
    config = parseConfig(argv);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  if (config === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const source = await openSource(config.key);
  const { session } = createSession(
    { tree: config.tree, rpc: config.rpc, executionRpc: config.executionRpc, safeApiKey: process.env.SAFE_API_KEY },
    source,
  );

  session.startAutoRefill();
  const status = await session.status();
  const uiDir = fileURLToPath(new URL("../ui/dist/", import.meta.url));
  const server = await serve(session, { port: config.port, uiDir: existsSync(uiDir) ? uiDir : undefined });

  const lines = [
    `Rotation signer for Safe ${status.safe} on ${config.chain.name}`,
    status.me
      ? `You: slot ${status.me.slotId}, owner ${status.me.address} (tree index ${status.me.index}), ${formatEther(BigInt(status.me.balance))} ETH, ${status.me.staged}/${status.me.bufferSize} staged`
      : `Your key could not be resolved: ${status.meError}`,
    `Executions are sent through ${config.executionRpc}`,
    "",
    `Open ${server.url}`,
    "The URL contains a session token; anyone with it can ask this signer to sign. Press Ctrl+C to stop.",
    "",
  ];
  process.stdout.write(lines.join("\n"));

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  await source.close();
  return 0;
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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    },
  );
}
