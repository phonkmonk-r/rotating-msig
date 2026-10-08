import {
  assess,
  deploymentsFor,
  describeRevert,
  evaluate,
  execTransactionData,
  packSignatures,
  preValidatedSignature,
  readSafeState,
  safeTxTypedData,
  type Action,
  type Finding,
  type PendingTx,
  type SafeState,
  type TreeFile,
  type TxService,
  type Verdict,
} from "@rotating-msig/core";
import { resolveCurrentOwner, type AddressSource, type CurrentOwner } from "@rotating-msig/keys";
import { createWalletClient, http, type Address, type Chain, type Hex, type PublicClient } from "viem";

export interface SessionOptions {
  publicClient: PublicClient;
  chain: Chain;
  /** RPC used only to broadcast executions; should be private and revert-protected. */
  executionRpcUrl: string;
  txService: TxService;
  source: AddressSource;
  tree: TreeFile;
  safe: Address;
  /** MultiSendCallOnly the guard allows; defaults to the canonical deployment for the chain. */
  multiSendCallOnly?: Address;
  /** How long to wait for an execution to be included before reporting it as stuck. */
  executionTimeoutMs?: number;
}

export const DEFAULT_EXECUTION_TIMEOUT_MS = 180_000;

export interface Me {
  slotId: number;
  index: number;
  address: Address;
  balance: string;
  staged: number;
  bufferSize: number;
  treeSize: number;
}

/** One slot as every signer sees it. */
export interface SignerView {
  slotId: number;
  owner: Address;
  index: number;
  treeSize: number;
  staged: number;
  /** Tree addresses never used or staged. */
  unused: number;
  balance: string;
  isMe: boolean;
  /** Nonces of pending transactions this owner has confirmed: their key is exposed until those execute. */
  confirmedNonces: string[];
}

export interface StatusView {
  safe: Address;
  chainId: number;
  chainName: string;
  /** Host of the execution RPC only: full URLs often carry API keys. */
  executionHost: string;
  threshold: number;
  owners: Address[];
  nonce: string;
  balance: string;
  installed: boolean;
  me?: Me;
  meError?: string;
  findings: Finding[];
  signers: SignerView[];
  /** Set when the Transaction Service could not be read; confirmations are then unknown. */
  queueError?: string;
}

export interface QueueItem {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  confirmations: { owner: Address; signatureType: string; counts: boolean }[];
  verdict: Pick<Verdict, "action" | "blockers" | "warnings">;
  submissionDate?: string;
}

/** An execution this signer sent, as tracked until it is included or reported stuck. */
export interface Execution {
  safeTxHash: Hex;
  transactionHash: Hex;
  /** Host of the RPC it was sent through. */
  sentThrough: string;
  sentAt: string;
  status: "pending" | "success" | "reverted" | "stuck";
  gasUsed?: string;
  rotated?: { slotId: number; from: Address; to: Address }[];
  message?: string;
}

/** Ether amount as a decimal string, for JSON. */
const wei = (value: bigint) => value.toString();

/**
 * One signer's view of one Safe. Holds the key source; every action re-reads chain and queue state and re-runs the
 * rules engine, so nothing the UI sends can bypass a rule.
 */
export class SignerSession {
  private busy: Promise<unknown> = Promise.resolve();
  private readonly executions = new Map<string, { record: Execution; before: SafeState; sentAtMs: number }>();

  constructor(private readonly options: SessionOptions) {}

  private async snapshot(): Promise<{ state: SafeState; owner?: CurrentOwner; ownerError?: string }> {
    const state = await readSafeState(this.options.publicClient, this.options.safe);
    try {
      return { state, owner: await resolveCurrentOwner(this.options.source, this.options.tree, state) };
    } catch (error) {
      return { state, ownerError: (error as Error).message };
    }
  }

  async status(): Promise<StatusView> {
    const { state, owner, ownerError } = await this.snapshot();
    let pending: PendingTx[] = [];
    let queueError: string | undefined;
    try {
      pending = await this.options.txService.pending(this.options.safe, state.nonce);
    } catch (error) {
      queueError = (error as Error).message;
    }
    let me: Me | undefined;
    if (owner) {
      const balance = await this.options.publicClient.getBalance({ address: owner.account.address });
      me = {
        slotId: owner.slot.slotId,
        index: owner.index,
        address: owner.account.address,
        balance: wei(balance),
        staged: owner.slot.staged.length,
        bufferSize: state.bufferSize,
        treeSize: owner.slot.size,
      };
    }
    return {
      safe: state.safe,
      chainId: state.chainId,
      chainName: this.options.chain.name,
      executionHost: new URL(this.options.executionRpcUrl).host,
      threshold: state.threshold,
      owners: state.owners,
      nonce: state.nonce.toString(),
      balance: wei(state.balance),
      installed: state.installed,
      me,
      meError: ownerError,
      findings: assess(state),
      signers: state.slots.map((slot) => ({
          slotId: slot.slotId,
          owner: slot.owner,
          index: slot.ownerIndex,
          treeSize: slot.size,
          staged: slot.staged.length,
          unused: slot.unstaged,
          balance: wei(slot.ownerBalance),
          isMe: owner?.slot.slotId === slot.slotId,
          confirmedNonces: pending
            .filter((tx) => tx.confirmations.some((c) => c.owner.toLowerCase() === slot.owner.toLowerCase() && (c.signatureType === "EOA" || c.signatureType === "ETH_SIGN")))
            .map((tx) => tx.tx.nonce.toString()),
      })),
      queueError,
    };
  }

