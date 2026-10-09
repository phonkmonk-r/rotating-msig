import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseEther,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { createTreeFile, installTx, loadTreeFile, plainSafeTx, safeAbi, safeKeyPath, safeTxHash, slotConfig, stageEntries, type SafeTx, type TreeFile } from "@rotating-msig/core";
import { generateTree, OPERATOR_ACCOUNT, seedSource } from "@rotating-msig/keys";

const OUT = new URL("../../out/", import.meta.url);
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const SIGNER_SEEDS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];
export const BASE = 1000;
const TREE_SIZE = 12;

export const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
export const hasArtifacts = existsSync(new URL("RotationGuard.sol/RotationGuard.json", OUT));

const anvilAccount = (i: number): HDAccount => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function artifact(path: string): { abi: unknown[]; bytecode: Hex } {
  const json = JSON.parse(readFileSync(new URL(path, OUT), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export interface Chain {
  anvil: ChildProcess;
  rpc: string;
  client: PublicClient;
  safe: Address;
  guard: Address;
  multiSend: Address;
  singleton: Address;
  factory: Address;
  trees: TreeFile[];
  stop(): void;
}

export interface ChainOptions {
  /**
   * Where the signers' keys live: "range" (`m/44'/60'/{BASE + i}'/0/0`, the default) or "branch", the two-level path
   * the app derives for a Safe, so the desktop app can join it from a seed alone. "branch" also funds each signer's
   * gas account.
   */
  layout?: "range" | "branch";
}

/** Starts anvil with a guarded 2-of-3 Safe whose three slots belong to three independent signer seeds. */
export async function startChain(port: number, options: ChainOptions = {}): Promise<Chain> {
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  const client = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const deployer = createWalletClient({ account: anvilAccount(9), chain: foundry, transport: http(rpc) });
  const deploy = async (path: string, args: Hex = "0x") => {
    const hash = await deployer.sendTransaction({ data: concatHex([artifact(path).bytecode, args]) });
    return getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
  };

  const singleton = await deploy("SafeL2.sol/SafeL2.json");
  const factory = await deploy("SafeProxyFactory.sol/SafeProxyFactory.json");
  const multiSend = await deploy("MultiSendCallOnly.sol/MultiSendCallOnly.json");
  const guard = await deploy("RotationGuard.sol/RotationGuard.json", pad(multiSend, { size: 32 }));

  const legacy = [0, 1, 2].map((i) => anvilAccount(i));
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [legacy.map((a) => a.address), 2n, ZERO, "0x", ZERO, ZERO, 0n, ZERO] });
  const { result, request } = await client.simulateContract({
    account: anvilAccount(9),
    address: factory,
    abi: artifact("SafeProxyFactory.sol/SafeProxyFactory.json").abi as never,
    functionName: "createProxyWithNonce",
    args: [singleton, initializer, 0n],
  });
  await client.waitForTransactionReceipt({ hash: await deployer.writeContract(request) });
  const safe = getAddress(result as Address);
  await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: safe, value: parseEther("1") }) });

  const trees: TreeFile[] = [];
  for (const [slot, seed] of SIGNER_SEEDS.entries()) {
    const source = seedSource(seed);
    let tree: TreeFile;
    if (options.layout === "branch") {
      const path = safeKeyPath(foundry.id, safe);
      tree = await generateTree(source, { chainId: foundry.id, safe, slotId: slot, base: path.account, branch: path.branch }, TREE_SIZE);
      const operator = await source.address(OPERATOR_ACCOUNT);
      await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: operator, value: parseEther("1") }) });
    } else {
      const addresses: Address[] = [];
      for (let i = 0; i < TREE_SIZE; i++) addresses.push(await source.address(BASE + i));
      tree = createTreeFile({ chainId: foundry.id, safe, slotId: slot, base: BASE }, "m/44'/60'/{account}'/0/0", addresses);
    }
    trees.push(tree);
    for (const address of tree.addresses as Address[]) {
      await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: address, value: parseEther("0.05") }) });
    }
  }

  const loaded = trees.map((file) => loadTreeFile(JSON.stringify(file)));
  const install = installTx({
    safe,
    guard,
    oldOwners: legacy.map((a) => a.address),
    configs: loaded.map(({ file, tree }) => slotConfig(tree, file, 0, "")),
    stage: loaded.map(({ file, tree }) => stageEntries(tree, file, 1, 5)),
    multiSendCallOnly: multiSend,
  });
  const tx = plainSafeTx({ ...install, nonce: 0n });
  const hash = safeTxHash(foundry.id, safe, tx);
  const ecdsa = await legacy[1]!.sign({ hash });
  const executor = legacy[0]!;
  const pre = concatHex([pad(executor.address, { size: 32 }), pad("0x", { size: 32 }), "0x01"]);
  const signatures = BigInt(executor.address) < BigInt(legacy[1]!.address) ? concatHex([pre, ecdsa]) : concatHex([ecdsa, pre]);
  const wallet = createWalletClient({ account: executor, chain: foundry, transport: http(rpc) });
  const sent = await wallet.writeContract({
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, 0n, tx.gasPrice, ZERO, ZERO, signatures],
  });
  if ((await client.waitForTransactionReceipt({ hash: sent })).status !== "success") throw new Error("install failed");

  return { anvil, rpc, client, safe, guard, multiSend, singleton, factory, trees, stop: () => anvil.kill() };
}

