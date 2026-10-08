import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
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
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { rotationGuardAbi, safeAbi } from "../src/index.js";
import { guardCalls, installTx, type MetaTx } from "../src/calls.js";
import { describeRevert } from "../src/errors.js";
import { plainSafeTx, safeTxHash } from "../src/safetx.js";
import { assess, readSafeState } from "../src/state.js";
import { createTreeFile, loadTreeFile, slotConfig, stageEntries, type TreeFile } from "../src/tree.js";

const OUT = new URL("../../../out/", import.meta.url);
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TREE_SIZE = 12;

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasArtifacts = existsSync(new URL("RotationGuard.sol/RotationGuard.json", OUT));
const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;

function artifact(path: string): { abi: unknown[]; bytecode: Hex } {
  const json = JSON.parse(readFileSync(new URL(path, OUT), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const anvilAccount = (i: number) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i });
const treeKey = (slot: number, index: number): Hex => keccak256(toHex(`tree-${slot}-${index}`));

describe("core against a local chain", { skip }, () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  let safe: Address;
  let guard: Address;
  let multiSend: Address;
  const trees: TreeFile[] = [];

  async function deploy(path: string, args: Hex = "0x"): Promise<Address> {
    const wallet = createWalletClient({ account: anvilAccount(9), chain: foundry, transport: http(RPC) });
    const hash = await wallet.sendTransaction({ data: concatHex([artifact(path).bytecode, args]) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    return getAddress(receipt.contractAddress!);
  }

  /** Executes as Safe owners: `signer` signs the safeTxHash off-chain, `executor` sends with a pre-validated signature. */
  async function execute(tx: MetaTx, executor: PrivateKeyAccount, signer: PrivateKeyAccount) {
    const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const hash = await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "getTransactionHash",
      args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, zero, zero, nonce],
    });
    assert.equal(safeTxHash(foundry.id, safe, { ...plainSafeTx({ ...tx, nonce }) }), hash, "local SafeTx hash must match the contract");
    const ecdsa = await signer.sign({ hash });
    const preValidated = concatHex([pad(executor.address, { size: 32 }), pad("0x", { size: 32 }), "0x01"]);
    const signatures = BigInt(executor.address) < BigInt(signer.address) ? concatHex([preValidated, ecdsa]) : concatHex([ecdsa, preValidated]);
    const wallet = createWalletClient({ account: executor, chain: foundry, transport: http(RPC) });
    const sent = await wallet.writeContract({
      address: safe,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, zero, zero, signatures],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: sent });
    assert.equal(receipt.status, "success");
  }

  function keyOf(owner: Address): PrivateKeyAccount {
    for (let slot = 0; slot < 3; slot++) {
      for (let index = 0; index < TREE_SIZE; index++) {
        const account = privateKeyToAccount(treeKey(slot, index));
        if (account.address === owner) return account;
      }
    }
    throw new Error(`unknown owner ${owner}`);
  }

  before(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    client = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        if (i > 50) throw new Error("anvil did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const singleton = await deploy("Safe.sol/Safe.json");
    const factory = await deploy("SafeProxyFactory.sol/SafeProxyFactory.json");
    multiSend = await deploy("MultiSendCallOnly.sol/MultiSendCallOnly.json");
    guard = await deploy("RotationGuard.sol/RotationGuard.json", pad(multiSend, { size: 32 }));

    const owners = [0, 1, 2].map((i) => anvilAccount(i).address);
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [owners, 2n, zero, "0x", zero, zero, 0n, zero] });
    const factoryAbi = artifact("SafeProxyFactory.sol/SafeProxyFactory.json").abi as never;
    const wallet = createWalletClient({ account: anvilAccount(9), chain: foundry, transport: http(RPC) });
    const { result, request } = await client.simulateContract({
      account: anvilAccount(9),
      address: factory,
      abi: factoryAbi,
      functionName: "createProxyWithNonce",
      args: [singleton, initializer, 0n],
    });
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    safe = getAddress(result as Address);
    await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: safe, value: parseEther("5") }) });

    for (let slot = 0; slot < 3; slot++) {
      const addresses = Array.from({ length: TREE_SIZE }, (_, index) => privateKeyToAccount(treeKey(slot, index)).address);
      trees.push(createTreeFile({ chainId: foundry.id, safe, slotId: slot, base: 0 }, "test", addresses));
      for (const address of addresses) {
        await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: address, value: parseEther("0.1") }) });
      }
    }
  });

  after(() => anvil?.kill());

  it("reports a Safe without the guard as not installed", async () => {
    const state = await readSafeState(client, safe);
    assert.equal(state.installed, false);
    assert.equal(assess(state)[0]?.severity, "critical");
  });

  it("installs the guard with installTx and reads it back", async () => {
    const oldOwners = await client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    const loaded = trees.map((file) => loadTreeFile(JSON.stringify(file)));
    const tx = installTx({
      safe,
      guard,
      oldOwners,
      configs: loaded.map(({ file, tree }) => slotConfig(tree, file, 0, "")),
      stage: loaded.map(({ file, tree }) => stageEntries(tree, file, 1, 5)),
      multiSendCallOnly: multiSend,
    });
    await execute(tx, anvilAccount(0) as unknown as PrivateKeyAccount, anvilAccount(1) as unknown as PrivateKeyAccount);

    const state = await readSafeState(client, safe);
    assert.equal(state.installed, true);
    assert.equal(state.slots.length, 3);
    for (const slot of state.slots) {
      assert.equal(slot.owner, trees[slot.slotId]!.addresses[0]);
      assert.equal(slot.ownerIndex, 0);
      assert.equal(slot.staged.length, 5);
      assert.equal(slot.nextStageIndex, 6);
      assert.equal(slot.root, trees[slot.slotId]!.root);
    }
    assert.deepEqual(assess(state), []);
  });

  it("rotates signers and refills a buffer with guardCalls.stage", async () => {
    const before = await readSafeState(client, safe);
    const executor = keyOf(before.slots[0]!.owner);
    const signer = keyOf(before.slots[1]!.owner);
    await execute({ to: anvilAccount(7).address, value: 1n, data: "0x", operation: 0 }, executor, signer);

    const after = await readSafeState(client, safe);
    assert.equal(after.slots[0]!.ownerIndex, 1);
    assert.equal(after.slots[1]!.ownerIndex, 1);
    assert.equal(after.slots[2]!.ownerIndex, 0);
    assert.ok(!after.owners.includes(executor.address));
    assert.ok(!after.owners.includes(signer.address));

    const { file, tree } = loadTreeFile(JSON.stringify(trees[0]));
    const stage = guardCalls.stage(guard, safe, 0, stageEntries(tree, file, after.slots[0]!.nextStageIndex, 1));
    const keeper = createWalletClient({ account: anvilAccount(8), chain: foundry, transport: http(RPC) });
    await client.waitForTransactionReceipt({ hash: await keeper.sendTransaction({ to: stage.to, data: stage.data }) });
    const refilled = await readSafeState(client, safe);
    assert.equal(refilled.slots[0]!.staged.length, 5);
    assert.equal(
      await client.readContract({ address: guard, abi: rotationGuardAbi, functionName: "consumedUpTo", args: [safe, file.root] }),
      0,
    );
  });

  it("flags empty and low buffers, and names the guard's revert", async () => {
    for (let round = 0; round < 4; round++) {
      const state = await readSafeState(client, safe);
      await execute({ to: anvilAccount(7).address, value: 1n, data: "0x", operation: 0 }, keyOf(state.slots[2]!.owner), keyOf(state.slots[1]!.owner));
    }
    const state = await readSafeState(client, safe);
    const findings = assess(state);
    assert.ok(findings.some((f) => f.severity === "critical" && f.slotId === 1 && /no staged address/.test(f.message)));
    assert.ok(findings.some((f) => f.severity === "warning" && f.slotId === 2 && /only 1 staged/.test(f.message)));
    assert.equal(state.nonce, 6n);

    await assert.rejects(
      execute({ to: anvilAccount(7).address, value: 1n, data: "0x", operation: 0 }, keyOf(state.slots[1]!.owner), keyOf(state.slots[0]!.owner)),
      (error: unknown) => describeRevert(error) === "BufferEmpty(1)",
    );
  });
});
