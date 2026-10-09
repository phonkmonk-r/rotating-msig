import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWalletClient, http, parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { readSafeState, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession } from "../src/session.js";
import { BASE, hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

describe("never staging keys that were used elsewhere", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let sessions: SignerSession[];

  before(async () => {
    chain = await startChain(8558);
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
    // Slot 0's key 6 (not staged yet; keys 1 to 5 are) sends a transaction, as if someone used it in another wallet.
    const used = await seedSource(SIGNER_SEEDS[0]!).signer(BASE + 6);
    const wallet = createWalletClient({ account: used, chain: foundry, transport: http(chain.rpc) });
    await chain.client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: RECIPIENT, value: 1n }) });
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const slot0 = async () => (await readSafeState(chain.client, chain.safe)).slots[0]!;

  it("flags the used key and refuses to stage it", async () => {
    const proposal = await sessions[0]!.propose({ kind: "eth", to: RECIPIENT, amount: parseEther("0.001").toString() });
    await chain.client.waitForTransactionReceipt({ hash: (await sessions[1]!.execute(proposal.safeTxHash)).transactionHash });
    assert.equal((await slot0()).staged.length, 4);

    await sessions[0]!.autoRefill();
    const status = await sessions[0]!.status();
    assert.deepEqual(status.me!.usedKeys!.map((key) => key.index), [6]);
    assert.ok(status.findings.some((finding) => /Key 6 was already used/.test(finding.message)));
    await assert.rejects(sessions[0]!.refill(), /key 6 was already used/);
    assert.equal((await slot0()).staged.length, 4, "nothing was staged");
  });

  it("skips past it and stages the next fresh keys in one transaction", async () => {
    const input = await sessions[0]!.skipUsedKeysInput();
    assert.equal(input.kind === "skip-keys" && input.index, 7);
    const proposal = await sessions[0]!.propose(input);
    assert.match(proposal.actions.map((action) => action.summary).join(" | "), /Skip slot 0 ahead to key 7.*Stage 5 next key/);
    await chain.client.waitForTransactionReceipt({ hash: (await sessions[1]!.execute(proposal.safeTxHash)).transactionHash });

    const slot = await slot0();
    assert.equal(slot.ownerIndex, 7, "slot 0 rotated straight to key 7, never key 6");
    assert.equal(slot.staged.length, 4);
    await sessions[0]!.autoRefill();
    assert.equal((await sessions[0]!.status()).me!.usedKeys!.length, 0);
  });
});
