import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { privateKeyToAddress } from "viem/accounts";
import { toHex, type Address } from "viem";

import type { AddressSource } from "./source.js";

const HARDENED = 0x80000000;

/**
 * Derives addresses from a BIP-39 mnemonic. Intended for an air-gapped machine: the mnemonic and derived keys only
 * ever live in this process's memory.
 */
export function seedSource(mnemonic: string, passphrase = ""): AddressSource {
  const normalized = mnemonic.trim().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized, wordlist)) throw new Error("invalid BIP-39 mnemonic");

  let coinType: HDKey | undefined = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized, passphrase)).derive("m/44'/60'");

  return {
    kind: "seed",
    async address(account: number): Promise<Address> {
      if (!coinType) throw new Error("seed source is closed");
      const key = coinType.deriveChild(account + HARDENED).deriveChild(0).deriveChild(0);
      const privateKey = key.privateKey;
      if (!privateKey) throw new Error(`no private key at account ${account}`);
      const address = privateKeyToAddress(toHex(privateKey));
      key.wipePrivateData();
      return address;
    },
    async close(): Promise<void> {
      coinType?.wipePrivateData();
      coinType = undefined;
    },
  };
}
