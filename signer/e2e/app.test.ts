import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { parseEther, type Address } from "viem";
import { foundry } from "viem/chains";

import { DEPLOYMENTS, plainSafeTx, readSafeState, TxService } from "@rotating-msig/core";
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
  let dapp: Server;
  let dappUrl: string;

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
    dapp?.close();
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
    await page.getByRole("heading", { name: "Cicada" }).waitFor();
    await page.getByRole("button", { name: "Get started" }).click();
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

  it("gives dApps a wallet they can extend, as MetaMask-era code expects", async () => {
    // Uniswap sets a legacy MetaMask field on window.ethereum at startup; a frozen provider made that throw and
    // the whole app render blank. This page does the same before asking for a transaction.
    dapp = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/opener") {
        res.end(`<!doctype html><title>Opener</title><body><script>window.open("/popup", "_blank");</script></body>`);
        return;
      }
      if (req.url === "/plain") {
        res.end(`<!doctype html><title>Plain page</title><body>A page worth saving.</body>`);
        return;
      }
      if (req.url === "/popup") {
        res.end(`<!doctype html><title>Popup</title><body><script>
          document.title = "Popup " + (window.opener ? "with opener" : "without opener") + " " + typeof window.ethereum;
        </script></body>`);
        return;
      }
      res.end(`<!doctype html><title>Legacy dApp</title><body><script>
        "use strict"; // like a bundled dApp: writing to a frozen object throws instead of failing silently
        window.ethereum.autoRefreshOnNetworkChange = false;
        window.ethereum.request({ method: "eth_requestAccounts" })
          .then(([from]) => window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: "${RECIPIENT}", value: "0x1" }] }))
          .catch((error) => { document.body.textContent = "refused " + error.code; });
      </script></body>`);
    });
    await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", resolve));
    dappUrl = `http://127.0.0.1:${(dapp.address() as { port: number }).port}/`;

    await nav("Browse dApps");
    const address = page.getByPlaceholder(/Enter a dApp address/);
    await address.fill(dappUrl);
    await address.press("Enter");
    await page.getByRole("heading", { name: "Wants the Safe to" }).waitFor();
    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByRole("heading", { name: "Wants the Safe to" }).waitFor({ state: "detached" });
  });

  it("opens a page's popup as a tab that keeps its opener and the wallet, and opens and closes tabs", async () => {
    const address = page.getByPlaceholder(/Enter a dApp address/);
    await address.fill(`${dappUrl}opener`);
    await address.press("Enter");
    const popup = page.getByRole("tab", { name: "Popup with opener object" });
    await popup.waitFor();
    assert.equal(await popup.getAttribute("aria-selected"), "true", "the popup's tab is selected");
    assert.equal(await page.getByRole("tab").count(), 2);

    await page.getByRole("button", { name: "Close Popup with opener object" }).click();
    await popup.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("tab", { name: "Opener" }).getAttribute("aria-selected"), "true");

    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByRole("tab", { name: "New tab" }).waitFor();
    await page.getByRole("heading", { name: "Use any dApp with your Safe" }).waitFor();
    assert.equal(await page.getByRole("tab").count(), 2);
  });

  it("saves a page for quick access from the sidebar, opens it in a new tab, and removes it", async () => {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    const address = page.getByPlaceholder(/Enter a dApp address/);
    await address.fill(`${dappUrl}plain`);
    await address.press("Enter");
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: "Plain page" }).waitFor();
    await page.getByRole("button", { name: "Save this page" }).click();
    await page.getByRole("button", { name: "Remove from saved pages" }).waitFor();

    const tabs = await page.getByRole("tab").count();
    await page.getByRole("button", { name: "Saved pages", exact: true }).click();
    const saved = page.getByRole("list", { name: "Saved pages" });
    await saved.getByRole("button", { name: "Plain page", exact: true }).click();
    await page.waitForFunction((count) => document.querySelectorAll('[role="tab"]').length === count, tabs + 1);
    const opened = page.getByRole("tab").last();
    await page.waitForFunction(() => {
      const all = document.querySelectorAll('[role="tab"]');
      const last = all[all.length - 1];
      return last?.getAttribute("aria-selected") === "true" && last.textContent?.includes("Plain page");
    });
    assert.equal(await opened.getAttribute("aria-selected"), "true", "the saved page opens in a new, selected tab");

    await saved.getByRole("button", { name: "Remove Plain page" }).click();
    await page.getByText("Save a page with the star").waitFor();
    assert.equal(await page.getByRole("button", { name: "Save this page" }).getAttribute("aria-pressed"), "false");
  });

  it("as the only signer, executes at once from a Safe that holds no ETH, and rotates its key", async () => {
    // Two outside signers lower the threshold to 1, which leaves the app's user as a sole signer.
    const lower = await signer(1).propose({ kind: "threshold", threshold: 1 });
    const sent = await signer(2).execute(lower.safeTxHash);
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: sent.transactionHash! })).status, "success");
    // An empty Safe: Safe's gas refund must still be covered (on Sepolia it was not, and every execution reverted).
    await chain.client.request({ method: "anvil_setBalance" as never, params: [chain.safe, "0x0"] as never });
    const before = await readSafeState(chain.client, chain.safe);

    await nav("Overview");
    await page.getByText(`1 of 3 signers · nonce ${before.nonce}`).waitFor();
    await nav("Transactions");
    await page.getByRole("button", { name: "New transaction" }).click();
    const composer = page.locator(".composer");
    // An empty Safe cannot send ETH; rotating another signer's slot is a transaction it can make (the same kind as a
    // recovery), and it moves slot 1 as well as the executor.
    await composer.getByRole("button", { name: "Rotate signer" }).click();
    await composer.getByRole("checkbox").nth(1).check();
    await composer.getByRole("button", { name: "Review" }).click();
    await composer.getByRole("button", { name: "Execute", exact: true }).click();

    const card = page.locator(".tx.finished");
    await card.getByText("Executed").waitFor();
    const steps = card.locator(".execution-steps.ok");
    for (const label of ["Simulated", "Gas for your key", "Included in a block", "Signers rotated", "Unused gas returned"]) {
      await steps.locator(".step.done", { hasText: label }).waitFor();
    }
    const after = await readSafeState(chain.client, chain.safe);
    assert.equal(after.nonce, before.nonce + 1n);
    assert.notEqual(after.slots[0]!.owner, before.slots[0]!.owner, "the app's key rotated");
    assert.notEqual(after.slots[1]!.owner, before.slots[1]!.owner, "the chosen slot rotated");
    assert.equal(after.slots[2]!.owner, before.slots[2]!.owner, "nobody else did");
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
