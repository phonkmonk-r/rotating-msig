import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createVault, readVault, unlockVault } from "./vault.js";

const SEED = "test test test test test test test test test test test junk";
const PASSWORD = "correct horse battery";
const fresh = () => join(mkdtempSync(join(tmpdir(), "rotation-vault-")), "vault.json");

describe("vault", () => {
  it("encrypts the seed and unlocks with the password", () => {
    const path = fresh();
    const vault = createVault(path, `  ${SEED.toUpperCase()}\n`, PASSWORD);
    assert.equal(vault.operator, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, "utf8"), /test test|junk/);
    assert.equal(unlockVault(path, PASSWORD), SEED);
  });

  it("rejects a wrong password and a modified file", () => {
    const path = fresh();
    createVault(path, SEED, PASSWORD);
    assert.throws(() => unlockVault(path, "wrong password!!"), /wrong password/);
    const vault = readVault(path)!;
    const data = Buffer.from(vault.cipher.data, "base64");
    data[0] = data[0]! ^ 1;
    writeFileSync(path, JSON.stringify({ ...vault, cipher: { ...vault.cipher, data: data.toString("base64") } }));
    assert.throws(() => unlockVault(path, PASSWORD), /wrong password/);
  });

  it("refuses invalid seeds, short passwords and overwriting", () => {
    assert.throws(() => createVault(fresh(), "test test test", PASSWORD), /not a valid seed phrase/);
    assert.throws(() => createVault(fresh(), SEED, "short"), /at least 10 characters/);
    const path = fresh();
    createVault(path, SEED, PASSWORD);
    assert.throws(() => createVault(path, SEED, PASSWORD), /already exists/);
  });
});
