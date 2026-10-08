import {
  createInvite,
  creationCall,
  DEFAULT_TREE_SIZE,
  defaultBase,
  deploymentsFor,
  describeRevert,
  execTransactionData,
  installFromPackages,
  loadTreeFile,
  plainSafeTx,
  preValidatedSignature,
  readSafeState,
  safeProxyFactoryAbi,
  verifyInvite,
  createSlotPackage,
  INSTALL_STAGE_COUNT,
  slotConfig,
  stageEntries,
  type SafeDeployments,
  type SafeInvite,
  type SlotPackage,
  type TreeFile,
} from "@rotating-msig/core";
import { generateTree, OPERATOR_ACCOUNT, type AddressSource } from "@rotating-msig/keys";
import { createWalletClient, custom, isAddressEqual, type Address, type Chain, type Hex, type PublicClient } from "viem";

export { OPERATOR_ACCOUNT };

export interface NewSafeContext {
  client: PublicClient;
  chain: Chain;
  /** Defaults to the canonical deployments for the chain; tests pass their own. */
  deployments?: SafeDeployments;
}

function deploymentsOf(context: NewSafeContext): SafeDeployments {
  return context.deployments ?? deploymentsFor(context.chain.id);
}

async function proxyCreationCode(context: NewSafeContext): Promise<Hex> {
  return context.client.readContract({ address: deploymentsOf(context).safeProxyFactory, abi: safeProxyFactoryAbi, functionName: "proxyCreationCode" });
}

/** Plans a new Safe. `owners` are every signer's operator account in slot order, the creator's included. */
export async function planSafe(context: NewSafeContext, owners: readonly string[], threshold: number): Promise<SafeInvite> {
  return createInvite({ chainId: context.chain.id, owners, threshold, deployments: deploymentsOf(context), proxyCreationCode: await proxyCreationCode(context) });
}

/** Checks an invite received from the creator and finds this signer's slot in it. */
export async function readInvite(context: NewSafeContext, source: AddressSource, invite: SafeInvite): Promise<{ slotId: number; operator: Address }> {
  if (invite.chainId !== context.chain.id) throw new Error(`the invite is for chain ${invite.chainId}`);
  const errors = verifyInvite(invite, deploymentsOf(context), await proxyCreationCode(context));
  if (errors.length > 0) throw new Error(errors.join("; "));
  const operator = await source.address(OPERATOR_ACCOUNT);
  const slotId = invite.owners.findIndex((owner) => isAddressEqual(owner, operator));
  if (slotId < 0) throw new Error(`your address ${operator} is not one of this Safe's signers; send it to the creator`);
  return { slotId, operator };
}

/**
 * Generates this signer's tree for the invite's Safe (at the default base for that Safe, so joining later finds it)
 * and the package the creator needs from them.
 */
export async function prepareSlot(
  context: NewSafeContext,
  source: AddressSource,
  invite: SafeInvite,
  onProgress?: (done: number, total: number) => void,
  size = DEFAULT_TREE_SIZE,
): Promise<{ tree: TreeFile; package: SlotPackage }> {
  const { slotId } = await readInvite(context, source, invite);
  const meta = { chainId: invite.chainId, safe: invite.safe, slotId, base: defaultBase(invite.chainId, invite.safe) };
  const tree = await generateTree(source, meta, size, onProgress);
  return { tree, package: createSlotPackage(invite, loadTreeFile(JSON.stringify(tree))) };
}

export type CreationStage = "deploying" | "installing" | "done";

export interface CreationResult {
  safe: Address;
  deployTx?: Hex;
  installTx: Hex;
}

/**
 * Deploys the invite's Safe (unless it already exists) and installs the guard from every signer's package, both
 * sent by the creator's operator account. Before installing, checks the deployed Safe is exactly the invite's: its
 * operators as owners, threshold 1, nothing executed yet.
 */
