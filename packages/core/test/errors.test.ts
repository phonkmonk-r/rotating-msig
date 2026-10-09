import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BaseError, encodeErrorResult, parseAbi } from "viem";

import { rotationGuardAbi } from "../src/abi/rotationGuard.js";
import { describeRevert } from "../src/errors.js";

const revert = (data: `0x${string}`) => new BaseError("execution reverted", { cause: Object.assign(new Error("reverted"), { data }) });

describe("describeRevert", () => {
  it("names a guard error with its arguments", () => {
    const data = encodeErrorResult({ abi: rotationGuardAbi, errorName: "BufferEmpty", args: [1n] });
    assert.equal(describeRevert(revert(data)), "BufferEmpty(1)");
  });

  it("explains Safe's GSxxx codes, which revert as Error(string)", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["GS011"] });
    assert.match(describeRevert(revert(data))!, /^GS011: the Safe has too little ETH left to refund/);
  });

  it("passes through a reason it does not know", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["slippage too high"] });
    assert.equal(describeRevert(revert(data)), "slippage too high");
  });
});
