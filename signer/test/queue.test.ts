import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { createPublicClient, createWalletClient, custom, decodeFunctionResult, encodeFunctionData, getAddress, http, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { BrowserProvider, Contract } from "ethers";

import { TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { DappProvider, type DappRequest } from "../src/dapp.js";
import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const ORIGIN = "https://vault.example";
/** Anvil's first default account, unlocked on the node. */
const DEPLOYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../out/QueueMocks.sol/${name}.json`, import.meta.url), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

describe("queueing actions and proposing them together", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];
  let provider: DappProvider;
  let token: Address;
  let vault: Address;
  const tokenAbi = () => artifact("MockToken").abi;
  const vaultAbi = () => artifact("MockVault").abi;

  before(async () => {
    chain = await startChain(8557);
    service = await startFakeTxService(chain.safe, foundry.id);
    sessions = SIGNER_SEEDS.map(
      (seed, slot) =>
        new SignerSession({
          publicClient: chain.client,
          chain: foundry,
          executionRpcUrl: chain.rpc,
          txService: new TxService(foundry.id, { baseUrl: service.baseUrl }),
          source: seedSource(seed),
          tree: chain.trees[slot]!,
          safe: chain.safe,
          multiSendCallOnly: chain.multiSend,
        }),
    );
    const deployer = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(chain.rpc) });
    const deploy = async (name: string, args: unknown[] = []) => {
      const hash = await deployer.deployContract({ abi: artifact(name).abi, bytecode: artifact(name).bytecode.object, args });
      return getAddress((await chain.client.waitForTransactionReceipt({ hash })).contractAddress!);
    };
    token = await deploy("MockToken");
    vault = await deploy("MockVault", [token]);
    await chain.client.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: tokenAbi(), functionName: "mint", args: [chain.safe, 1000n] }) });

    sessions[0]!.setQueueMode(true);
    provider = new DappProvider({
      session: () => sessions[0],
      review: async (request: DappRequest) => ({ queued: await sessions[0]!.addToDraft({ kind: "calls", origin: request.origin, calls: request.calls }, request.origin) }),
    });
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const call = (method: string, params: unknown[] = []) => provider.request(ORIGIN, method, params);
  const approve = (amount: bigint) => encodeFunctionData({ abi: tokenAbi(), functionName: "approve", args: [vault, amount] });
  const deposit = (amount: bigint) => encodeFunctionData({ abi: vaultAbi(), functionName: "deposit", args: [amount] });
  const allowanceSeenByDapp = async () =>
    decodeFunctionResult({
      abi: tokenAbi(),
      functionName: "allowance",
      data: (await call("eth_call", [{ to: token, data: encodeFunctionData({ abi: tokenAbi(), functionName: "allowance", args: [chain.safe, vault] }) }, "latest"])) as Hex,
    }) as bigint;

  it("lets a dApp go from approve to deposit before anything is on-chain", async () => {
    await assert.rejects(call("eth_estimateGas", [{ from: chain.safe, to: vault, data: deposit(100n) }]), "without the approval, the deposit fails");

    const approveHash = (await call("eth_sendTransaction", [{ from: chain.safe, to: token, data: approve(100n) }])) as Hex;
    // How wagmi dApps wait: viem looks the transaction up first (to detect replacements), then reads the receipt.
    const dappClient = createPublicClient({ chain: foundry, transport: custom({ request: ({ method, params }) => call(method, params as unknown[]) }), pollingInterval: 50 });
    const receipt = await dappClient.waitForTransactionReceipt({ hash: approveHash, timeout: 5_000 });
    assert.equal(receipt.status, "success", "the dApp sees the queued approval as done and moves on");
    assert.equal(await allowanceSeenByDapp(), 100n, "reads run on top of the queue");
    assert.ok(BigInt((await call("eth_estimateGas", [{ from: chain.safe, to: vault, data: deposit(100n) }])) as string) > 21_000n);
    await call("eth_sendTransaction", [{ from: chain.safe, to: vault, data: deposit(100n) }]);

    const simulation = await sessions[0]!.simulateDraft();
    assert.equal(simulation.available, true);
    assert.deepEqual(simulation.calls.map((c) => c.ok), [true, true]);
    assert.deepEqual(simulation.changes.map((c) => [c.symbol, c.delta]), [["MOCK", "-100"]]);
    assert.equal(sessions[0]!.draft().items.length, 2);
  });

  it("lets an ethers dApp (like testnet.raac.io) finish waiting for a queued approval", async () => {
    sessions[0]!.clearDraft();
    // ethers polls eth_getTransactionByHash until the transaction exists, then waits for its receipt.
    const ethersProvider = new BrowserProvider({ request: ({ method, params }) => call(method, (params ?? []) as unknown[]) }, foundry.id, { polling: true, pollingInterval: 50 } as never);
    const signer = await ethersProvider.getSigner(chain.safe);
    const erc20 = new Contract(token, ["function approve(address,uint256) returns (bool)"], signer);
    const sent = await Promise.race([
      erc20.getFunction("approve")(vault, 100n),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ethers never saw the transaction")), 5_000)),
    ]);
    const receipt = await Promise.race([
      (sent as { wait(): Promise<{ status: number }> }).wait(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ethers never saw the receipt")), 5_000)),
    ]);
    assert.equal(receipt.status, 1);
    assert.equal(await allowanceSeenByDapp(), 100n);
    sessions[0]!.clearDraft();
    ethersProvider.destroy();
  });

  it("proposes the whole queue as one transaction; one execution does both", async () => {
    await call("eth_sendTransaction", [{ from: chain.safe, to: token, data: approve(100n) }]);
    await call("eth_sendTransaction", [{ from: chain.safe, to: vault, data: deposit(100n) }]);
    const proposal = await sessions[0]!.proposeDraft();
    assert.equal(proposal.actions.length, 2);
    assert.equal(sessions[0]!.draft().items.length, 0, "the queue empties once proposed");

    const sent = await sessions[1]!.execute(proposal.safeTxHash);
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash })).status, "success");
    const deposited = await chain.client.readContract({ address: vault, abi: vaultAbi(), functionName: "deposits", args: [chain.safe] });
    assert.equal(deposited, 100n);
    assert.equal(await allowanceSeenByDapp(), 0n, "with the queue empty, reads go to the chain again");
  });

  it("shows which queued action would fail before anyone signs", async () => {
    await sessions[0]!.addToDraft({ kind: "calls", origin: ORIGIN, calls: [{ to: token, data: approve(5000n) }] });
    await sessions[0]!.addToDraft({ kind: "calls", origin: ORIGIN, calls: [{ to: vault, data: deposit(5000n) }] });
    const simulation = await sessions[0]!.simulateDraft();
    assert.deepEqual(simulation.calls.map((c) => c.ok), [true, false], "the Safe holds only 900");
    const [first] = sessions[0]!.draft().items;
    sessions[0]!.moveInDraft(first!.id, 1);
    assert.equal(sessions[0]!.draft().items[1]!.id, first!.id);
    sessions[0]!.clearDraft();
    await assert.rejects(sessions[0]!.addToDraft({ kind: "escape" }), /cannot be queued/);
  });
});