interface StoredTx {
  tx: SafeTx;
  safeTxHash: Hex;
  confirmations: { owner: Address; signature: Hex; signatureType: "EOA" }[];
}

export interface FakeTxService {
  baseUrl: string;
  propose(tx: SafeTx): Hex;
  /** Removes a proposal, as when it is replaced in Safe{Wallet}. */
  drop(safeTxHash: Hex): void;
  stop(): Promise<void>;
}

/** In-memory stand-in for the two Safe Transaction Service endpoints the signer uses. Recovers each confirmer like the real service. */
export async function startFakeTxService(safe: Address, chainId: number): Promise<FakeTxService> {
  const store = new Map<string, StoredTx>();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const list = url.pathname.match(/^\/api\/v1\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/);
    if (req.method === "GET" && list) {
      const fromNonce = BigInt(url.searchParams.get("nonce__gte") ?? "0");
      const results = [...store.values()]
        .filter((entry) => entry.tx.nonce >= fromNonce)
        .sort((a, b) => Number(a.tx.nonce - b.tx.nonce))
        .map(({ tx, safeTxHash, confirmations }) => ({
          safe,
          ...Object.fromEntries(Object.entries(tx).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
          safeTxHash,
          confirmations,
        }));
      return json(200, { count: results.length, results });
    }
    if (req.method === "POST" && list) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const raw = JSON.parse(body) as Record<string, string | number | null>;
      const tx: SafeTx = {
        to: getAddress(String(raw.to)),
        value: BigInt(String(raw.value)),
        data: (raw.data ?? "0x") as Hex,
        operation: Number(raw.operation) === 1 ? 1 : 0,
        safeTxGas: BigInt(String(raw.safeTxGas)),
        baseGas: BigInt(String(raw.baseGas)),
        gasPrice: BigInt(String(raw.gasPrice)),
        gasToken: getAddress(String(raw.gasToken ?? ZERO)),
        refundReceiver: getAddress(String(raw.refundReceiver ?? ZERO)),
        nonce: BigInt(String(raw.nonce)),
      };
      const hash = safeTxHash(chainId, safe, tx);
      if (hash !== raw.contractTransactionHash) return json(422, { detail: "hash mismatch" });
      const owner = await recoverAddress({ hash, signature: raw.signature as Hex });
      if (owner !== getAddress(String(raw.sender))) return json(422, { detail: "signature is not from sender" });
      store.set(hash.toLowerCase(), { tx, safeTxHash: hash, confirmations: [{ owner, signature: raw.signature as Hex, signatureType: "EOA" }] });
      return json(201, {});
    }
    const confirm = url.pathname.match(/^\/api\/v1\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/confirmations\/$/);
    if (req.method === "POST" && confirm) {
      const entry = store.get(confirm[1]!.toLowerCase());
      if (!entry) return json(404, { detail: "not found" });
      let body = "";
      for await (const chunk of req) body += chunk;
      const signature = (JSON.parse(body) as { signature: Hex }).signature;
      const owner = await recoverAddress({ hash: entry.safeTxHash, signature });
      entry.confirmations.push({ owner, signature, signatureType: "EOA" });
      return json(201, {});
    }
    json(404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    propose(tx: SafeTx) {
      const hash = safeTxHash(chainId, safe, tx);
      store.set(hash.toLowerCase(), { tx, safeTxHash: hash, confirmations: [] });
      return hash;
    },
    drop(safeTxHash: Hex) {
      store.delete(safeTxHash.toLowerCase());
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface BlackHoleRpc {
  url: string;
  swallowed(): number;
  stop(): Promise<void>;
}

/** An RPC that answers like a private relay but never forwards raw transactions: what Flashbots Protect did on Sepolia. */
export async function startBlackHoleRpc(upstream: string): Promise<BlackHoleRpc> {
  let swallowed = 0;
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    res.writeHead(200, { "content-type": "application/json" });
    if (call.method === "eth_sendRawTransaction") {
      swallowed++;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: keccak256(call.params[0] as Hex) }));
      return;
    }
    const forwarded = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.end(await forwarded.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, swallowed: () => swallowed, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