export async function createSafe(
  context: NewSafeContext,
  source: AddressSource,
  invite: SafeInvite,
  packages: readonly SlotPackage[],
  onStage?: (stage: CreationStage) => void,
): Promise<CreationResult> {
  const { client, chain } = context;
  const deployments = deploymentsOf(context);
  const install = installFromPackages(invite, packages, deployments);
  const operator = await source.signer(OPERATOR_ACCOUNT);
  if (!invite.owners.some((owner) => isAddressEqual(owner, operator.address))) throw new Error("only one of the Safe's signers can create it");
  const wallet = createWalletClient({ account: operator, chain, transport: custom(client) });

  let deployTx: Hex | undefined;
  if (!(await client.getCode({ address: invite.safe }))) {
    onStage?.("deploying");
    const call = creationCall(invite, deployments);
    try {
      await client.call({ account: operator.address, ...call });
    } catch (error) {
      throw new Error(`creating the Safe would fail: ${describeRevert(error)}`);
    }
    deployTx = await wallet.sendTransaction({ ...call, chain });
    const receipt = await client.waitForTransactionReceipt({ hash: deployTx });
    if (receipt.status !== "success") throw new Error(`creating the Safe reverted (${deployTx})`);
  }

  const state = await readSafeState(client, invite.safe);
  const sameOwners = state.owners.length === invite.owners.length && invite.owners.every((owner) => state.owners.some((current) => isAddressEqual(current, owner)));
  if (!sameOwners || state.threshold !== 1 || state.nonce !== 0n) {
    throw new Error("the Safe at this address is not the one in the invite, or it was already used; start over with a new invite");
  }

  onStage?.("installing");
  const tx = plainSafeTx({ ...install, nonce: 0n });
  const data = execTransactionData(tx, preValidatedSignature(operator.address).data);
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: operator.address, to: invite.safe, data });
  } catch (error) {
    throw new Error(`installing would fail: ${describeRevert(error)}`);
  }
  const installTx = await wallet.sendTransaction({ to: invite.safe, data, gas: (gas * 12n) / 10n, chain });
  const receipt = await client.waitForTransactionReceipt({ hash: installTx });
  if (receipt.status !== "success") throw new Error(`the install reverted (${installTx})`);

  const installed = await readSafeState(client, invite.safe);
  if (!installed.installed || installed.threshold !== invite.threshold) throw new Error(`the install was sent (${installTx}) but the Safe does not show it`);
  onStage?.("done");
  return { safe: invite.safe, deployTx, installTx };
}

/**
 * Prepares this signer to be added to an existing guarded Safe: generates their tree for the slot ID the guard hands
 * out next, and the package an existing signer proposes with. If two newcomers prepare at once, the second package
 * no longer fits once the first is added and must be prepared again.
 */
export async function prepareNewSlot(
  context: NewSafeContext,
  source: AddressSource,
  safe: Address,
  onProgress?: (done: number, total: number) => void,
  size = DEFAULT_TREE_SIZE,
): Promise<{ tree: TreeFile; package: SlotPackage }> {
  const state = await readSafeState(context.client, safe);
  if (!state.installed) throw new Error("this Safe does not have the rotation guard installed");
  const meta = { chainId: context.chain.id, safe: state.safe, slotId: state.slotCount, base: defaultBase(context.chain.id, state.safe) };
  const first = await source.address(meta.base);
  if (state.owners.some((owner) => isAddressEqual(owner, first))) throw new Error("this seed is already a signer of this Safe");
  const tree = await generateTree(source, meta, size, onProgress);
  const loaded = loadTreeFile(JSON.stringify(tree));
  return {
    tree,
    package: {
      v: 1,
      chainId: tree.chainId,
      safe: tree.safe,
      slotId: tree.slotId,
      operator: await source.address(OPERATOR_ACCOUNT),
      base: tree.base,
      config: slotConfig(loaded.tree, tree, 0, ""),
      stage: stageEntries(loaded.tree, tree, 1, INSTALL_STAGE_COUNT),
    },
  };
}
