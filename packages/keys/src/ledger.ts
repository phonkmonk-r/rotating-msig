import {
  getAddress,
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  serializeTransaction,
  signatureToHex,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerializable,
} from "viem";
import { toAccount } from "viem/accounts";

import { derivationPath, type AddressSource } from "./source.js";

/** The subset of `@ledgerhq/hw-app-eth` this source uses. */
export interface LedgerEth {
  getAddress(path: string, display?: boolean): Promise<{ address: string; publicKey: string }>;
  signEIP712HashedMessage(path: string, domainSeparatorHex: string, hashStructMessageHex: string): Promise<{ v: number; r: string; s: string }>;
  signTransaction(path: string, rawTxHex: string, resolution?: null): Promise<{ v: string; r: string; s: string }>;
}

const strip = (hex: Hex) => hex.slice(2);
const prefix = (hex: string): Hex => (hex.startsWith("0x") ? (hex as Hex) : `0x${hex}`);

/**
 * Derives addresses and signs on a Ledger device, so the seed never leaves it. The device returns the public key
 * alongside each address; it is dropped immediately and never stored or printed.
 */
export function ledgerSource(eth: LedgerEth, close: () => Promise<void>): AddressSource {
  async function address(account: number, index = 0, branch?: number): Promise<Address> {
    const { address } = await eth.getAddress(derivationPath(account, index, branch).slice(2), false);
    return getAddress(address);
  }

  return {
    kind: "ledger",
    address,
    async signer(account: number, index = 0, branch?: number): Promise<LocalAccount> {
      const path = derivationPath(account, index, branch).slice(2);
      const owner = await address(account, index, branch);
      return toAccount({
        address: owner,
        async signMessage() {
          throw new Error("message signing is not supported: owner keys only sign Safe transactions");
        },
        async signTypedData(typedData) {
          const { domain = {}, types, primaryType, message } = typedData as never as {
            domain?: Record<string, unknown>;
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
          };
          const allTypes = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...types };
          const domainHash = hashDomain({ domain, types: allTypes } as never);
          const messageHash = hashStruct({ data: message, primaryType, types: allTypes } as never);
          const { v, r, s } = await eth.signEIP712HashedMessage(path, strip(domainHash), strip(messageHash));
          return signatureToHex({ r: prefix(r), s: prefix(s), v: BigInt(v) });
        },
        async signTransaction(transaction) {
          const unsigned = serializeTransaction(transaction as TransactionSerializable);
          const { v, r, s } = await eth.signTransaction(path, strip(unsigned), null);
          return serializeTransaction(transaction as TransactionSerializable, { r: prefix(r), s: prefix(s), v: BigInt(`0x${v}`) });
        },
      }) as LocalAccount;
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
