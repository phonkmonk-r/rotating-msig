import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";

/** ABI types of a leaf, matching `RotationGuard._leaf`: `(chainId, safe, slotId, index, owner)`. */
export const LEAF_TYPES = ["uint256", "address", "uint256", "uint256", "address"] as const;

/** Version tag written into every tree file. */
export const TREE_FORMAT = "rotation-tree/v1";

/** Largest account index usable as a hardened BIP-32 child. */
export const MAX_ACCOUNT_INDEX = 2 ** 31 - 1;

/**
 * How a tree's keys are derived, newest first:
 * - Two-level per Safe (current): hardened account and branch both from a hash of chain and Safe, keys at index `i`
 *   under them. Two Safes of one seed share keys only if both levels collide: about 1 in 4.6 × 10^18 per pair.
 * - Per Safe: one hardened account per Safe, about 1 in 2 billion per pair.
 * - Ranged (earliest trees): key `i` at hardened account `base + i`; 10,000-key ranges overlap about 1 in 50,000.
 * Every level is a single fixed-cost derivation, so the size of the numbers never slows a device down.
 */
export const BRANCH_PATH_TEMPLATE = "m/44'/60'/{account}'/{branch}'/{index}";
export const SAFE_PATH_TEMPLATE = "m/44'/60'/{account}'/0/{index}";
export const RANGE_PATH_TEMPLATE = "m/44'/60'/{account}'/0/0";

/** Where key `index` of a tree is derived. `branch` set means a hardened fourth level; otherwise it is 0. */
export interface KeyPath {
  account: number;
  index: number;
  branch?: number;
}

export function treeKeyPath(layout: Pick<TreeFile, "base" | "pathTemplate" | "branch">, index: number): KeyPath {
  if (layout.pathTemplate === BRANCH_PATH_TEMPLATE) {
    if (layout.branch === undefined) throw new Error("a two-level tree needs its branch");
    return { account: layout.base, branch: layout.branch, index };
  }
  if (layout.pathTemplate === SAFE_PATH_TEMPLATE) return { account: layout.base, index };
  if (layout.pathTemplate === RANGE_PATH_TEMPLATE) return { account: layout.base + index, index: 0 };
  throw new Error(`unknown derivation path template ${layout.pathTemplate}`);
}

export type LeafValue = [chainId: string, safe: Address, slotId: string, index: string, owner: Address];

/** Identifies which Safe slot a tree belongs to. All of it is bound into every leaf. */
export interface TreeMeta {
  chainId: number;
  safe: Address;
  slotId: number;
  /** The hardened account the keys live under (per-Safe layouts), or the first account of the range (ranged layout). */
  base: number;
  /** The hardened branch under the account (two-level layout only). */
  branch?: number;
}

/** On-disk tree file. Holds only addresses (hashes of public keys), never public keys, xpubs or secrets. */
export interface TreeFile extends TreeMeta {
  format: typeof TREE_FORMAT;
  pathTemplate: string;
  size: number;
  root: Hex;
  addresses: Address[];
}

/** One staging entry, in the shape `RotationGuard.stage` expects. */
export interface StageEntry {
  index: number;
  owner: Address;
  proof: Hex[];
}

/** Arguments for `RotationGuard.initialize` / `addSlot`. */
export interface SlotConfig {
  root: Hex;
  size: number;
  startIndex: number;
  owner: Address;
  proof: Hex[];
  cid: string;
}

export function leafValue(meta: TreeMeta, index: number, owner: Address): LeafValue {
  return [String(meta.chainId), meta.safe, String(meta.slotId), String(index), owner];
}

/**
 * Leaf hash computed independently of the Merkle library: `keccak256(keccak256(abi.encode(...)))`.
 * Used to cross-check the library and the contract.
 */
export function leafHash(meta: TreeMeta, index: number, owner: Address): Hex {
  const encoded = encodeAbiParameters(
    LEAF_TYPES.map((type) => ({ type })),
    [BigInt(meta.chainId), meta.safe, BigInt(meta.slotId), BigInt(index), owner],
  );
  return keccak256(keccak256(encoded));
}

