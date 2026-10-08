import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ProfileStore } from "./profiles.js";
import { createVault, operatorAddress, unlockVault } from "./vault.js";

const SEED_A = "test test test test test test test test test test test junk";
const SEED_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASSWORD = "correct horse battery";
const LEDGER = "0x00000000000000000000000000000000000Ce11E" as const;

describe("profiles", () => {
  const root = () => mkdtempSync(join(tmpdir(), "profiles-"));

  it("keeps several seeds and Ledgers apart, each in its own folder", () => {
    const store = new ProfileStore(root());
    const a = store.addSeed("Personal", SEED_A, PASSWORD);
    const b = store.addSeed("Treasury", SEED_B, "another password");
    const ledger = store.addLedger("Nano X", LEDGER);
    assert.deepEqual(store.list().map((p) => [p.name, p.kind]), [["Personal", "seed"], ["Treasury", "seed"], ["Nano X", "ledger"]]);
    assert.equal(a.operator, operatorAddress(SEED_A));
    assert.equal(unlockVault(join(store.dir(b.id), "vault.json"), "another password").split(" ")[0], "legal");
    assert.equal(existsSync(join(store.dir(ledger.id), "vault.json")), false, "a Ledger profile stores no secret");
  });

  it("refuses the same wallet twice, and blank names", () => {
    const store = new ProfileStore(root());
    store.addSeed("One", SEED_A, PASSWORD);
    assert.throws(() => store.addSeed("Again", SEED_A, PASSWORD), /already the profile "One"/);
    store.addLedger("Device", LEDGER);
    assert.throws(() => store.addLedger("Same device", LEDGER), /already the profile "Device"/);
    assert.throws(() => store.addSeed("  ", SEED_B, PASSWORD), /name/);
    assert.equal(store.list().length, 2, "failed adds leave nothing behind");
  });

  it("renames, remembers the last used, and removes a profile with its folder", () => {
    const store = new ProfileStore(root());
    const a = store.addSeed("Old name", SEED_A, PASSWORD);
    store.rename(a.id, "New name");
    store.setLastUsed(a.id);
    assert.equal(store.lastUsed()?.name, "New name");
    store.remove(a.id);
    assert.equal(existsSync(store.dir(a.id)), false);
    assert.equal(store.lastUsed(), undefined);
    assert.equal(store.list().length, 0);
  });

  it("moves a single-wallet install into a first profile", () => {
    const dir = root();
    createVault(join(dir, "vault.json"), SEED_A, PASSWORD);
    writeFileSync(join(dir, "settings.json"), "{}");
    mkdirSync(join(dir, "trees"));
    writeFileSync(join(dir, "trees", "x.json"), "{}");
    const store = new ProfileStore(dir);
    const migrated = store.migrateLegacy()!;
    assert.equal(migrated.operator, operatorAddress(SEED_A));
    assert.equal(store.lastUsed()?.id, migrated.id);
    for (const name of ["vault.json", "settings.json", join("trees", "x.json")]) assert.ok(existsSync(join(store.dir(migrated.id), name)), name);
    assert.equal(existsSync(join(dir, "vault.json")), false);
    assert.equal(store.migrateLegacy(), undefined, "runs once");
  });
});
