import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type Address, type LocalAccount } from "viem";

import type { AddressSource } from "./source.js";

const HARDENED = 0x80000000;

/**
 * Derives addresses and signers from a BIP-39 mnemonic. The mnemonic and derived keys only ever live in this
 * process's memory.
 */
export function seedSource(mnemonic: string, passphrase = ""): AddressSource {
  const normalized = mnemonic.trim().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized, wordlist)) throw new Error("invalid BIP-39 mnemonic");

  let coinType: HDKey | undefined = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized, passphrase)).derive("m/44'/60'");

  function signer(account: number, index = 0, branch?: number): LocalAccount {
    if (!coinType) throw new Error("seed source is closed");
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`invalid key index ${index}`);
    if (branch !== undefined && (!Number.isInteger(branch) || branch < 0 || branch >= HARDENED)) throw new Error(`invalid branch ${branch}`);
    const key = coinType
      .deriveChild(account + HARDENED)
      .deriveChild(branch === undefined ? 0 : branch + HARDENED)
      .deriveChild(index);
    const privateKey = key.privateKey;
    if (!privateKey) throw new Error(`no private key at account ${account}, index ${index}`);
    const local = privateKeyToAccount(toHex(privateKey));
    key.wipePrivateData();
    return local;
  }

  return {
    kind: "seed",
    async address(account: number, index = 0, branch?: number): Promise<Address> {
      return signer(account, index, branch).address;
    },
    async signer(account: number, index = 0, branch?: number): Promise<LocalAccount> {
      return signer(account, index, branch);
    },
    async close(): Promise<void> {
      coinType?.wipePrivateData();
      coinType = undefined;
    },
  };
}
