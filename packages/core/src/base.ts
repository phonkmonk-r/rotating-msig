import { encodeAbiParameters, getAddress, keccak256, type Address } from "viem";

/** First account index any Safe's range may start at; everyday wallet accounts live far below it. */
export const MIN_TREE_BASE = 100_000;
const BASE_SPAN = 1_000_000_000n;

/** Default number of addresses per signer tree. */
export const DEFAULT_TREE_SIZE = 10_000;

/** Keeps a per-Safe account below the top of the hardened space, so validators that add the tree size never overflow. */
const SAFE_ACCOUNT_SPAN = BigInt(2 ** 31 - 2 ** 20 - MIN_TREE_BASE);

/**
 * The hardened account a signer's keys for a given Safe live under (per-Safe layout, `m/44'/60'/{account}'/0/{i}`).
 * Derived from the chain and the Safe address, so the app finds the keys again from the Safe alone, and two Safes
 * share an account with probability about 1 in 2 billion.
 */
export function safeAccount(chainId: number, safe: Address): number {
  const hash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "string" }], [BigInt(chainId), getAddress(safe), "keyturn/per-safe"]));
  return MIN_TREE_BASE + Number(BigInt(hash) % SAFE_ACCOUNT_SPAN);
}

/**
 * Ranged layout (earlier trees): the account index a signer's tree starts at for a given Safe, derived from the chain and the Safe address. Each
 * Safe gets its own range, so one seed never reuses a key across Safes, and the app can always find a signer's keys
 * again from the Safe address alone. Ranges of 10,000 inside a billion-wide span overlap with negligible probability.
 */
export function defaultBase(chainId: number, safe: Address): number {
  const hash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [BigInt(chainId), getAddress(safe)]));
  return MIN_TREE_BASE + Number(BigInt(hash) % BASE_SPAN);
}
