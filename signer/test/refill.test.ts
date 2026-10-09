import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { numberToHex, parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { readSafeState, TxService } from "@rotating-msig/core";
import { OPERATOR_ACCOUNT, seedSource } from "@rotating-msig/keys";

import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

describe("refilling staged keys from the gas account", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];

  before(async () => {
    chain = await startChain(8555);
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
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const staged = async (slot: number) => (await readSafeState(chain.client, chain.safe)).slots[slot]!.staged.length;
  const gasAccount = (slot: number) => seedSource(SIGNER_SEEDS[slot]!).address(OPERATOR_ACCOUNT);

  async function transfer(proposer: number, executor: number) {
    const proposal = await sessions[proposer]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("0.001").toString() });
    const sent = await sessions[executor]!.execute(proposal.safeTxHash);
    await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! });
  }

  it("does nothing while the buffer is full", async () => {
    assert.equal(await staged(0), 5);
    assert.equal(await sessions[0]!.refill(), undefined);
  });

  it("waits for two free places, then refills to full from the gas account", async () => {
    await chain.client.request({ method: "anvil_setBalance" as never, params: [await gasAccount(0), numberToHex(parseEther("1"))] as never });
    await transfer(0, 1);
    assert.equal(await staged(0), 4);
    assert.equal(await sessions[0]!.autoRefill(), undefined, "one free place is not worth a transaction");

    await transfer(0, 1);
    assert.equal(await staged(0), 3);
    const refill = await sessions[0]!.autoRefill();
    assert.equal(refill?.count, 2);
    assert.equal(await staged(0), 5);
    const tx = await chain.client.getTransaction({ hash: refill!.transactionHash });
    assert.equal(tx.from.toLowerCase(), (await gasAccount(0)).toLowerCase(), "paid by the gas account, not an owner key");
    assert.equal((await sessions[0]!.status()).me?.lastRefill?.refill?.count, 2);
  });

  it("reports a gas account that cannot pay instead of failing silently", async () => {
    await chain.client.request({ method: "anvil_setBalance" as never, params: [await gasAccount(1), "0x0"] as never });
    await transfer(0, 1);
    await transfer(0, 1);
    assert.equal(await staged(1), 1);
    assert.equal(await sessions[1]!.autoRefill(), undefined);
    const status = await sessions[1]!.status();
    assert.match(status.me!.lastRefill!.error!, /gas account .* needs about/);
    assert.ok(status.findings.some((finding) => finding.message.startsWith("Refilling your next keys failed")));
  });
});
