import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { multiSendCallOnlyAbi } from "../src/abi/multiSendCallOnly.js";
import { rotationGuardAbi } from "../src/abi/rotationGuard.js";
import { safeAbi } from "../src/abi/safe.js";

const OUT = new URL("../../../out/", import.meta.url);

describe("generated ABIs", { skip: existsSync(OUT) ? false : "run `forge build` first" }, () => {
  for (const [artifact, abi] of [
    ["RotationGuard.sol/RotationGuard.json", rotationGuardAbi],
    ["Safe.sol/Safe.json", safeAbi],
    ["MultiSendCallOnly.sol/MultiSendCallOnly.json", multiSendCallOnlyAbi],
  ] as const) {
    it(`${artifact} is current (regenerate with \`npm run abi\`)`, () => {
      assert.deepEqual(abi, JSON.parse(readFileSync(new URL(artifact, OUT), "utf8")).abi);
    });
  }
});
