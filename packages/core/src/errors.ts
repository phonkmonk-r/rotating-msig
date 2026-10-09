import { BaseError, decodeErrorResult, type Hex } from "viem";

import { rotationGuardAbi } from "./abi/rotationGuard.js";

/** Safe's own revert codes ("GS0xx") that the app is likely to hit, with a plain description. */
const SAFE_ERRORS: Record<string, string> = {
  GS010: "not enough gas for safeTxGas: raise the gas limit",
  GS011: "the Safe has too little ETH left to refund the executor's gas (a few hundred thousand wei); keep a little ETH in the Safe",
  GS013: "Safe transaction failed (inner call reverted with safeTxGas and gasPrice both 0)",
  GS020: "signatures too short for the threshold",
  GS025: "pre-validated signature from someone other than the executor without approveHash",
  GS026: "invalid owner signature, or signatures not sorted by owner",
};

/**
 * Names the revert behind a failed call: a RotationGuard custom error such as `BufferEmpty(1)`, or a Safe `GSxxx` code.
 * Returns undefined when the error carries no recognizable revert data.
 */
export function describeRevert(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  let data: Hex | undefined;
  let reason: string | undefined;
  error.walk((cause) => {
    const candidate = cause as { data?: unknown; raw?: unknown; reason?: unknown };
    if (!data && typeof candidate.raw === "string" && candidate.raw.startsWith("0x")) data = candidate.raw as Hex;
    if (!data && typeof candidate.data === "string" && candidate.data.startsWith("0x")) data = candidate.data as Hex;
    if (!reason && typeof candidate.reason === "string") reason = candidate.reason;
    return false;
  });
  if (data && data.length >= 10) {
    try {
      const decoded: { errorName: string; args?: readonly unknown[] } = decodeErrorResult({ abi: rotationGuardAbi, data });
      // Solidity's built-in Error(string) decodes too; Safe reverts with its GSxxx codes that way.
      if (decoded.errorName === "Error") reason = String(decoded.args?.[0] ?? "");
      else return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } catch {
      // Not a guard error; fall through to Safe reason strings.
    }
  }
  if (reason && SAFE_ERRORS[reason]) return `${reason}: ${SAFE_ERRORS[reason]}`;
  return reason;
}
