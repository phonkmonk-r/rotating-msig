import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { eth, explorer, short, signedAmount, UNLIMITED_APPROVAL } from "../src/format.js";
import { isSaved, tabLabel } from "../src/lib/browser.js";
import { executionInFlight, executionTone, nextStep, requestValue, sendingLabel, sendingNote, sendLabel } from "../src/lib/execution.js";
import { checkedWordCount, checkedWordsMatch, newSeedPhrase, pickCheckedWords, positionsLabel } from "../src/lib/newSeed.js";
import { profileFormProblems, seedWordCount, type ProfileForm } from "../src/lib/profileForm.js";
import { packagePreview } from "../src/lib/slotPackage.js";

const SAFE = "0x7aC0e2C1b0bD1a5E2a8E1A0F0b8E3c3E6c1BEd02";
const TWELVE = "abandon ".repeat(11) + "about";

describe("format", () => {
  it("shortens addresses", () => {
    assert.equal(short(SAFE), "0x7aC0…Ed02");
  });

  it("shows ETH with at most the given digits", () => {
    assert.match(eth("1500000000000000000"), /^1\.5 ETH$/);
    assert.match(eth("123456789000000000", 2), /^0\.12 ETH$/);
    assert.match(eth("0"), /^0 ETH$/);
  });

  it("links to the chain's explorer, or nowhere on unknown chains", () => {
    assert.equal(explorer(11155111, "tx", "0xabc"), "https://sepolia.etherscan.io/tx/0xabc");
    assert.equal(explorer(1, "address", SAFE), `https://etherscan.io/address/${SAFE}`);
    assert.equal(explorer(31337, "tx", "0xabc"), undefined);
  });

  it("signs balance changes", () => {
    assert.equal(signedAmount("-100000000000000000000", 18, "MOCK"), "−100 MOCK");
    assert.equal(signedAmount("500000", 6, "USDC"), "+0.5 USDC");
    assert.equal(signedAmount("0", 18, "ETH"), "+0 ETH");
  });

  it("treats a max approval as unlimited", () => {
    assert.ok(2n ** 256n - 1n >= UNLIMITED_APPROVAL);
    assert.ok(10n ** 30n < UNLIMITED_APPROVAL);
  });
});

describe("profile form", () => {
  const seed: ProfileForm = { kind: "seed", name: "Main", mnemonic: TWELVE, safe: "", password: "correct horse", confirm: "correct horse" };

  it("counts seed words however they are spaced", () => {
    assert.equal(seedWordCount(""), 0);
    assert.equal(seedWordCount("   "), 0);
    assert.equal(seedWordCount(`  ${TWELVE.replace(/ /g, " \n\t ")}  `), 12);
  });

  it("accepts a complete seed profile, with or without a Safe", () => {
    assert.deepEqual(profileFormProblems(seed), []);
    assert.deepEqual(profileFormProblems({ ...seed, safe: ` ${SAFE} ` }), []);
  });

  it("names each problem", () => {
    assert.deepEqual(profileFormProblems({ ...seed, name: " " }), ["name"]);
    assert.deepEqual(profileFormProblems({ ...seed, safe: "0x1234" }), ["safe"]);
    assert.deepEqual(profileFormProblems({ ...seed, mnemonic: `${TWELVE} extra` }), ["seed"]);
    assert.deepEqual(profileFormProblems({ ...seed, mnemonic: `${TWELVE} ${TWELVE}` }), [], "24 words are fine");
    assert.deepEqual(profileFormProblems({ ...seed, mnemonic: `${TWELVE} abandon abandon abandon abandon abandon about` }), [], "and every BIP-39 length between");
    assert.deepEqual(profileFormProblems({ ...seed, mnemonic: `${TWELVE} about` }), ["seed"]);
    assert.deepEqual(profileFormProblems({ ...seed, password: "short", confirm: "short" }), ["password"]);
    assert.deepEqual(profileFormProblems({ ...seed, confirm: "correct horsE" }), ["confirm"]);
  });

  it("asks a Ledger profile only for its name and Safe", () => {
    const ledger: ProfileForm = { kind: "ledger", name: "Ledger", mnemonic: "", safe: "", password: "", confirm: "" };
    assert.deepEqual(profileFormProblems(ledger), []);
    assert.deepEqual(profileFormProblems({ ...ledger, safe: "nope" }), ["safe"]);
  });
});

