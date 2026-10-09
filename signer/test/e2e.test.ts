import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { plainSafeTx, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { serve, type SignerServer } from "../src/server.js";
import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startBlackHoleRpc, startChain, startFakeTxService, type Chain, type FakeTxService } from "./fixture.js";

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;
const RECIPIENT: Address = "0x000000000000000000000000000000000000beef";

describe("rotation signer end to end", { skip }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let servers: SignerServer[];

  async function api(server: SignerServer, path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", ...headers },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> & unknown[] };
  }

  const post = (server: SignerServer, path: string, safeTxHash: string) => api(server, path, { method: "POST", body: JSON.stringify({ safeTxHash }) });

  /** Starts an execution the way the app does, and follows it by its Safe hash until it is no longer in flight. */
  async function executeAndWait(server: SignerServer, safeTxHash: string) {
    const sent = await post(server, "/api/execute", safeTxHash);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "preparing", "the API answers at once and reports steps as they happen");
    for (let i = 0; i < 100; i++) {
      const { body } = await api(server, `/api/executions/${safeTxHash}`);
      if (body.status !== "pending" && body.status !== "preparing") return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("execution stayed pending");
  }

  before(async () => {
    chain = await startChain(8548);
    service = await startFakeTxService(chain.safe, foundry.id);
    servers = await Promise.all(
      SIGNER_SEEDS.map((seed, slot) =>
        serve(
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
          { port: 0 },
        ),
      ),
    );
  });

  after(async () => {
    await Promise.all(servers?.map((server) => server.close()) ?? []);
    await service?.stop();
    chain?.stop();
  });

  it("shows every signer's slot, and who has confirmed a pending transaction", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce: 1n }));
    assert.equal((await post(servers[2]!, "/api/confirm", hash)).status, 200);
    const { body } = await api(servers[0]!, "/api/status");
    const signers = body.signers as { slotId: number; isMe: boolean; index: number; staged: number; confirmedNonces: string[] }[];
    assert.deepEqual(signers.map((s) => s.slotId), [0, 1, 2]);
    assert.deepEqual(signers.map((s) => s.isMe), [true, false, false]);
    assert.deepEqual(signers.map((s) => s.confirmedNonces), [[], [], ["1"]]);
    assert.ok(signers.every((s) => s.index === 0 && s.staged === 5));
    service.drop(hash);
  });

  it("reports each signer's slot and current key", async () => {
    for (const [slot, server] of servers.entries()) {
      const { status, body } = await api(server, "/api/status");
      assert.equal(status, 200);
      const me = body.me as { slotId: number; index: number; address: string; staged: number };
      assert.equal(me.slotId, slot);
      assert.equal(me.index, 0);
      assert.equal(me.address, chain.trees[slot]!.addresses[0]);
      assert.equal(me.staged, 5);
    }
  });

  it("confirms with signer 1, executes with signer 2, and both rotate", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: parseEther("0.01"), data: "0x", operation: 0, nonce: 1n }));

    const [one, two] = servers as [SignerServer, SignerServer];
    let queue = (await api(one, "/api/queue")).body as { safeTxHash: string; verdict: { action: string }; actions: { summary: string }[] }[];
    assert.equal(queue[0]!.verdict.action, "confirm");
    assert.match(queue[0]!.actions[0]!.summary, /Send 0.01 ETH/);

    assert.equal((await post(two, "/api/execute", hash)).status, 409, "nobody may execute before threshold - 1 confirmations");
    assert.equal((await post(one, "/api/confirm", hash)).status, 200);

    queue = (await api(one, "/api/queue")).body as never;
    assert.equal(queue[0]!.verdict.action, "none", "signer 1 cannot also execute");
    queue = (await api(two, "/api/queue")).body as never;
    assert.equal(queue[0]!.verdict.action, "execute");

    const executed = await executeAndWait(two, hash);
    assert.equal(executed.status, "success", JSON.stringify(executed));
    const rotated = executed.rotated as { slotId: number }[];
    assert.deepEqual(rotated.map((r) => r.slotId).sort(), [0, 1]);
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), parseEther("0.01"));

    for (const [slot, expectedIndex] of [[0, 1], [1, 1], [2, 0]] as const) {
      const me = (await api(servers[slot]!, "/api/status")).body.me as { index: number; address: string };
      assert.equal(me.index, expectedIndex);
      assert.equal(me.address, chain.trees[slot]!.addresses[expectedIndex]);
    }
  });

  it("signs the next transaction with the rotated key, without anyone choosing an account", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce: 2n }));
    const [one, , three] = servers as [SignerServer, SignerServer, SignerServer];
    assert.equal((await post(three, "/api/confirm", hash)).status, 200);
    const executed = await executeAndWait(one, hash);
    assert.equal(executed.status, "success", JSON.stringify(executed));
    const me = (await api(one, "/api/status")).body.me as { index: number };
    assert.equal(me.index, 2);
  });

  it("refuses rule-breaking actions with reasons", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce: 4n }));
    const out = await post(servers[0]!, "/api/confirm", hash);
    assert.equal(out.status, 409);
    assert.match(String(out.body.error), /nonce 3 must execute first/);
    assert.equal((await post(servers[0]!, "/api/confirm", `0x${"00".repeat(32)}`)).status, 409);
    assert.equal((await post(servers[0]!, "/api/confirm", "0x1234")).status, 400);
  });

  it("reports an execution the RPC never includes as stuck, without sending it anywhere else", async () => {
    const blackHole = await startBlackHoleRpc(chain.rpc);
    const stuckSigner = await serve(
      new SignerSession({
        publicClient: chain.client,
        chain: foundry,
        executionRpcUrl: blackHole.url,
        txService: new TxService(foundry.id, { baseUrl: service.baseUrl }),
        source: seedSource(SIGNER_SEEDS[2]!),
        tree: chain.trees[2]!,
        safe: chain.safe,
        multiSendCallOnly: chain.multiSend,
        executionTimeoutMs: 1000,
      }),
      { port: 0 },
    );
    try {
      const nonce = BigInt((await api(servers[0]!, "/api/status")).body.nonce as string);
      const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: 1n, data: "0x", operation: 0, nonce }));
      assert.equal((await post(servers[1]!, "/api/confirm", hash)).status, 200);
      const sent = await post(stuckSigner, "/api/execute", hash);
      assert.equal(sent.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const { body } = await api(stuckSigner, `/api/executions/${hash}`);
      assert.equal(body.status, "stuck");
      assert.match(String(body.message), /only one can ever be mined/);
      assert.equal(blackHole.swallowed(), 1);
      assert.equal(BigInt((await api(servers[0]!, "/api/status")).body.nonce as string), nonce, "nothing reached the chain");
      service.drop(hash);
    } finally {
      await stuckSigner.close();
      await blackHole.stop();
    }
  });

  it("guards the local API", async () => {
    const server = servers[0]!;
    assert.equal((await api(server, "/api/status", {}, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await api(server, "/api/status", {}, { authorization: "" })).status, 401);
    assert.equal((await api(server, "/api/status", {}, { origin: "https://evil.example" })).status, 403);
    const rebinding = await new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port: server.port, path: "/api/status", headers: { host: "evil.example", authorization: `Bearer ${server.token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
    assert.equal(rebinding, 403, "a DNS-rebound request carries the attacker's Host header");
  });
});
