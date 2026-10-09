import { concatHex, encodeFunctionData, hashTypedData, pad, size, type Address, type Hex } from "viem";

import { safeAbi } from "./abi/safe.js";
import { ZERO_ADDRESS } from "./addresses.js";

/** A Safe transaction, as signed by owners (Safe's `SafeTx` EIP-712 struct). */
export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Typed data for signing a SafeTx with EIP-712 (Safe 1.5.0 domain: chainId and verifyingContract). */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: tx,
  };
}

/** The safeTxHash, computed locally. Never trust a hash supplied by the Transaction Service: recompute it. */
export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** An owner's 65-byte signature over a safeTxHash. */
export interface OwnerSignature {
  owner: Address;
  data: Hex;
}

/** Signature for the executor itself: Safe accepts it because `msg.sender` is that owner (v = 1). */
export function preValidatedSignature(owner: Address): OwnerSignature {
  return { owner, data: concatHex([pad(owner, { size: 32 }), pad("0x", { size: 32 }), "0x01"]).toLowerCase() as Hex };
}

/** Concatenates signatures sorted by owner address, as Safe's `checkNSignatures` requires. */
export function packSignatures(signatures: readonly OwnerSignature[]): Hex {
  for (const signature of signatures) {
    if (size(signature.data) !== 65) throw new Error(`signature for ${signature.owner} is not 65 bytes`);
  }
  const sorted = [...signatures].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  return concatHex(sorted.map((signature) => signature.data));
}

export function execTransactionData(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures],
  });
}

/**
 * `safeTxGas` when no simulation is available. The guard rejects `safeTxGas == 0 && gasPrice == 0`: Safe would then
 * revert the whole transaction on a failing inner call, undoing the rotation while the signatures stay public.
 * The executor pays only for gas actually used, so a generous value costs nothing beyond a higher gas limit.
 */
export const DEFAULT_SAFE_TX_GAS = 1_000_000n;
/** Floor for an estimated `safeTxGas`, covering estimate drift between proposal and execution. */
export const MIN_SAFE_TX_GAS = 100_000n;

/** `safeTxGas` for an inner call that used `gasUsed` in simulation: half again as much, at least the floor. */
export function estimatedSafeTxGas(gasUsed: bigint): bigint {
  const withMargin = (gasUsed * 3n) / 2n;
  return withMargin > MIN_SAFE_TX_GAS ? withMargin : MIN_SAFE_TX_GAS;
}

/** A Safe transaction with no refund fields. `safeTxGas` is non-zero unless the caller says otherwise. */
export function plainSafeTx(fields: Pick<SafeTx, "to" | "value" | "data" | "operation" | "nonce">, safeTxGas: bigint = DEFAULT_SAFE_TX_GAS): SafeTx {
  return { ...fields, safeTxGas, baseGas: 0n, gasPrice: 0n, gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS };
}
