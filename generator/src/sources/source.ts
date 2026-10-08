import type { Address } from "viem";

/** Ledger Live style path: hardened per account, so one account's xpub never reveals another account's keys. */
export const PATH_TEMPLATE = "m/44'/60'/{account}'/0/0";

export function derivationPath(account: number): string {
  return PATH_TEMPLATE.replace("{account}", String(account));
}

/** Produces the owner address at a BIP-32 account index. Implementations must never expose public keys or xpubs. */
export interface AddressSource {
  readonly kind: "seed" | "ledger";
  address(account: number): Promise<Address>;
  close(): Promise<void>;
}