export function validateMeta(meta: TreeMeta, size: number): void {
  if (!Number.isSafeInteger(meta.chainId) || meta.chainId <= 0) throw new Error(`invalid chain id: ${meta.chainId}`);
  if (!isAddress(meta.safe, { strict: false })) throw new Error(`invalid safe address: ${meta.safe}`);
  if (!Number.isSafeInteger(meta.slotId) || meta.slotId < 0) throw new Error(`invalid slot id: ${meta.slotId}`);
  if (!Number.isSafeInteger(size) || size < 1 || size > 2 ** 32 - 1) throw new Error(`invalid size: ${size}`);
  if (meta.branch !== undefined && (!Number.isSafeInteger(meta.branch) || meta.branch < 0 || meta.branch > MAX_ACCOUNT_INDEX)) {
    throw new Error(`invalid branch: ${meta.branch}`);
  }
  if (!Number.isSafeInteger(meta.base) || meta.base < 0 || meta.base + size - 1 > MAX_ACCOUNT_INDEX) {
    throw new Error(`account range ${meta.base}..${meta.base + size - 1} is outside the hardened index space`);
  }
}

export function buildTree(meta: TreeMeta, addresses: readonly Address[]): StandardMerkleTree<LeafValue> {
  validateMeta(meta, addresses.length);
  const seen = new Set<string>();
  const safe = getAddress(meta.safe);
  const values = addresses.map((address, index) => {
    const owner = getAddress(address);
    const key = owner.toLowerCase();
    if (owner === "0x0000000000000000000000000000000000000000" || owner === "0x0000000000000000000000000000000000000001") {
      throw new Error(`address ${index} is a reserved Safe address`);
    }
    if (owner === safe) throw new Error(`address ${index} is the Safe itself`);
    if (seen.has(key)) throw new Error(`duplicate address at index ${index}: ${owner}`);
    seen.add(key);
    return leafValue({ ...meta, safe }, index, owner);
  });
  return StandardMerkleTree.of(values, [...LEAF_TYPES]);
}

export function createTreeFile(meta: TreeMeta, pathTemplate: string, addresses: readonly Address[]): TreeFile {
  const tree = buildTree(meta, addresses);
  return {
    format: TREE_FORMAT,
    chainId: meta.chainId,
    safe: getAddress(meta.safe),
    slotId: meta.slotId,
    base: meta.base,
    ...(meta.branch === undefined ? {} : { branch: meta.branch }),
    pathTemplate,
    size: addresses.length,
    root: tree.root as Hex,
    addresses: addresses.map((address) => getAddress(address)),
  };
}

/**
 * Parses a tree file and rebuilds its tree. The stored root is never trusted: it must equal the root rebuilt from
 * the addresses, so a tampered or truncated file is rejected.
 */
export function loadTreeFile(json: string): { file: TreeFile; tree: StandardMerkleTree<LeafValue> } {
  const file = JSON.parse(json) as TreeFile;
  if (file.format !== TREE_FORMAT) throw new Error(`unsupported tree format: ${String(file.format)}`);
  if (!Array.isArray(file.addresses) || file.addresses.length !== file.size) {
    throw new Error(`tree file lists ${file.addresses?.length} addresses but declares size ${file.size}`);
  }
  const tree = buildTree(file, file.addresses);
  if (tree.root !== file.root) throw new Error(`tree file root ${file.root} does not match its addresses (${tree.root})`);
  return { file, tree };
}

export function proofFor(tree: StandardMerkleTree<LeafValue>, file: TreeFile, index: number): StageEntry {
  if (!Number.isSafeInteger(index) || index < 0 || index >= file.size) throw new Error(`index ${index} out of range`);
  const owner = file.addresses[index]!;
  return { index, owner, proof: tree.getProof(index) as Hex[] };
}

export function stageEntries(tree: StandardMerkleTree<LeafValue>, file: TreeFile, from: number, count: number): StageEntry[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`invalid count: ${count}`);
  if (from + count > file.size) throw new Error(`entries ${from}..${from + count - 1} exceed tree size ${file.size}`);
  return Array.from({ length: count }, (_, i) => proofFor(tree, file, from + i));
}

export function slotConfig(tree: StandardMerkleTree<LeafValue>, file: TreeFile, startIndex: number, cid: string): SlotConfig {
  const entry = proofFor(tree, file, startIndex);
  return { root: file.root, size: file.size, startIndex, owner: entry.owner, proof: entry.proof, cid };
}
