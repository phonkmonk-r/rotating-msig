import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Address } from "viem";
import { foundry } from "viem/chains";

import { readSafeState, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession, type Execution } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000c0de";

describe("a Safe with threshold 1", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];
  let txService: TxService;

  before(async () => {
    chain = await startChain(8563);
    service = await startFakeTxService(chain.safe, foundry.id);
    txService = new TxService(foundry.id, { baseUrl: service.baseUrl, pendingCacheMs: 0 });
    sessions = SIGNER_SEEDS.map(
      (seed, slot) =>
        new SignerSession({
          publicClient: chain.client,
          chain: foundry,
          executionRpcUrl: chain.rpc,
          txService: new TxService(foundry.id, { baseUrl: service.baseUrl, pendingCacheMs: 0 }),
          source: seedSource(seed),
          tree: chain.trees[slot]!,
          safe: chain.safe,
          multiSendCallOnly: chain.multiSend,
        }),
    );
    const lower = await sessions[0]!.propose({ kind: "threshold", threshold: 1 });
    const sent = await sessions[1]!.execute(lower.safeTxHash);
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! })).status, "success");
    assert.equal((await readSafeState(chain.client, chain.safe)).threshold, 1);
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  async function settled(session: SignerSession, hash: `0x${string}`): Promise<Execution> {
    for (let i = 0; i < 100; i++) {
      const execution = await session.execution(hash);
      if (execution.status !== "preparing" && execution.status !== "pending") return execution;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the execution never settled");
  }

  it("previews a transaction as executing directly, without sending anything", async () => {
    const preview = await sessions[2]!.propose({ kind: "eth", to: RECIPIENT, amount: "1000" }, true);
    assert.equal(preview.direct, true);
    assert.equal(preview.proposed, false);
    assert.deepEqual(await txService.pending(chain.safe, (await readSafeState(chain.client, chain.safe)).nonce), []);
  });

  it("executes at once, rotates only its signer, and never posts to the Transaction Service", async () => {
    const before = await readSafeState(chain.client, chain.safe);
    const owners = before.slots.map((slot) => slot.owner);

    const result = await sessions[2]!.propose({ kind: "eth", to: RECIPIENT, amount: "1000" });
    assert.equal(result.direct, true);
    assert.equal(result.proposed, true);
    assert.equal((await sessions[2]!.queue())[0]?.safeTxHash, result.safeTxHash, "the queue shows it while it executes");

    const execution = await settled(sessions[2]!, result.safeTxHash);
    assert.equal(execution.status, "success", JSON.stringify(execution));
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), 1000n);

    const after = await readSafeState(chain.client, chain.safe);
    assert.equal(after.nonce, before.nonce + 1n);
    assert.notEqual(after.slots[2]!.owner, owners[2], "the only signer rotated");
    assert.equal(after.slots[0]!.owner, owners[0]);
    assert.equal(after.slots[1]!.owner, owners[1]);
    assert.deepEqual(await txService.pending(chain.safe, before.nonce), [], "nothing went to the Transaction Service");
    assert.deepEqual(await sessions[2]!.queue(), [], "the executed transaction leaves the queue");
  });

  it("lets the next transaction go out from the rotated key", async () => {
    const result = await sessions[2]!.propose({ kind: "eth", to: RECIPIENT, amount: "1" });
    assert.equal((await settled(sessions[2]!, result.safeTxHash)).status, "success");
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), 1001n);
  });
});
