import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { DEPLOYMENTS, plainSafeTx, TxService } from "@rotating-msig/core";
import { seedSource } from "@rotating-msig/keys";

import { SignerSession } from "../src/session.js";
import { hasAnvil, hasArtifacts, SIGNER_SEEDS, startChain, startFakeTxService, type Chain, type FakeTxService } from "../test/fixture.js";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = createRequire(import.meta.url)("electron") as string;
const PASSWORD = "correct horse battery";
const RECIPIENT: Address = "0x000000000000000000000000000000000000bEEF";
const TIMEOUT = 60_000;

const skip = !hasAnvil ? "anvil not installed" : !hasArtifacts ? "run `forge build` first" : false;

describe("Cicada desktop app", { skip, timeout: 5 * TIMEOUT }, () => {
  let chain: Chain;
  let service: FakeTxService;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  /** Another signer of the same Safe, outside the app. */
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

  before(async () => {
    chain = await startChain(8560, { layout: "branch" });
    service = await startFakeTxService(chain.safe, foundry.id);
    // The app's keys start empty, so executing has to fund them from the gas account first.
    for (const address of chain.trees[0]!.addresses) await chain.client.request({ method: "anvil_setBalance" as never, params: [address, "0x0"] as never });
    userData = mkdtempSync(join(tmpdir(), "cicada-e2e-"));
    app = await electron.launch({
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
    page = await app.firstWindow();
    page.setDefaultTimeout(TIMEOUT);
  });

  after(async () => {
    await app?.close();
    await service?.stop();
    chain?.stop();
    if (userData) rmSync(userData, { recursive: true, force: true });
  });

  // Set E2E_SCREENSHOTS to a folder to keep a screenshot of the app after each test.
  afterEach(async (t) => {
    const dir = process.env.E2E_SCREENSHOTS;
    if (dir && page) await page.screenshot({ path: join(dir, `${t.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`) });
  });

  const nav = (label: string) => page.locator(".nav").getByRole("button", { name: label }).click();

  it("adds a seed profile and joins the Safe from its address alone", async () => {
    await page.getByRole("heading", { name: "Add a profile" }).waitFor();
    await page.getByLabel("Profile name").fill("Signer 1");
    await page.getByLabel(/Seed phrase/).fill(SIGNER_SEEDS[0]!);
    await page.getByLabel(/Safe address/).fill(chain.safe);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "Add profile" }).click();

    await page.getByRole("heading", { name: "Overview" }).waitFor();
    await page.getByText("2 of 3 signers · nonce 1").waitFor();
  });

  it("proposes a transfer that another signer executes, and moves to its next key", async () => {
    await nav("Transactions");
    await page.getByRole("button", { name: "New transaction" }).click();
    await page.getByLabel("Recipient").fill(RECIPIENT);
    await page.getByLabel(/Amount/).fill("0.01");
    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("button", { name: "Sign & propose" }).click();
    await page.getByText("1 pending").waitFor();

    const [pending] = await new TxService(foundry.id, { baseUrl: service.baseUrl }).pending(chain.safe, 1n);
    assert.ok(pending, "the proposal reached the Transaction Service");
    const other = signer(1);
    const sent = await other.execute(pending.safeTxHash as `0x${string}`);
    await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! });
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), parseEther("0.01"));

    await nav("Overview");
    await page.getByText("2 of 3 signers · nonce 2").waitFor();
  });

  it("executes a transaction another signer confirmed, showing each step until the gas is returned", async () => {
    const hash = service.propose(plainSafeTx({ to: RECIPIENT, value: parseEther("0.02"), data: "0x", operation: 0, nonce: 2n }));
    await signer(2).confirm(hash);

    await nav("Transactions");
    await page.getByRole("button", { name: "Execute" }).click();
    await page.getByRole("button", { name: "Execute" }).click();

    const card = page.locator(".tx.finished");
    await card.getByText("Executed").waitFor();
    const steps = card.locator(".execution-steps.ok");
    for (const label of ["Simulated", "Gas for your key", "Included in a block", "Signers rotated", "Unused gas returned"]) {
      await steps.locator(".step.done", { hasText: label }).waitFor();
    }
    assert.equal(await chain.client.getBalance({ address: RECIPIENT }), parseEther("0.03"));
    await card.getByRole("button", { name: "Dismiss" }).click();
    await page.getByText("No pending transactions").waitFor();
  });

  it("removes the profile and its files from this computer", async () => {
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await page.getByRole("button", { name: "Use another profile" }).click();
    await page.getByRole("heading", { name: "Choose a profile" }).waitFor();
    await page.getByRole("button", { name: "Remove Signer 1" }).click();
    await page.getByPlaceholder("Signer 1").fill("Signer 1");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("heading", { name: "Add a profile" }).waitFor();
    assert.deepEqual(readdirSync(join(userData, "profiles")), [], "the seed vault, settings and key lists are gone");
  });
});
