import type { Address, LocalAccount } from "viem";

/** The ranged layout's path (earlier trees); also the shape of the operator account. */
export const PATH_TEMPLATE = "m/44'/60'/{account}'/0/0";

/** The seed's standard first account (`m/44'/60'/0'/0/0`): the signer's operator account, which pays for gas. */
export const OPERATOR_ACCOUNT = 0;

/**
 * `m/44'/60'/{account}'/0/{index}`, or `m/44'/60'/{account}'/{branch}'/{index}` with a hardened branch (two-level
 * per-Safe trees). Index 0 for the operator and ranged trees.
 */
export function derivationPath(account: number, index = 0, branch?: number): string {
  return `m/44'/60'/${account}'/${branch === undefined ? "0" : `${branch}'`}/${index}`;
}

/**
 * Produces owner addresses and signing accounts at BIP-32 account indexes. Implementations must never expose public
 * keys or xpubs, and keep private keys inside the process (seed) or the device (Ledger).
 */
export interface AddressSource {
  readonly kind: "seed" | "ledger";
  address(account: number, index?: number, branch?: number): Promise<Address>;
  /** A viem account that signs as the owner at this account (and branch and index under it). */
  signer(account: number, index?: number, branch?: number): Promise<LocalAccount>;
  close(): Promise<void>;
}
