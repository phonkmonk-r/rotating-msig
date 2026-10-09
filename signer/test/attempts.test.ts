import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { foundry } from "viem/chains";

import { plainSafeTx, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession, type Execution } from "../src/session.js";
import { fileStore } from "../src/store.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startBlackHoleRpc, startChain, startFakeTxService, type BlackHoleRpc, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000beef";

describe("executions that never land", { skip, timeout: 120_000 }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let blackHole: BlackHoleRpc;
  let dataDir: string;

  const session = (slot: number, executionRpcUrl: string, store?: string) =>
    new SignerSession({
      publicClient: chain.client,
      chain: foundry,
      executionRpcUrl,
      txService: new TxService(foundry.id, { baseUrl: service.baseUrl }),
      source: seedSource(SIGNER_SEEDS[slot]!),
      tree: chain.trees[slot]!,
      safe: chain.safe,
      multiSendCallOnly: chain.multiSend,
      executionTimeoutMs: 300,
      store: store ? fileStore(store) : undefined,
    });

  async function follow(signer: SignerSession, hash: Hex, until: (record: Execution) => boolean): Promise<Execution> {
    for (let i = 0; i < 100; i++) {
      const record = await signer.execution(hash);
      if (until(record)) return record;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the execution never reached the expected state");
  }

  const nonce = async () => (await session(0, chain.rpc).status()).nonce;

  before(async () => {
    chain = await startChain(8562);
    service = await startFakeTxService(chain.safe, foundry.id);
    blackHole = await startBlackHoleRpc(chain.rpc);
    dataDir = mkdtempSync(join(tmpdir(), "cicada-attempts-"));
  });

  after(async () => {
    await blackHole.stop();
    await service.stop();
    chain.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a lost execution across a restart and lands it with a speed-up from the same key and nonce", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce: BigInt(await nonce()) }));
    await session(0, chain.rpc).confirm(hash);

    const executor = session(1, blackHole.url, dataDir);
    const sent = await executor.execute(hash);
    assert.equal(sent.status, "pending");
    const stuck = await follow(executor, hash, (record) => record.status === "stuck");
    assert.match(String(stuck.message), /Speed up sends it again/);
    assert.equal(blackHole.swallowed(), 1);

    const [item] = await executor.queue();
    assert.equal(item!.attempt?.status, "stuck", "the queue carries the open attempt");
    assert.equal(item!.verdict.action, "none");
    assert.match(item!.verdict.blockers.join(), /already sent an execution/);
    await assert.rejects(executor.execute(hash), /already sent an execution/);
    const status = await executor.status();
    assert.equal(status.exposure?.nonce, item!.nonce);
    assert.deepEqual(status.exposure?.slotIds, [0, 1], "the executor and the confirmer are both exposed");
    assert.match(status.findings.map((finding) => finding.message).join(), /never went through/);

    // A restart: the attempt comes back from disk, and the execution RPC now works.
    const restarted = session(1, chain.rpc, dataDir);
    const [resumed] = await restarted.queue();
    assert.equal(resumed!.attempt?.status, "stuck");
    assert.equal(resumed!.attempt?.transactionHash, stuck.transactionHash);
    const resent = await restarted.speedUp(hash);
    assert.notEqual(resent.transactionHash, stuck.transactionHash);
    assert.deepEqual(resent.previousHashes, [stuck.transactionHash]);
    const landed = await follow(restarted, hash, (record) => record.status === "success");
    assert.equal(landed.rotated?.length, 2, "executor and confirmer rotated");
    await assert.rejects(chain.client.getTransactionReceipt({ hash: stuck.transactionHash! }), "the first send can never be mined");
    assert.equal((await restarted.status()).exposure, undefined, "rotated keys are no longer exposed");
    assert.equal((await restarted.status()).me?.index, 1);
    service.drop(hash);
  });

  it("replaces the exposed keys at the same nonce when the execution is abandoned", async () => {
    const current = BigInt(await nonce());
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce: current }));
    const confirmer = session(0, chain.rpc);
    await confirmer.confirm(hash);
    const executor = session(1, blackHole.url);
    await executor.execute(hash);
    await follow(executor, hash, (record) => record.status === "stuck");

    const preview = await executor.recover(true);
    assert.deepEqual(preview.slotIds, [0, 1]);
    assert.equal(preview.nonce, current.toString(), "proposed at the lost transaction's nonce, so it takes its place");
    assert.match(preview.actions[0]!.summary, /Rotate slot\(s\) 0, 1/);
    const proposed = await executor.recover(false);
    assert.equal(proposed.proposed, true);

    const recovery = (await confirmer.queue()).find((item) => item.safeTxHash === proposed.safeTxHash);
    assert.equal(recovery?.verdict.action, "execute", "the exposed confirmer may execute the recovery");
    await confirmer.execute(proposed.safeTxHash);
    const done = await follow(confirmer, proposed.safeTxHash, (record) => record.status !== "pending");
    assert.equal(done.status, "success");
    assert.deepEqual(done.rotated?.map((change) => change.slotId).sort(), [0, 1]);

    assert.equal((await executor.status()).exposure, undefined);
    assert.equal((await executor.execution(hash)).status, "replaced");
    assert.equal(BigInt(await nonce()), current + 1n);
    service.drop(hash);
  });
});
