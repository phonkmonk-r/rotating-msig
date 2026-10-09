import {
  BRANCH_PATH_TEMPLATE,
  defaultBase,
  RANGE_PATH_TEMPLATE,
  readSafeState,
  SAFE_PATH_TEMPLATE,
  safeAccount,
  safeKeyPath,
  MAX_KEY_GENERATIONS,
  type TreeFile,
} from "@rotating-msig/core";
import { discoverSlot, generateTree, type AddressSource, type KeyLayout } from "@rotating-msig/keys";
import { createPublicClient, fallback, getAddress, http, isAddress, isAddressEqual, type Address, type PublicClient } from "viem";

import { chainFor, DEFAULT_RPCS } from "./networks.js";

/** Account index the first Sepolia test Safe used before ranges were derived per Safe. Tried after the derived one. */
export const LEGACY_BASES = [100_000];

/** Where a signer's keys for a Safe may live: the two-level path first, then the layouts of earlier trees. */
export function keyLayouts(chainId: number, safe: Address): KeyLayout[] {
  return [
    // Every generation: a slot whose key list was renewed lives under a later one.
    ...Array.from({ length: MAX_KEY_GENERATIONS }, (_, generation) => {
      const path = safeKeyPath(chainId, safe, generation);
      return { pathTemplate: BRANCH_PATH_TEMPLATE, base: path.account, branch: path.branch };
    }),
    { pathTemplate: SAFE_PATH_TEMPLATE, base: safeAccount(chainId, safe) },
    { pathTemplate: RANGE_PATH_TEMPLATE, base: defaultBase(chainId, safe) },
    ...LEGACY_BASES.map((base) => ({ pathTemplate: RANGE_PATH_TEMPLATE, base })),
  ];
}

export function readClient(chainId: number, rpc?: string): PublicClient {
  const urls = rpc ? [rpc] : DEFAULT_RPCS[chainId];
  if (!urls) throw new Error(`no RPC known for chain ${chainId}; set one`);
  return createPublicClient({ chain: chainFor(chainId), transport: fallback(urls.map((url) => http(url))) }) as PublicClient;
}

export type JoinErrorKind = "invalid-address" | "no-safe" | "ambiguous-chain" | "not-installed" | "not-owner" | "root-mismatch";

export class JoinError extends Error {
  constructor(
    readonly kind: JoinErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface JoinProgress {
  stage: "network" | "reading" | "finding" | "deriving" | "verifying";
  done?: number;
  total?: number;
}

export interface JoinOptions {
  source: AddressSource;
  safe: string;
  /** Pins the network; otherwise mainnet and Sepolia are both checked. */
  chainId?: number;
  /** Overrides the default public RPCs. */
  rpc?: string;
  /** Test hook: a client to use instead of building one. */
  client?: PublicClient;
  /** Test hook: ranged-layout bases to try instead of the defaults. */
  bases?: number[];
  onProgress?: (progress: JoinProgress) => void;
}

export interface JoinResult {
  chainId: number;
  safe: Address;
  slotId: number;
  base: number;
  /** Tree index of the signer's current owner. */
  index: number;
  tree: TreeFile;
}

/** Finds the networks (among mainnet and Sepolia) where `safe` is a deployed contract. */
export async function detectChains(safe: Address, rpc?: string): Promise<number[]> {
  const found = await Promise.all(
    Object.keys(DEFAULT_RPCS).map(async (id) => {
      try {
        const code = await readClient(Number(id), rpc).getCode({ address: safe });
        return code && code !== "0x" ? Number(id) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.filter((id): id is number => id !== undefined);
}

/**
 * Joins an existing guarded Safe from a seed alone: finds the network, finds which slot is this seed's (however many
 * times it has rotated), rebuilds the signer's tree and proves it matches the root committed on-chain.
 */
export async function joinSafe(options: JoinOptions): Promise<JoinResult> {
  const progress = options.onProgress ?? (() => undefined);
  if (!isAddress(options.safe, { strict: false })) throw new JoinError("invalid-address", "that is not a valid Safe address");
  const safe = getAddress(options.safe);

  progress({ stage: "network" });
  let chainId = options.chainId;
  if (chainId === undefined) {
    const chains = await detectChains(safe, options.rpc);
    if (chains.length === 0) throw new JoinError("no-safe", "there is no contract at this address on Ethereum or Sepolia");
    if (chains.length > 1) throw new JoinError("ambiguous-chain", "this address exists on both Ethereum and Sepolia; choose the network under Advanced");
    chainId = chains[0]!;
  }
  const client = options.client ?? readClient(chainId, options.rpc);

  progress({ stage: "reading" });
  const state = await readSafeState(client, safe).catch(() => {
    throw new JoinError("no-safe", "this address is not a Safe this app can read (it must be Safe 1.5.0)");
  });
  if (!state.installed) {
    throw new JoinError("not-installed", "this Safe does not have the rotation guard installed yet");
  }

  progress({ stage: "finding" });
  const found = await discoverSlot(options.source, state, options.bases?.map((base) => ({ pathTemplate: RANGE_PATH_TEMPLATE, base })) ?? keyLayouts(chainId, safe));
  if (!found) {
    throw new JoinError(
      "not-owner",
      "none of this Safe's current owners come from this seed phrase. Check you imported the right seed, and that this signer is part of this Safe",
    );
  }

  const meta = { chainId, safe, slotId: found.slot.slotId, base: found.base, branch: found.branch };
  const tree = await generateTree(options.source, meta, found.slot.size, (done, total) => progress({ stage: "deriving", done, total }), undefined, found.pathTemplate);

  progress({ stage: "verifying" });
  if (tree.root !== found.slot.root) {
    throw new JoinError("root-mismatch", "your keys match the current owner, but the rebuilt tree does not match the root committed on-chain");
  }
  if (!isAddressEqual(tree.addresses[found.slot.ownerIndex]!, found.slot.owner)) {
    throw new JoinError("root-mismatch", "the rebuilt tree does not place the current owner at its index");
  }
  return { chainId, safe, slotId: found.slot.slotId, base: found.base, index: found.slot.ownerIndex, tree };
}
