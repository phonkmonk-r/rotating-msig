import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { readSafeState, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

describe("proposing from the app", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];

  before(async () => {
    chain = await startChain(8551);
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

  async function executeAndWait(session: SignerSession, hash: `0x${string}`) {
    const sent = await session.execute(hash);
    for (let i = 0; i < 50; i++) {
      const status = await session.execution(sent.transactionHash);
      if (status.status !== "pending") return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("execution stayed pending");
  }

  it("previews, proposes, and lets another signer execute; both rotate", async () => {
    const input = { kind: "eth" as const, to: RECIPIENT, amount: parseEther("0.1").toString() };
    const preview = await sessions[0]!.propose(input, true);
    assert.equal(preview.proposed, false);
    assert.match(preview.actions[0]!.summary, /Send 0.1 ETH/);
    assert.equal((await sessions[0]!.queue()).length, 0, "a preview sends nothing");

    const proposed = await sessions[0]!.propose(input);
    assert.equal(proposed.proposed, true);
    assert.equal(proposed.safeTxHash, preview.safeTxHash);

    const [mine] = await sessions[0]!.queue();
    assert.equal(mine!.verdict.action, "none", "the proposer's signature is their confirmation");
    const [theirs] = await sessions[1]!.queue();
    assert.equal(theirs!.verdict.action, "execute");

    const executed = await executeAndWait(sessions[1]!, proposed.safeTxHash);
    assert.equal(executed.status, "success");
    assert.deepEqual(executed.rotated!.map((r) => r.slotId).sort(), [0, 1]);
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), parseEther("0.1"));
  });

  it("refuses a second proposal while one is pending, and checks the balance", async () => {
    await sessions[2]!.propose({ kind: "eth", to: RECIPIENT, amount: "1" });
    await assert.rejects(sessions[1]!.propose({ kind: "eth", to: RECIPIENT, amount: "1" }), /still pending/);
    await assert.rejects(sessions[1]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("1000").toString() }, true), /still pending|does not hold/);
    const [pending] = await sessions[0]!.queue();
    await executeAndWait(sessions[0]!, pending!.safeTxHash);
    await assert.rejects(sessions[1]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("1000").toString() }, true), /does not hold that much ETH/);
  });

  it("proposes a force-rotate of a slot that did not sign", async () => {
    const before = await readSafeState(chain.client, chain.safe);
    const slot1Index = before.slots.find((s) => s.slotId === 1)!.ownerIndex;
    const proposed = await sessions[0]!.propose({ kind: "force-rotate", slotIds: [1] });
    assert.match(proposed.actions[0]!.summary, /forceRotate/);
    await executeAndWait(sessions[2]!, proposed.safeTxHash);
    const after = await readSafeState(chain.client, chain.safe);
    assert.equal(after.slots.find((s) => s.slotId === 1)!.ownerIndex, slot1Index + 1, "slot 1 rotated without signing");
  });
});
