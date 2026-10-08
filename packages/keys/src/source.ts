import type { Address, LocalAccount } from "viem";

/** Ledger Live style path: hardened per account, so one account's xpub never reveals another account's keys. */
export const PATH_TEMPLATE = "m/44'/60'/{account}'/0/0";

/** The seed's standard first account (`m/44'/60'/0'/0/0`): the signer's operator account, which pays for gas. */
export const OPERATOR_ACCOUNT = 0;

export function derivationPath(account: number): string {
  return PATH_TEMPLATE.replace("{account}", String(account));
}

/**
 * Produces owner addresses and signing accounts at BIP-32 account indexes. Implementations must never expose public
 * keys or xpubs, and keep private keys inside the process (seed) or the device (Ledger).
 */
export interface AddressSource {
  readonly kind: "seed" | "ledger";
  address(account: number): Promise<Address>;
  /** A viem account that signs as the owner at this account index. */
  signer(account: number): Promise<LocalAccount>;
  close(): Promise<void>;
}
