// Local demo: a guarded 2-of-3 Safe on anvil, an in-memory Transaction Service with one pending transfer, and one
// rotation signer per signer seed, each serving the UI. Public test seeds only.
//   npm run build -w signer && npx tsx --conditions=source signer/scripts/local-demo.ts
import { fileURLToPath } from "node:url";
import { parseEther } from "viem";
import { foundry } from "viem/chains";

import { plainSafeTx, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { serve } from "../src/server.js";
import { SignerSession } from "../src/session.js";
import { SIGNER_SEEDS, startChain, startFakeTxService } from "../test/fixture.js";

const chain = await startChain(8549);
const service = await startFakeTxService(chain.safe, foundry.id);
service.propose(plainSafeTx({ to: "0x000000000000000000000000000000000000bEEF", value: parseEther("0.01"), data: "0x", operation: 0, nonce: 1n }));
const uiDir = fileURLToPath(new URL("../ui/dist/", import.meta.url));

const servers = await Promise.all(
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
      { port: 7373 + slot, uiDir },
    ),
  ),
);

console.log(`Safe ${chain.safe} on anvil ${chain.rpc}; one pending transfer (nonce 1).`);
servers.forEach((server, slot) => console.log(`signer ${slot + 1} (slot ${slot}): ${server.url}`));
console.log("Ctrl+C to stop.");
process.once("SIGINT", async () => {
  await Promise.all(servers.map((server) => server.close()));
  await service.stop();
  chain.stop();
  process.exit(0);
});