  async queue(): Promise<QueueItem[]> {
    const { state, owner } = await this.snapshot();
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    return pending.map((tx) => {
      const verdict = owner ? this.evaluate(state, tx, pending, owner) : undefined;
      return {
        safeTxHash: tx.safeTxHash,
        nonce: tx.tx.nonce.toString(),
        actions: verdict?.actions ?? [],
        confirmations: tx.confirmations.map((c) => ({
          owner: c.owner,
          signatureType: c.signatureType,
          counts: verdict?.validConfirmations.some((v) => v.owner === c.owner) ?? false,
        })),
        verdict: verdict
          ? { action: verdict.action, blockers: verdict.blockers, warnings: verdict.warnings }
          : { action: "none", blockers: ["your key could not be resolved; see status"], warnings: [] },
        submissionDate: tx.submissionDate,
      };
    });
  }

  /** Signs the transaction's SafeTx hash with the current owner key and posts the confirmation. */
  confirm(safeTxHash: Hex): Promise<{ owner: Address }> {
    return this.exclusive(async () => {
      const { state, owner, pending, tx } = await this.load(safeTxHash);
      const verdict = this.evaluate(state, tx, pending, owner);
      if (verdict.action !== "confirm") throw new Error(`cannot confirm: ${[...verdict.blockers, `allowed action is ${verdict.action}`].join("; ")}`);
      const signature = await owner.account.signTypedData(safeTxTypedData(state.chainId, state.safe, tx.tx));
      await this.options.txService.confirm(tx.safeTxHash, signature);
      return { owner: owner.account.address };
    });
  }

  /**
   * Executes as the last signer: simulate, then send through the execution RPC and return at once with the
   * transaction hash. Inclusion is tracked separately (`execution`), so a private RPC that holds the transaction can
   * never leave the signer waiting silently.
   */
  execute(safeTxHash: Hex): Promise<Execution> {
    return this.exclusive(async () => {
      const { publicClient, chain, executionRpcUrl } = this.options;
      const { state, owner, pending, tx } = await this.load(safeTxHash);
      const verdict = this.evaluate(state, tx, pending, owner);
      if (verdict.action !== "execute" || !verdict.executeWith) {
        throw new Error(`cannot execute: ${[...verdict.blockers, `allowed action is ${verdict.action}`].join("; ")}`);
      }

      const signatures = packSignatures([...verdict.executeWith, preValidatedSignature(owner.account.address)]);
      const data = execTransactionData(tx.tx, signatures);
      const from = owner.account.address;

      let gas: bigint;
      try {
        await publicClient.call({ account: from, to: state.safe, data });
        gas = await publicClient.estimateGas({ account: from, to: state.safe, data });
      } catch (error) {
        throw new Error(`simulation failed, nothing was sent: ${describeRevert(error) ?? (error as Error).message}`);
      }

      const wallet = createWalletClient({ account: owner.account, chain, transport: http(executionRpcUrl) });
      const transactionHash = await wallet.sendTransaction({ to: state.safe, data, gas: (gas * 12n) / 10n, chain });
      const record: Execution = {
        safeTxHash: tx.safeTxHash,
        transactionHash,
        sentThrough: new URL(executionRpcUrl).host,
        sentAt: new Date().toISOString(),
        status: "pending",
      };
      this.executions.set(transactionHash.toLowerCase(), { record, before: state, sentAtMs: Date.now() });
      return record;
    });
  }

  /** Current status of an execution this signer sent. */
  async execution(transactionHash: Hex): Promise<Execution> {
    const entry = this.executions.get(transactionHash.toLowerCase());
    if (!entry) throw new Error(`no execution ${transactionHash} was sent by this signer`);
    const { record, before, sentAtMs } = entry;
    if (record.status === "success" || record.status === "reverted") return record;

    const receipt = await this.options.publicClient.getTransactionReceipt({ hash: record.transactionHash }).catch(() => undefined);
    if (receipt) {
      record.gasUsed = receipt.gasUsed.toString();
      if (receipt.status === "success") {
        const after = await readSafeState(this.options.publicClient, before.safe);
        record.status = "success";
        record.rotated = before.slots
          .map((slot) => ({ slotId: slot.slotId, from: slot.owner, to: after.slots.find((s) => s.slotId === slot.slotId)?.owner ?? slot.owner }))
          .filter((change) => change.from !== change.to);
        record.message = undefined;
      } else {
        record.status = "reverted";
        record.message = "The transaction was mined but reverted: its signatures are public and nobody rotated. Refill buffers and force-rotate those signers now.";
      }
      return record;
    }

    const timeout = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    if (Date.now() - sentAtMs > timeout) {
      record.status = "stuck";
      record.message =
        `Not included after ${Math.round(timeout / 60_000) || 1} minute(s) through ${record.sentThrough}; it may still land. ` +
        "To resend through another RPC, restart the signer with --execution-rpc and execute again: both use your account's next nonce, so only one can ever be mined.";
    }
    return record;
  }

  private evaluate(state: SafeState, tx: PendingTx, queue: readonly PendingTx[], owner: CurrentOwner): Verdict {
    return evaluate({
      state,
      pending: tx,
      queue,
      me: owner.account.address,
      decode: {
        safe: state.safe,
        guard: state.guard,
        multiSendCallOnly: this.options.multiSendCallOnly ?? deploymentsFor(state.chainId).multiSendCallOnly,
      },
    });
  }

  private async load(safeTxHash: Hex) {
    const { state, owner, ownerError } = await this.snapshot();
    if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    const tx = pending.find((candidate) => candidate.safeTxHash.toLowerCase() === safeTxHash.toLowerCase());
    if (!tx) throw new Error(`transaction ${safeTxHash} is not pending for this Safe`);
    return { state, owner, pending, tx };
  }

  /** Runs one signing action at a time, so two clicks can never race. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.busy.then(task, task);
    this.busy = run.catch(() => undefined);
    return run;
  }
}
