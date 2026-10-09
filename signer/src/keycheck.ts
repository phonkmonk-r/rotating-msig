import { rotationGuardAbi } from "@rotating-msig/core";
import { decodeEventLog, getAddress, isAddressEqual, toEventSelector, type Address, type Hex, type PublicClient } from "viem";

const OWNER_STAGED = toEventSelector("OwnerStaged(address,uint256,uint32,address)");
const OWNER_ROTATED = toEventSelector("OwnerRotated(address,uint256,address,address,uint32)");

/** Most public RPCs cap a log search at 50,000 to 100,000 blocks, and require a contract address. */
const LOG_CHUNK = 45_000n;

/** Where to look for keys some Safe already staged or rotated to: the guard deployments on this network. */
export interface GuardHistory {
  client: PublicClient;
  guards: Address[];
  /** The first guard deployment: tree keys cannot have been staged before it. */
  fromBlock: bigint;
}

/** A key that has sent a transaction somewhere, so its public key is public. */
export interface UsedKey {
  address: Address;
  /** Where it was used: networks where its nonce is above zero, and Safes that already had it as an owner. */
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
  /** Every key the guards have staged or rotated to, with the Safes it went to, from `fromBlock` to `scannedTo`. */
  private readonly seen = new Map<string, Set<string>>();
  private scannedTo?: bigint;
  /** Why the last guard-history search could not run, if it could not. */
  historyError?: string;

  constructor(
    private readonly clients: readonly PublicClient[],
    private readonly guardHistory?: GuardHistory,
  ) {}

  /**
   * The used keys among `addresses`. Throws if a network cannot be read for nonces: an unchecked key is never treated as
   * fresh. With guard history (and `checkOwners`), also flags keys a guard already staged or rotated to for another
   * Safe than `ownSafe`; that search is best effort, since RPCs may refuse it.
   */
  async used(addresses: readonly Address[], options: { checkOwners?: boolean; ownSafe?: Address } = {}): Promise<UsedKey[]> {
    const ownedBy = options.checkOwners === false ? new Map<string, Address[]>() : await this.elsewhere(addresses, options.ownSafe);
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
      .map((address) => ({
        address: getAddress(address),
        networks: [...this.cache.get(address.toLowerCase())!.networks, ...(ownedBy.get(address.toLowerCase()) ?? []).map((safe) => `Safe ${safe.slice(0, 6)}…${safe.slice(-4)}`)],
      }))
      .filter((entry) => entry.networks.length > 0);
  }

  /**
   * Safes other than `ownSafe` that a guard staged or rotated any of `addresses` to. Reads every OwnerStaged and
   * OwnerRotated event of the guards in chunks, from their first deployment, and only new blocks on later calls. A
   * slot's very first key is not in these events (the install swaps it in directly).
   */
  private async elsewhere(addresses: readonly Address[], ownSafe?: Address): Promise<Map<string, Address[]>> {
    const result = new Map<string, Address[]>();
    if (!this.guardHistory || addresses.length === 0) return result;
    const { client, guards, fromBlock } = this.guardHistory;
    try {
      const latest = await client.getBlockNumber({ cacheTime: 0 });
      for (let from = this.scannedTo === undefined ? fromBlock : this.scannedTo + 1n; from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
        const logs = (await client.request({
          method: "eth_getLogs",
          params: [{ address: guards, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[OWNER_STAGED, OWNER_ROTATED]] }],
        } as never)) as { data: Hex; topics: [Hex, ...Hex[]] }[];
        for (const log of logs) {
          const event = decodeEventLog({ abi: rotationGuardAbi, data: log.data, topics: log.topics });
          const key = event.eventName === "OwnerStaged" ? event.args.owner : event.eventName === "OwnerRotated" ? event.args.newOwner : undefined;
          if (!key || !("safe" in event.args)) continue;
          const safes = this.seen.get(key.toLowerCase()) ?? new Set<string>();
          safes.add(getAddress(event.args.safe as Address));
          this.seen.set(key.toLowerCase(), safes);
        }
        this.scannedTo = to;
      }
      this.historyError = undefined;
    } catch (error) {
      this.historyError = (error as Error).message.split("\n")[0];
    }
    for (const address of addresses) {
      const safes = [...(this.seen.get(address.toLowerCase()) ?? [])].filter((safe) => !ownSafe || !isAddressEqual(safe as Address, ownSafe)) as Address[];
      if (safes.length > 0) result.set(address.toLowerCase(), safes);
    }
    return result;
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
