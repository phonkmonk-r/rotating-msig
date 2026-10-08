import { getAddress, type Address } from "viem";

import { derivationPath, type AddressSource } from "./source.js";

/** The subset of `@ledgerhq/hw-app-eth` this source uses. */
export interface LedgerEth {
  getAddress(path: string, display?: boolean): Promise<{ address: string; publicKey: string }>;
}

/**
 * Derives addresses on a Ledger device, so the seed never leaves it. The device returns the public key alongside the
 * address; it is dropped immediately and never stored or printed.
 */
export function ledgerSource(eth: LedgerEth, close: () => Promise<void>): AddressSource {
  return {
    kind: "ledger",
    async address(account: number): Promise<Address> {
      const { address } = await eth.getAddress(derivationPath(account).slice(2), false);
      return getAddress(address);
    },
    close,
  };
}

/** Opens the first connected Ledger over USB. The Ledger packages are optional and only loaded here. */
export async function openLedgerSource(): Promise<AddressSource> {
  let TransportNodeHid: { create(): Promise<{ close(): Promise<void> }> };
  let Eth: new (transport: unknown) => LedgerEth;
  try {
    TransportNodeHid = (await import("@ledgerhq/hw-transport-node-hid")).default as never;
    Eth = (await import("@ledgerhq/hw-app-eth")).default as never;
  } catch {
    throw new Error("Ledger support is not installed: run `npm install` with optional dependencies enabled");
  }
  const transport = await TransportNodeHid.create();
  return ledgerSource(new Eth(transport), () => transport.close());
}
