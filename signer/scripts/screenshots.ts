/**
 * Captures the screenshots used in the README from the real desktop app against a local chain:
 * `npm run screenshots -w @rotating-msig/signer [-- outDir]` (defaults to `../screenshots`). Needs anvil and `forge build`.
 * With `SCREENSHOT_PAUSE=<dir>` it stops at each state until `<dir>/next` exists, for screenshots taken by hand.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { DEPLOYMENTS, plainSafeTx, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession } from "../src/session.js";
import { SIGNER_SEEDS, startChain, startFakeTxService } from "../test/fixture.js";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = createRequire(import.meta.url)("electron") as string;
const RECIPIENT: Address = "0x000000000000000000000000000000000000bEEF";
const out = process.argv[2] ?? join(APP_DIR, "..", "screenshots");
mkdirSync(out, { recursive: true });

const chain = await startChain(8561, { layout: "branch" });
const service = await startFakeTxService(chain.safe, foundry.id);
for (const address of chain.trees[0]!.addresses) await chain.client.request({ method: "anvil_setBalance" as never, params: [address, "0x0"] as never });
const signer = (slot: number) =>
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

const userData = mkdtempSync(join(tmpdir(), "cicada-shots-"));
const app = await electron.launch({
  executablePath: ELECTRON,
  args: [APP_DIR],
  env: {
    ...process.env,
    ROTATION_SIGNER_USER_DATA: userData,
    ROTATION_SIGNER_TEST_CHAIN: JSON.stringify({
      chainId: foundry.id,
      rpc: chain.rpc,
      txServiceUrl: service.baseUrl,
      deployments: {
        safeSingleton: chain.singleton,
        safeProxyFactory: chain.factory,
        multiSendCallOnly: chain.multiSend,
        creationSingleton: chain.singleton,
        fallbackHandler: DEPLOYMENTS[1]!.fallbackHandler,
        rotationGuard: chain.guard,
        rotationGuardBlock: 0,
      },
    }),
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(60_000);
await app.evaluate(({ BrowserWindow }) => {
  const [window] = BrowserWindow.getAllWindows();
  window!.setSize(1180, 760);
  window!.center();
  window!.show();
  window!.focus();
});
// SCREENSHOT_PAUSE=<dir>: instead of capturing, stop at each state until `<dir>/next` appears (for screenshots taken by hand).
const pauseDir = process.env.SCREENSHOT_PAUSE;
const shot = async (name: string) => {
  await page.waitForTimeout(300);
  if (!pauseDir) return page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`ready: ${name}`);
  const flag = join(pauseDir, "next");
  while (!existsSync(flag)) await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(flag);
};
const nav = (label: string) => page.locator(".nav").getByRole("button", { name: label }).click();

await page.getByRole("button", { name: "Get started" }).waitFor();
await shot("welcome");
await page.getByRole("button", { name: "Get started" }).click();
await page.getByLabel("Profile name").fill("Alice");
await page.getByLabel(/Seed phrase/).fill(SIGNER_SEEDS[0]!);
await page.getByLabel(/Safe address/).fill(chain.safe);
await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
await page.getByLabel("Confirm").fill("correct horse battery");
await page.getByRole("button", { name: "Add profile" }).click();
await page.getByText("2 of 3 signers · nonce 1").waitFor();
await shot("overview");

// Another signer proposes and confirms, so this signer is the one who executes.
const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: parseEther("0.25"), data: "0x", operation: 0, nonce: 1n }));
await signer(2).confirm(hash);
await nav("Transactions");
await page.getByRole("button", { name: "Execute" }).waitFor();
await page.waitForTimeout(500);
await shot("transactions");
await page.getByRole("button", { name: "Execute" }).click();
await page.getByRole("button", { name: "Execute" }).click();
const card = page.locator(".tx.finished");
await card.getByText("Executed").waitFor();
await card.locator(".execution-steps.ok .step.done", { hasText: "Unused gas returned" }).waitFor();
await page.waitForTimeout(500);
await shot("executed");

await nav("Signers");
await page.getByText("3 slots · 2 needed to execute").waitFor();
await page.waitForTimeout(1500);
await shot("signers");

await app.close();
await service.stop();
chain.stop();
rmSync(userData, { recursive: true, force: true });
console.log(`Screenshots written to ${out}`);
