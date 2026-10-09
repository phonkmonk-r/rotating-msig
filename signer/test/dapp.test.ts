import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { numberToHex, parseEther, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";

import { TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { DappProvider, ProviderError, USER_REJECTED, type DappRequest } from "../src/dapp.js";
import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const ORIGIN = "https://app.example";
const ALICE: Address = "0x000000000000000000000000000000000000A11c";
const BOB: Address = "0x000000000000000000000000000000000000b0B0";

describe("dApp browser wallet", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];
  let provider: DappProvider;
  let decide: (request: DappRequest, session: SignerSession) => Promise<Awaited<ReturnType<SignerSession["propose"]>>>;
  const reviewed: DappRequest[] = [];

  before(async () => {
    chain = await startChain(8552);
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
    decide = (request, session) => session.propose({ kind: "calls", origin: request.origin, calls: request.calls });
    provider = new DappProvider(
      {
        session: () => sessions[0],
        review: (request) => {
          reviewed.push(request);
          return decide(request, sessions[0]!);
        },
      },
      100,
    );
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const call = (method: string, params: unknown[] = []) => provider.request(ORIGIN, method, params);
  const rejectsWith = (promise: Promise<unknown>, code: number) => assert.rejects(promise, (error: ProviderError) => error.code === code);

  it("presents the Safe as the account and forwards reads", async () => {
    assert.equal(await call("eth_chainId"), numberToHex(foundry.id));
    assert.deepEqual(await call("eth_requestAccounts"), [chain.safe]);
    assert.equal(await call("wallet_switchEthereumChain", [{ chainId: numberToHex(foundry.id) }]), null);
    await rejectsWith(call("wallet_switchEthereumChain", [{ chainId: "0x1" }]), 4902);
    assert.equal(BigInt((await call("eth_getBalance", [chain.safe, "latest"])) as string) > 0n, true);
  });

  it("refuses message signing and unknown methods", async () => {
    await rejectsWith(call("personal_sign", ["0x68656c6c6f", chain.safe]), 4200);
    await rejectsWith(call("eth_signTypedData_v4", [chain.safe, "{}"]), 4200);
    await rejectsWith(call("eth_sendRawTransaction", ["0x00"]), 4200);
    await rejectsWith(call("eth_sendTransaction", [{ from: ALICE, to: BOB, value: "0x1" }]), 4100);
    assert.equal(reviewed.length, 0, "nothing reached review");
  });

  it("turns wallet_sendCalls into one batched proposal, and reports it once another signer executes", async () => {
    const value = numberToHex(parseEther("0.01"));
    const { id } = (await call("wallet_sendCalls", [{ version: "2.0.0", chainId: numberToHex(foundry.id), from: chain.safe, calls: [{ to: ALICE, value }, { to: BOB, value }] }])) as { id: Hex };
    assert.equal(reviewed.at(-1)!.calls.length, 2);
    assert.equal(((await call("wallet_getCallsStatus", [id])) as { status: number }).status, 100);
    assert.equal(await call("eth_getTransactionReceipt", [id]), null);

    const queue = await sessions[1]!.queue();
    assert.equal(queue[0]!.safeTxHash, id);
    assert.equal(queue[0]!.actions.length, 2);
    const sent = await sessions[1]!.execute(id);
    for (let i = 0; i < 50 && (await sessions[1]!.execution(sent.transactionHash!)).status === "pending"; i++) await new Promise((r) => setTimeout(r, 100));

    const status = (await call("wallet_getCallsStatus", [id])) as { status: number; receipts: { transactionHash: Hex; status: Hex }[] };
    assert.equal(status.status, 200);
    assert.equal(status.receipts[0]!.transactionHash, sent.transactionHash!);
    const receipt = (await call("eth_getTransactionReceipt", [id])) as { transactionHash: Hex; status: Hex };
    assert.equal(receipt.transactionHash, sent.transactionHash!);
    assert.equal(receipt.status, "0x1");
    assert.equal(await chain.client.getBalance({ address: BOB }), parseEther("0.01"));
  });

  it("answers eth_sendTransaction with the real execution hash, which a dApp's own RPC can find", async () => {
    const sending = call("eth_sendTransaction", [{ from: chain.safe, to: ALICE, value: "0x1", nonce: "0x1" }]) as Promise<Hex>;
    let queue = await sessions[1]!.queue();
    for (let i = 0; i < 50 && queue.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      queue = await sessions[1]!.queue();
    }
    const executed = await sessions[1]!.execute(queue[0]!.safeTxHash);
    const hash = await sending;
    assert.equal(hash, executed.transactionHash!);
    assert.equal(reviewed.at(-1)?.readsOwnRpc, true, "a dApp that sets the nonce reads its own RPC");
    assert.equal((await chain.client.getTransactionReceipt({ hash })).status, "success", "the hash is a mined transaction");
  });

  it("passes on the user's refusal and the rules' refusals, and handles one request at a time", async () => {
    decide = () => Promise.reject(new ProviderError(USER_REJECTED, "User rejected the request"));
    await rejectsWith(call("eth_sendTransaction", [{ to: ALICE, value: "0x1" }]), USER_REJECTED);

    decide = (request, session) => session.propose({ kind: "calls", origin: request.origin, calls: request.calls }, true);
    await assert.rejects(call("eth_sendTransaction", [{ to: chain.safe, data: "0x" }]), /cannot call the Safe/);

    let release!: () => void;
    decide = () => new Promise((_, reject) => (release = () => reject(new ProviderError(USER_REJECTED, "no"))));
    const first = call("eth_sendTransaction", [{ to: ALICE, value: "0x1" }]);
    await new Promise((r) => setTimeout(r, 50));
    await rejectsWith(call("eth_sendTransaction", [{ to: BOB, value: "0x1" }]), -32002);
    release();
    await rejectsWith(first, USER_REJECTED);
  });
});
