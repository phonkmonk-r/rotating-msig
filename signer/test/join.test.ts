import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { foundry } from "viem/chains";

import { plainSafeTx, readSafeState, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { JoinError, joinSafe, type JoinProgress } from "../src/join.js";
import { SignerSession } from "../src/session.js";
import { BASE, hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const OUTSIDER = "test test test test test test test test test test test junk";

describe("joining a Safe from a seed alone", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;

  before(async () => {
    chain = await startChain(8550);
    service = await startFakeTxService(chain.safe, foundry.id);
  });
  after(async () => {
    await service?.stop();
    chain?.stop();
  });

  const join = (seed: string, onProgress?: (p: JoinProgress) => void) =>
    joinSafe({ source: seedSource(seed), safe: chain.safe, chainId: foundry.id, client: chain.client, bases: [BASE], onProgress });

  it("finds each signer's slot and rebuilds a tree matching the on-chain root", async () => {
    for (const [slot, seed] of SIGNER_SEEDS.entries()) {
      const stages = new Set<string>();
      const joined = await join(seed, (p) => stages.add(p.stage));
      assert.equal(joined.slotId, slot);
      assert.equal(joined.index, 0);
      assert.equal(joined.base, BASE);
      assert.equal(joined.tree.root, chain.trees[slot]!.root);
      assert.deepEqual([...stages], ["network", "reading", "finding", "deriving", "verifying"]);
    }
  });

  it("finds a signer who has already rotated, at their current index", async () => {
    const session = (slot: number) =>
      new SignerSession({
        publicClient: chain.client,
        chain: foundry,
        executionRpcUrl: chain.rpc,
        txService: new TxService(foundry.id, { baseUrl: service.baseUrl }),
        source: seedSource(SIGNER_SEEDS[slot]!),
        tree: chain.trees[slot]!,
        safe: chain.safe,
        multiSendCallOnly: chain.multiSend,
      });
    const hash = service.propose(plainSafeTx({ to: "0x000000000000000000000000000000000000bEEF", value: 1n, data: "0x", operation: 0, nonce: 1n }));
    await session(0).confirm(hash);
    const executor = session(1);
    const sent = await executor.execute(hash);
    for (let i = 0; i < 50 && (await executor.execution(sent.transactionHash!)).status === "pending"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const joined = await join(SIGNER_SEEDS[1]!);
    assert.equal(joined.slotId, 1);
    assert.equal(joined.index, 1);
    assert.ok((await readSafeState(chain.client, chain.safe)).owners.includes(joined.tree.addresses[1]!));
  });

  it("explains why a seed cannot join", async () => {
    await assert.rejects(join(OUTSIDER), (error: unknown) => error instanceof JoinError && error.kind === "not-owner");
    await assert.rejects(
      joinSafe({ source: seedSource(OUTSIDER), safe: "0x1234", chainId: foundry.id, client: chain.client }),
      (error: unknown) => error instanceof JoinError && error.kind === "invalid-address",
    );
  });
});
