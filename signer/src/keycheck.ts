import { getAddress, type Address, type PublicClient } from "viem";

/** A key that has sent a transaction somewhere, so its public key is public. */
export interface UsedKey {
  address: Address;
  /** Names of the networks where its nonce is above zero. */
  networks: string[];
}

/** Rechecks a key that looked unused after this long; a used key stays used. */
const RECHECK_MS = 10 * 60_000;

/**
 * Checks tree keys before they become owners. A key whose nonce is above zero on any of the given networks has signed
 * a transaction, so its public key is out and it must never be installed or staged. The nonce cannot reveal
 * off-chain signatures; the derived base per Safe is the main protection against those.
 */
export class KeyChecker {
  private readonly cache = new Map<string, { networks: string[]; at: number }>();

  constructor(private readonly clients: readonly PublicClient[]) {}

  /** The used keys among `addresses`. Throws if a network cannot be read: an unchecked key is never treated as fresh. */
  async used(addresses: readonly Address[]): Promise<UsedKey[]> {
    const now = Date.now();
    const pending = addresses.filter((address) => {
      const cached = this.cache.get(address.toLowerCase());
      return !cached || (cached.networks.length === 0 && now - cached.at > RECHECK_MS);
    });
    await Promise.all(
      pending.map(async (address) => {
        const nonces = await Promise.all(
          this.clients.map(async (client) => ({ network: client.chain?.name ?? `chain ${await client.getChainId()}`, nonce: await client.getTransactionCount({ address }) })),
        );
        this.cache.set(address.toLowerCase(), { networks: nonces.filter((entry) => entry.nonce > 0).map((entry) => entry.network), at: now });
      }),
    );
    return addresses
      .map((address) => ({ address: getAddress(address), networks: this.cache.get(address.toLowerCase())!.networks }))
      .filter((entry) => entry.networks.length > 0);
  }

  /** The first index at or after `from` that starts `length` consecutive unused keys, or undefined if none in range. */
  async firstUnusedRun(addressAt: (index: number) => Address | undefined, from: number, length: number, scanLimit = 64): Promise<number | undefined> {
    let start = from;
    for (let index = from; index < from + scanLimit; index++) {
      const address = addressAt(index);
      if (!address) return undefined;
      if ((await this.used([address])).length > 0) start = index + 1;
      else if (index - start + 1 >= length) return start;
    }
    return undefined;
  }
}