describe("new seed", () => {
  it("creates a valid 12-word phrase, different each time", () => {
    const phrase = newSeedPhrase();
    assert.ok(validateMnemonic(phrase, wordlist));
    assert.equal(phrase.split(" ").length, 12);
    assert.notEqual(newSeedPhrase(), phrase);
  });

  it("creates 18 and 24-word phrases too, and checks more of their words", () => {
    for (const length of [18, 24] as const) {
      const phrase = newSeedPhrase(length);
      assert.ok(validateMnemonic(phrase, wordlist));
      assert.equal(phrase.split(" ").length, length);
    }
    assert.deepEqual([12, 18, 24].map(checkedWordCount), [3, 4, 5]);
    assert.equal(pickCheckedWords(24).length, 5);
    assert.equal(pickCheckedWords(18).length, 4);
  });

  it("asks for distinct positions in order", () => {
    for (let run = 0; run < 50; run++) {
      const picked = pickCheckedWords(12);
      assert.equal(new Set(picked).size, 3);
      assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
      assert.ok(picked.every((i) => i >= 0 && i < 12));
    }
    assert.deepEqual(pickCheckedWords(12, 3, () => 0), [0, 1, 2]);
    assert.deepEqual(pickCheckedWords(2, 3), [0, 1]);
  });

  it("checks the answers ignoring case and spaces", () => {
    assert.ok(checkedWordsMatch(TWELVE, [0, 11], { 0: " Abandon ", 11: "about" }));
    assert.ok(!checkedWordsMatch(TWELVE, [0, 11], { 0: "abandon", 11: "abandon" }));
    assert.ok(!checkedWordsMatch(TWELVE, [0, 11], { 0: "abandon" }));
  });

  it("names the positions the way people count", () => {
    assert.equal(positionsLabel([2]), "#3");
    assert.equal(positionsLabel([1, 4, 8]), "#2, #5 and #9");
  });
});

describe("slot package preview", () => {
  const encode = (value: unknown) => `rotation-slot:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

  it("reads the signer and slot a package claims", () => {
    assert.deepEqual(packagePreview(`  ${encode({ operator: SAFE, slotId: 3, entries: [] })}\n`), { operator: SAFE, slotId: 3 });
  });

  it("ignores anything else", () => {
    assert.equal(packagePreview(""), undefined);
    assert.equal(packagePreview("rotation-invite:abc"), undefined);
    assert.equal(packagePreview("rotation-slot:!!!"), undefined);
    assert.equal(packagePreview(encode({ operator: SAFE })), undefined);
    assert.equal(packagePreview(encode({ operator: SAFE, slotId: "3" })), undefined);
  });
});

describe("executions", () => {
  it("follows an execution until it is final and its gas is returned", () => {
    for (const status of ["preparing", "pending", "stuck"] as const) assert.ok(executionInFlight({ status }));
    for (const status of ["success", "reverted", "failed"] as const) assert.ok(!executionInFlight({ status }));
    assert.ok(executionInFlight({ status: "success", sweep: { status: "waiting" } }));
    assert.ok(!executionInFlight({ status: "success", sweep: { status: "sent" } }));
  });

  it("colours the checklist by outcome", () => {
    assert.equal(executionTone("success"), "ok");
    assert.equal(executionTone("reverted"), "critical");
    assert.equal(executionTone("failed"), "critical");
    assert.equal(executionTone("stuck"), "warning");
    assert.equal(executionTone("pending"), "pending");
    assert.equal(executionTone("preparing"), "pending");
  });

  it("adds up the ETH a dApp request sends, in hex or decimal", () => {
    assert.equal(requestValue([]), 0n);
    assert.equal(requestValue([{ to: SAFE, value: "0xde0b6b3a7640000" }, { to: SAFE, value: "5" }, { to: SAFE, value: "0x" }, { to: SAFE }]), 10n ** 18n + 5n);
  });
});

describe("the only signer", () => {
  it("executes at once where others propose", () => {
    assert.equal(sendLabel(false), "Sign & propose");
    assert.equal(sendLabel(true), "Execute");
    assert.match(nextStep(false), /Another signer executes it/);
    assert.match(nextStep(true), /only signer, so it is executing now/);
    assert.equal(sendingLabel(true), "Simulating…", "nothing is signed before the simulation passes");
    assert.equal(sendingLabel(false), "Signing…");
    assert.match(sendingNote(true), /^Simulating the transaction, then sending/);
    assert.match(sendingNote(false), /^Simulating the transaction, then signing/);
  });
});

describe("browser tabs", () => {
  it("names a tab by its title, else its host, else as a new tab", () => {
    assert.equal(tabLabel({ title: "Uniswap Interface", url: "https://app.uniswap.org/" }), "Uniswap Interface");
    assert.equal(tabLabel({ title: "", url: "https://app.uniswap.org/swap" }), "app.uniswap.org");
    assert.equal(tabLabel({ title: "https://curve.finance/", url: "https://curve.finance/" }), "curve.finance", "a title that is just the URL");
    assert.equal(tabLabel({ title: "", url: "" }), "New tab");
    assert.equal(tabLabel({ title: "", url: "about:blank" }), "New tab");
  });
});

describe("saved pages", () => {
  it("knows whether the open page is saved", () => {
    const saved = [{ url: "https://app.uniswap.org/", title: "Uniswap" }];
    assert.equal(isSaved(saved, "https://app.uniswap.org/"), true);
    assert.equal(isSaved(saved, "https://app.aave.com/"), false);
    assert.equal(isSaved(saved, ""), false, "an empty tab is never saved");
  });
});
