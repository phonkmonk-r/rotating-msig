import {
  assess,
  batchCalls,
  buildProposal,
  decodeActions,
  checkPackage,
  decodePackage,
  BRANCH_PATH_TEMPLATE,
  DEFAULT_TREE_SIZE,
  entriesProven,
  MAX_KEY_GENERATIONS,
  safeKeyPath,
  packageSignedByOperator,
  packageKeys,
  deploymentsFor,
  describeRevert,
  evaluate,
  execTransactionData,
  packSignatures,
  preValidatedSignature,
  readSafeState,
  plainSafeTx,
  DEFAULT_SAFE_TX_GAS,
  estimatedSafeTxGas,
  guardCalls,
  loadTreeFile,
  stageEntries,
  treeKeyPath,
  rotationGuardAbi,
  safeTxHash,
  safeTxTypedData,
  type Action,
  type Finding,
  type PendingTx,
  type ProposalInput,
  type SafeState,
  type TreeFile,
  type TxService,
  type Verdict,
} from "@rotating-msig/core";
import { KeyChecker, type UsedKey } from "./keycheck.js";
import { readAfter, simulateCalls, type ReadCall, type Simulation } from "./simulate.js";
import { memoryStore, type SessionStore } from "./store.js";
import { generateTree, OPERATOR_ACCOUNT, resolveCurrentOwner, type AddressSource, type CurrentOwner } from "@rotating-msig/keys";
import {
  createWalletClient,
  custom,
  erc20Abi,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  parseEventLogs,
  isAddress,
  numberToHex,
  toEventSelector,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";

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
  /**
   * Pays executions from the operator account (the seed's first account) just in time: before executing, it sends the
   * current owner key exactly the gas it needs; once the execution is mined, the key's remainder is swept back. Rotation
   * keys then hold no ETH between uses, so nothing is stranded when they rotate out.
   */
  gasFunding?: boolean;
  /** Checks this signer's upcoming keys for earlier use; defaults to the Safe's network only. */
  keyChecker?: KeyChecker;
  /** Renewed key lists proposed earlier; the session switches to one once the slot's root on-chain is its root. */
  candidateTrees?: TreeFile[];
  /** Called after switching to a renewed key list, so it can be saved as the slot's tree. */
  onTreeChange?: (tree: TreeFile) => void;
  /** Keeps the signing log and open executions across restarts; in memory when absent. */
  store?: SessionStore;
}

const SIGNING_LOG_FILE = "signing-log.json";
const EXECUTIONS_FILE = "executions.json";
/** A speed-up must raise both fees by at least this much over the transaction it replaces (nodes require 10%). */
const SPEED_UP_BUMP = { numerator: 113n, denominator: 100n };

export const DEFAULT_EXECUTION_TIMEOUT_MS = 180_000;

/**
 * Gas set aside for the sweep when funding. Plain transfers are not always 21,000 gas (Sepolia's repricing charges
 * more for some recipients), so the sweep itself estimates its exact cost.
 */
const SWEEP_GAS_ALLOWANCE = 60_000n;
/** Per-transaction gas cap (EIP-7825). */
const TRANSACTION_GAS_CAP = 16_777_216n;
/** An execution's gas allowance for warning when the operator account runs low. */
const EXECUTION_GAS_ALLOWANCE = 1_000_000n;
/** Refill once the buffer has this many free places, so one transaction stages several keys. */
const REFILL_FREE_PLACES = 2;

/** How long the sweep keeps waiting for an execution that is not mined yet. */
const SWEEP_WATCH_MS = 30 * 60_000;
const SWEEP_POLL_MS = 3_000;

export interface Me {
  slotId: number;
  index: number;
  address: Address;
  balance: string;
  staged: number;
  bufferSize: number;
  treeSize: number;
  /** With gas funding: the account that pays for executions. */
  operator?: { address: Address; balance: string };
  /** The latest refill of this signer's staged keys. */
  lastRefill?: RefillStatus;
  /** Staged or upcoming keys of this slot that already sent a transaction somewhere; skip past them. */
  usedKeys?: (UsedKey & { index: number })[];
  /** Networks where the current owner key itself has sent a transaction outside rotation. */
  currentKeyUsed?: string[];
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
  /** Executions are funded from the operator account, so rotation keys normally hold no ETH. */
  gasFunding: boolean;
  me?: Me;
  meError?: string;
  findings: Finding[];
  signers: SignerView[];
  /** Set when the Transaction Service could not be read; confirmations are then unknown. */
  queueError?: string;
  /** Set while keys that signed something that never went through are still owners. */
  exposure?: Exposure;
}

export interface QueueItem {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  confirmations: { owner: Address; signatureType: string; counts: boolean }[];
  verdict: Pick<Verdict, "action" | "blockers" | "warnings">;
  submissionDate?: string;
  /** This signer's execution of it, when one is out (also after a restart). */
  attempt?: Execution;
  /** The Safe transaction as proposed, for the details view. */
  tx: { to: Address; value: string; data: Hex; operation: 0 | 1; safeTxGas: string };
  proposer?: Address;
}

export interface ProposalResult {
  safeTxHash: Hex;
  nonce: string;
  actions: Action[];
  warnings: string[];
  /** False for a preview: nothing was signed or sent. */
  proposed: boolean;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** The Safe's balance, in base units. */
  safeBalance: string;
}

/** An execution this signer sent, as tracked until it is included or reported stuck. */
export type ExecutionStepId = "simulate" | "gas" | "send" | "include" | "rotate" | "sweep";

/** One step of an execution, as the app shows it while it happens. */
export interface ExecutionStep {
  id: ExecutionStepId;
  label: string;
  status: "waiting" | "active" | "done" | "skipped" | "failed";
  detail?: string;
  transactionHash?: Hex;
}

export interface Execution {
  safeTxHash: Hex;
  /** Set once the execution is sent. */
  transactionHash?: Hex;
  /** Host of the RPC it was sent through. */
  sentThrough: string;
  sentAt?: string;
  /**
   * `preparing`: funding the key or signing; `failed`: nothing was sent (see message); `stuck`: sent, not included
   * after the timeout; `replaced`: another transaction used the Safe nonce, so this one can never be mined.
   */
  status: "preparing" | "pending" | "success" | "reverted" | "stuck" | "failed" | "replaced";
  steps: ExecutionStep[];
  gasUsed?: string;
  rotated?: { slotId: number; from: Address; to: Address }[];
  message?: string;
  /** The operator's transfer to the executing key, when it needed gas. */
  funding?: { transactionHash: Hex; amount: string };
  /** Returning the executing key's remainder to the operator account once the execution is mined. */
  sweep?: { status: "waiting" | "sent" | "nothing" | "failed"; transactionHash?: Hex; amount?: string; message?: string };
  /** Earlier sends of the same transaction, replaced by speed-ups; any of them may still be the one mined. */
  previousHashes?: Hex[];
}

/** One signature by an owner key, as the app records it the moment it signs. */
export interface SignedRecord {
  chainId: number;
  safe: Address;
  nonce: string;
  safeTxHash: Hex;
  key: Address;
  slotId: number;
  /** Tree index of the key. */
  index: number;
  role: "confirm" | "execute";
  at: string;
}

/** Keys that signed something that never went through and are still owners: a full fix is one force-rotate. */
export interface Exposure {
  /** Safe nonce of the transaction that did not go through. */
  nonce: string;
  safeTxHash: Hex;
  keys: { slotId: number; address: Address; role: SignedRecord["role"] }[];
  slotIds: number[];
  /** This signer's own execution of it is still out and may yet land (speed up first). */
  openAttempt: boolean;
}

/** An execution as kept on disk: enough to keep following it, speed it up and sweep after a restart. */
interface StoredAttempt {
  record: Execution;
  /** Safe nonce of the transaction. */
  nonce: string;
  index: number;
  sentAtMs: number;
  accountNonce?: number;
  request?: { to: Address; data: Hex; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
}

interface Attempt extends StoredAttempt {
  account?: LocalAccount;
}

/** Where a proposal stands, read from the Safe's nonce and its execution events. */
export interface ProposalStatus {
  /** `replaced`: another transaction used the proposal's nonce. */
  status: "pending" | "executed" | "failed" | "replaced";
  transactionHash?: Hex;
  /** The execution's receipt as the RPC returned it. */
  receipt?: Record<string, unknown>;
}

const EXECUTION_SUCCESS = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const EXECUTION_FAILURE = toEventSelector("ExecutionFailure(bytes32,uint256)");

/** One action waiting in the local queue; nothing is signed until the whole queue is proposed. */
export interface DraftItem {
  id: string;
  input: ProposalInput;
  /** "app" for actions made in the app, or the dApp's origin. */
  origin: string;
  actions: Action[];
  addedAt: string;
}

/** The queue as the app shows it. */
export interface DraftView {
  enabled: boolean;
  items: DraftItem[];
}

/** Where queued items went once the queue was proposed, so a dApp can follow them. */
export interface DraftProposal {
  safeTxHash: Hex;
  nonce: bigint;
  fromBlock: bigint;
}

/** A staging transaction this signer's gas account sent for its own slot. */
export interface Refill {
  transactionHash: Hex;
  count: number;
  /** Tree index of the first key staged. */
  fromIndex: number;
}

/** The latest automatic or manual refill, shown on the dashboard. */
export interface RefillStatus {
  at: string;
  refill?: Refill;
  error?: string;
}

/** Ether amount as a decimal string, for JSON. */
const wei = (value: bigint) => value.toString();

/**
 * The gas limit for an execution: the simulated cost with a margin, plus the whole `safeTxGas`. The inner call may use
 * all of `safeTxGas` on-chain even if it used less in simulation (a callee that behaves differently once sent), and
 * the rotation after it must still have its gas, or the whole transaction reverts with every signature public.
 */
export function executionGasLimit(simulated: bigint, safeTxGas: bigint): bigint {
  const limit = (simulated * 12n) / 10n + safeTxGas;
  return limit < TRANSACTION_GAS_CAP ? limit : TRANSACTION_GAS_CAP;
}

const isOwner = (state: SafeState, address: Address) => state.owners.some((owner) => isAddressEqual(owner, address));

/**
 * One signer's view of one Safe. Holds the key source; every action re-reads chain and queue state and re-runs the
 * rules engine, so nothing the UI sends can bypass a rule.
 */
export class SignerSession {
  private busy: Promise<unknown> = Promise.resolve();
  private loadedTree?: ReturnType<typeof loadTreeFile>;
  private draftItems: DraftItem[] = [];
  private queueMode = false;
  private nextDraftId = 0;
  private readonly proposedDrafts = new Map<string, DraftProposal>();
  private lastRefill?: RefillStatus;
  private keyAlert?: { usedKeys: (UsedKey & { index: number })[]; currentKeyUsed?: string[] };
  private readonly executions = new Map<string, Attempt>();
  private readonly store: SessionStore;
  private signingLog: SignedRecord[];

  constructor(private readonly options: SessionOptions) {
    this.store = options.store ?? memoryStore();
    this.signingLog = this.readStored<SignedRecord[]>(SIGNING_LOG_FILE) ?? [];
    for (const attempt of this.readStored<StoredAttempt[]>(EXECUTIONS_FILE) ?? []) {
      this.executions.set(attempt.record.safeTxHash.toLowerCase(), attempt);
      for (const hash of this.hashesOf(attempt.record)) this.executions.set(hash.toLowerCase(), attempt);
      if (attempt.record.sweep?.status === "waiting" && attempt.record.transactionHash) void this.sweepWhenMined(attempt.record.transactionHash);
    }
  }

  private readStored<T>(name: string): T | undefined {
    const raw = this.store.read(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private hashesOf(record: Execution): Hex[] {
    return [...(record.transactionHash ? [record.transactionHash] : []), ...(record.previousHashes ?? [])];
  }

  /** Open attempts (sent, not yet final) go to disk; finished ones are dropped from it. */
  private saveAttempts(): void {
    const open = new Map<string, StoredAttempt>();
    for (const attempt of this.executions.values()) {
      const { record } = attempt;
      if (!record.transactionHash || record.status === "failed" || record.status === "success" || record.status === "reverted" || record.status === "replaced") continue;
      const { account: _account, ...stored } = attempt;
      open.set(record.safeTxHash.toLowerCase(), stored);
    }
    this.store.write(EXECUTIONS_FILE, JSON.stringify([...open.values()]));
  }

  /** Records a signature by an owner key before it leaves the app, so a lost transaction can never hide an exposed key. */
  private logSigned(owner: CurrentOwner, nonce: bigint, safeTxHash: Hex, role: SignedRecord["role"]): SignedRecord {
    const entry: SignedRecord = {
      chainId: this.chainId,
      safe: this.safe,
      nonce: nonce.toString(),
      safeTxHash,
      key: owner.account.address,
      slotId: owner.slot.slotId,
      index: owner.index,
      role,
      at: new Date().toISOString(),
    };
    this.signingLog.push(entry);
    this.store.write(SIGNING_LOG_FILE, JSON.stringify(this.signingLog));
    return entry;
  }

  private unlogSigned(entry: SignedRecord): void {
    this.signingLog = this.signingLog.filter((candidate) => candidate !== entry);
    this.store.write(SIGNING_LOG_FILE, JSON.stringify(this.signingLog));
  }

  /** The attempt this signer has out for `safeTxHash`, if it was sent and is not final. */
  private openAttempt(safeTxHash: Hex): Attempt | undefined {
    const attempt = this.executions.get(safeTxHash.toLowerCase());
    if (!attempt?.record.transactionHash) return undefined;
    const { status } = attempt.record;
    return status === "pending" || status === "stuck" ? attempt : undefined;
  }

  /** Brings every open attempt up to date with the chain, so one that landed stops counting as out. */
  private async refreshAttempts(): Promise<void> {
    for (const attempt of new Set(this.executions.values())) {
      if (this.openAttempt(attempt.record.safeTxHash)) await this.execution(attempt.record.safeTxHash).catch(() => undefined);
    }
  }

  private hasOpenAttempt(): boolean {
    return [...new Set(this.executions.values())].some((attempt) => this.openAttempt(attempt.record.safeTxHash) !== undefined);
  }

  /**
   * Recorded keys that are still owners although the transaction they signed is gone from the queue: an execution
   * of theirs that never landed, or a confirmation whose transaction was replaced. Entries whose key rotated out are
   * forgotten. Keys of transactions still pending are not listed, since the queue already counts them.
   */
  private exposures(state: SafeState, pending: readonly PendingTx[]): { exposed: Address[]; exposure?: Exposure } {
    const live = this.signingLog.filter((entry) => entry.chainId === state.chainId && isAddressEqual(entry.safe, state.safe) && isOwner(state, entry.key));
    if (live.length !== this.signingLog.length) {
      this.signingLog = live;
      this.store.write(SIGNING_LOG_FILE, JSON.stringify(live));
    }
    const exposed = [...new Set(live.map((entry) => entry.key))];
    const stillQueued = (entry: SignedRecord) => entry.role === "confirm" && pending.some((tx) => tx.safeTxHash.toLowerCase() === entry.safeTxHash.toLowerCase());
    const lost = live.filter((entry) => !stillQueued(entry));
    const first = lost[0];
    if (!first) return { exposed };
    // One recovery at a time: the oldest lost transaction's signers (its confirmers, when it is still queued, were exposed
    // by the same transaction) plus every other recorded key, since the fix is one force-rotate.
    const keys = live.map((entry) => ({ slotId: entry.slotId, address: entry.key, role: entry.role }));
    const lostTx = pending.find((tx) => tx.safeTxHash.toLowerCase() === first.safeTxHash.toLowerCase());
    for (const confirmation of lostTx?.confirmations ?? []) {
      const slot = state.slots.find((candidate) => isAddressEqual(candidate.owner, confirmation.owner));
      if (!slot || keys.some((key) => isAddressEqual(key.address, confirmation.owner))) continue;
      if (confirmation.signatureType === "EOA" || confirmation.signatureType === "ETH_SIGN") keys.push({ slotId: slot.slotId, address: confirmation.owner, role: "confirm" });
    }
    const attempt = this.openAttempt(first.safeTxHash);
    return {
      exposed,
      exposure: {
        nonce: first.nonce,
        safeTxHash: first.safeTxHash,
        keys,
        slotIds: [...new Set(keys.map((key) => key.slotId))].sort((a, b) => a - b),
        openAttempt: attempt !== undefined && attempt.record.status === "pending",
      },
    };
  }

  get safe(): Address {
    return this.options.safe;
  }

  get chainId(): number {
    return this.options.chain.id;
  }

  /** Forwards a read-only JSON-RPC request to the read RPC. Callers decide which methods are allowed. */
  rpc(method: string, params: unknown[]): Promise<unknown> {
    return this.options.publicClient.request({ method, params } as never);
  }

  async blockNumber(): Promise<bigint> {
    return this.options.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  /**
   * Whether a proposal was executed: pending while the Safe's nonce has not passed it, then found by its
   * ExecutionSuccess or ExecutionFailure event from `fromBlock` on (the block before it was proposed).
   */
  async proposalStatus(safeTxHash: Hex, nonce: bigint, fromBlock: bigint): Promise<ProposalStatus> {
    const { publicClient, safe } = this.options;
    const state = await readSafeState(publicClient, safe);
    if (state.nonce <= nonce) return { status: "pending" };
    const logs = (await this.rpc("eth_getLogs", [
      { address: safe, fromBlock: numberToHex(fromBlock), toBlock: "latest", topics: [[EXECUTION_SUCCESS, EXECUTION_FAILURE], safeTxHash] },
    ])) as { topics: Hex[]; transactionHash: Hex }[];
    const log = logs[0];
    if (!log) return { status: "replaced" };
    const receipt = (await this.rpc("eth_getTransactionReceipt", [log.transactionHash])) as Record<string, unknown>;
    return { status: log.topics[0] === EXECUTION_SUCCESS ? "executed" : "failed", transactionHash: log.transactionHash, receipt };
  }

  private async snapshot(): Promise<{ state: SafeState; owner?: CurrentOwner; ownerError?: string }> {
    await this.refreshAttempts();
    const state = await readSafeState(this.options.publicClient, this.options.safe);
    this.adoptRenewedTree(state);
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
    const findings = assess(state, this.options.gasFunding ? { minOwnerGas: 0n } : {});
    const { exposure } = this.exposures(state, pending);
    if (exposure && !exposure.openAttempt) {
      const slots = exposure.slotIds.map((slotId) => `slot ${slotId}`).join(", ");
      findings.push({
        severity: "critical",
        message: `Transaction #${exposure.nonce} was signed but never went through. The keys of ${slots} are exposed without having rotated: replace them now`,
      });
    }
    if (owner) {
      const balance = await this.options.publicClient.getBalance({ address: owner.account.address });
      let operator: Me["operator"];
      if (this.options.gasFunding) {
        const address = await this.options.source.address(OPERATOR_ACCOUNT);
        const [operatorBalance, gasPrice] = await Promise.all([this.options.publicClient.getBalance({ address }), this.options.publicClient.getGasPrice()]);
        operator = { address, balance: wei(operatorBalance) };
        if (operatorBalance < EXECUTION_GAS_ALLOWANCE * gasPrice * 2n) {
          findings.push({ severity: "warning", slotId: owner.slot.slotId, message: "Your gas account is low: executions are paid from it" });
        }
      }
      for (const key of this.keyAlert?.usedKeys ?? []) {
        findings.push({ severity: "critical", slotId: owner.slot.slotId, message: `Key ${key.index} was already used on ${key.networks.join(", ")}: skip past it before it becomes an owner` });
      }
      if (this.keyAlert?.currentKeyUsed?.length) {
        findings.push({ severity: "critical", slotId: owner.slot.slotId, message: `Your current key has sent a transaction on ${this.keyAlert.currentKeyUsed.join(", ")}: force-rotate your slot` });
      }
      if (this.lastRefill?.error) findings.push({ severity: "warning", slotId: owner.slot.slotId, message: `Refilling your next keys failed: ${this.lastRefill.error}` });
      me = {
        operator,
        lastRefill: this.lastRefill,
        usedKeys: this.keyAlert?.usedKeys,
        currentKeyUsed: this.keyAlert?.currentKeyUsed,
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
      gasFunding: this.options.gasFunding === true,
      me,
      meError: ownerError,
      findings,
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
      exposure,
    };
  }

  async queue(): Promise<QueueItem[]> {
    const { state, owner } = await this.snapshot();
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    return pending.map((tx) => {
      const verdict = owner ? this.evaluate(state, tx, pending, owner) : undefined;
      return {
        attempt: this.openAttempt(tx.safeTxHash)?.record,
        tx: { to: tx.tx.to, value: wei(tx.tx.value), data: tx.tx.data, operation: tx.tx.operation, safeTxGas: wei(tx.tx.safeTxGas) },
        proposer: tx.proposer,
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

  /**
   * Proposes a transaction at the Safe's next nonce, signed with the current owner key; the signature is the
   * proposer's confirmation. With `preview`, only checks and describes it. Refuses while another transaction is
   * pending, since confirmations spread over several transactions can add up to a threshold of exposed keys.
   */
  propose(input: ProposalInput, preview = false, options: { replacing?: boolean } = {}): Promise<ProposalResult> {
    const run = async (): Promise<ProposalResult> => {
      const { state, owner, ownerError } = await this.snapshot();
      if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
      if (state.threshold < 2) throw new Error("proposing needs a threshold of at least 2: with 1, the executor signs alone");
      const queue = await this.options.txService.pending(this.options.safe, state.nonce);
      // A recovery is proposed at the current nonce on purpose: landing it cancels the transaction it replaces.
      const pendingOthers = options.replacing ? queue.filter((tx) => tx.tx.nonce !== state.nonce) : queue;
      if (pendingOthers.length > 0) throw new Error(`transaction #${pendingOthers[0]!.tx.nonce} is still pending: execute it or replace it in Safe{Wallet} first`);

      const call = buildProposal(input, this.context(state));
      await this.check(input, state, call);

      const tx = plainSafeTx({ ...call, nonce: state.nonce }, await this.safeTxGasFor(input, state));
      const hash = safeTxHash(state.chainId, state.safe, tx);
      const verdict = this.evaluate(state, { safeTxHash: hash, tx, confirmations: [] }, queue, owner);
      if (verdict.action !== "confirm") throw new Error(`cannot propose: ${verdict.blockers.join("; ")}`);

      const result = { safeTxHash: hash, nonce: tx.nonce.toString(), actions: verdict.actions, warnings: verdict.warnings, proposed: false };
      if (preview) return result;
      const signed = this.logSigned(owner, tx.nonce, hash, "confirm");
      try {
        const signature = await owner.account.signTypedData(safeTxTypedData(state.chainId, state.safe, tx));
        await this.options.txService.propose(state.safe, tx, owner.account.address, signature);
      } catch (error) {
        this.unlogSigned(signed);
        throw error;
      }
      return { ...result, proposed: true };
    };
    return preview ? run() : this.exclusive(run);
  }

  /**
   * The fix for keys that signed something that never went through: a force-rotate of every exposed slot, proposed at
   * the current nonce so it also cancels the lost transaction. Its own signers rotate as usual. With `preview`, only
   * describes it.
   */
  async recover(preview = false): Promise<ProposalResult & { slotIds: number[] }> {
    const { state } = await this.snapshot();
    const pending = await this.options.txService.pending(this.options.safe, state.nonce);
    const { exposure } = this.exposures(state, pending);
    if (!exposure) throw new Error("no exposed keys to replace");
    const result = await this.propose({ kind: "force-rotate", slotIds: exposure.slotIds }, preview, { replacing: true });
    return { ...result, slotIds: exposure.slotIds };
  }

  /**
   * The gas Safe hands the inner call. The guard requires it non-zero (otherwise a failing call would revert the whole
   * transaction and undo the rotation); it is sized from a simulation when the RPC offers one, else a generous default.
   */
  private async safeTxGasFor(input: ProposalInput, state: SafeState): Promise<bigint> {
    // The escape hatch is exactly setGuard(0), which cannot fail; without safeTxGas it also needs no refund, so it
    // works even when the Safe holds no ETH.
    if (input.kind === "escape") return 0n;
    const calls = batchCalls(input.kind === "batch" ? input.items : [input], this.context(state));
    const simulation = await simulateCalls(this.options.publicClient, state.safe, calls);
    if (!simulation.available || simulation.calls.some((call) => !call.ok)) return DEFAULT_SAFE_TX_GAS;
    return estimatedSafeTxGas(simulation.calls.reduce((sum, call) => sum + BigInt(call.gasUsed), 0n));
  }

  private context(state: SafeState) {
    return { safe: state.safe, guard: state.guard, multiSendCallOnly: this.options.multiSendCallOnly ?? deploymentsFor(state.chainId).multiSendCallOnly };
  }

  /** Everything that can be checked against chain state before signing. A batch checks each item, and ETH in total. */
  private async check(input: ProposalInput, state: SafeState, call: { to: Address }, checkEth = true): Promise<void> {
    if (input.kind === "batch") {
      for (const item of input.items) await this.check(item, state, buildProposal(item, this.context(state)), false);
    }
    if (checkEth && input.kind !== "escape") {
      const total = batchCalls(input.kind === "batch" ? input.items : [input], this.context(state)).reduce((sum, item) => sum + item.value, 0n);
      if (state.balance < total) throw new Error(input.kind === "eth" ? "the Safe does not hold that much ETH" : "the Safe does not hold enough ETH for this");
    }
    if (input.kind === "erc20") {
      const balance = await this.options.publicClient.readContract({ address: call.to, abi: erc20Abi, functionName: "balanceOf", args: [state.safe] });
      if (balance < BigInt(input.amount)) throw new Error("the Safe does not hold that many tokens");
    }
    const owners = state.owners.length;
    const checkThreshold = (threshold: number, signers: number) => {
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > signers) throw new Error(`the threshold must be between 1 and ${signers}`);
    };
    if (input.kind === "threshold") {
      checkThreshold(input.threshold, owners);
      if (input.threshold === state.threshold) throw new Error(`the Safe already requires ${input.threshold}`);
    }
    if (input.kind === "remove-signer") {
      if (!state.slots.some((slot) => slot.slotId === input.slotId)) throw new Error(`slot ${input.slotId} has no signer`);
      if (owners < 2) throw new Error("the last signer cannot be removed");
      checkThreshold(input.threshold, owners - 1);
    }
    if (input.kind === "add-signer") {
      const pkg = decodePackage(input.package);
      const errors = checkPackage(pkg, { chainId: state.chainId, safe: state.safe, slotId: state.slotCount });
      const known = new Set([...state.owners, ...state.slots.flatMap((slot) => slot.staged)].map((address) => address.toLowerCase()));
      if (packageKeys(pkg).some((entry) => known.has(entry.owner.toLowerCase()))) errors.push("the package reuses an address of a current signer");
      if (!(await packageSignedByOperator(pkg))) errors.push(`it is not signed by its signer address ${pkg.operator}`);
      if (errors.length > 0) throw new Error(`the new signer's package does not fit: ${errors.join("; ")}`);
      checkThreshold(input.threshold, owners + 1);
    }
    if (input.kind === "renew-keys") {
      const slot = state.slots.find((candidate) => candidate.slotId === input.slotId);
      if (!slot) throw new Error(`slot ${input.slotId} has no owner`);
      if (input.root === slot.root) throw new Error("this is the slot's current key list");
      if (!entriesProven(input.root, { chainId: state.chainId, safe: state.safe, slotId: input.slotId }, input.stage)) throw new Error("the new keys are not in the new key list");
      const used = await this.checker().used(input.stage.map((entry) => entry.owner), { ownSafe: state.safe });
      if (used.length > 0) throw new Error(`key ${used[0]!.address} of the new list was already used on ${used[0]!.networks.join(", ")}`);
    }
    if (input.kind === "skip-keys") {
      const slot = state.slots.find((candidate) => candidate.slotId === input.slotId);
      if (!slot) throw new Error(`slot ${input.slotId} has no owner`);
      if (input.index < slot.nextStageIndex - slot.staged.length) throw new Error("cannot skip back to keys already used");
      const used = await this.checker().used(input.stage.map((entry) => entry.owner), { ownSafe: state.safe });
      if (used.length > 0) throw new Error(`key ${used[0]!.address} was already used on ${used[0]!.networks.join(", ")}`);
    }
    if (input.kind === "force-rotate") {
      for (const slotId of input.slotIds) {
        const slot = state.slots.find((candidate) => candidate.slotId === slotId);
        if (!slot) throw new Error(`slot ${slotId} has no owner`);
        if (slot.staged.length === 0) throw new Error(`slot ${slotId} has no staged key to rotate to`);
      }
    }
  }

  /** The local queue: when enabled, new actions default to being queued instead of proposed one by one. */
  draft(): DraftView {
    return { enabled: this.queueMode, items: [...this.draftItems] };
  }

  setQueueMode(enabled: boolean): DraftView {
    this.queueMode = enabled;
    return this.draft();
  }

  /** Checks an action against chain state and queues it. Nothing is signed. */
  async addToDraft(input: ProposalInput, origin = "app"): Promise<DraftItem> {
    if (input.kind === "batch") throw new Error("batches cannot be queued");
    if (input.kind === "escape") throw new Error("the escape hatch cannot be queued; propose it on its own");
    const state = await readSafeState(this.options.publicClient, this.options.safe);
    const context = this.context(state);
    const call = buildProposal(input, context);
    await this.check(input, state, call);
    const item: DraftItem = { id: String(++this.nextDraftId), input, origin, actions: decodeActions(call, context), addedAt: new Date().toISOString() };
    this.draftItems.push(item);
    return item;
  }

  removeFromDraft(id: string): DraftView {
    this.draftItems = this.draftItems.filter((item) => item.id !== id);
    return this.draft();
  }

  /** Moves an item up (-1) or down (+1). */
  moveInDraft(id: string, offset: number): DraftView {
    const from = this.draftItems.findIndex((item) => item.id === id);
    const to = from + Math.sign(offset);
    if (from < 0 || to < 0 || to >= this.draftItems.length) return this.draft();
    const items = [...this.draftItems];
    [items[from], items[to]] = [items[to]!, items[from]!];
    this.draftItems = items;
    return this.draft();
  }

  clearDraft(): DraftView {
    this.draftItems = [];
    return this.draft();
  }

  /** The queued actions as the plain calls the Safe would make, in order. */
  async draftCalls() {
    if (this.draftItems.length === 0) return [];
    const state = await readSafeState(this.options.publicClient, this.options.safe);
    return batchCalls(
      this.draftItems.map((item) => item.input),
      this.context(state),
    );
  }

  /** Runs the queued calls as the Safe, without signatures, and reports outcomes and balance changes. */
  async simulateDraft(): Promise<Simulation> {
    return simulateCalls(this.options.publicClient, this.options.safe, await this.draftCalls());
  }

  /** A read run after the queued calls, so dApps see the state the queue would leave. */
  async readAfterDraft(read: ReadCall) {
    return readAfter(this.options.publicClient, this.options.safe, await this.draftCalls(), read);
  }

  /** Proposes the whole queue as one transaction; on success the queue is emptied. */
  async proposeDraft(preview = false): Promise<ProposalResult> {
    const items = [...this.draftItems];
    if (items.length === 0) throw new Error("the queue is empty");
    const fromBlock = preview ? 0n : await this.blockNumber();
    const result = await this.propose({ kind: "batch", items: items.map((item) => item.input) }, preview);
    if (!preview) {
      for (const item of items) this.proposedDrafts.set(item.id, { safeTxHash: result.safeTxHash, nonce: BigInt(result.nonce), fromBlock });
      const sent = new Set(items.map((item) => item.id));
      this.draftItems = this.draftItems.filter((item) => !sent.has(item.id));
    }
    return result;
  }

  /** Where a queued item went: undefined while it is still queued (or was removed). */
  draftProposal(id: string): DraftProposal | undefined {
    return this.proposedDrafts.get(id);
  }

  isQueued(id: string): boolean {
    return this.draftItems.some((item) => item.id === id);
  }

  /** Symbol, decimals and the Safe's balance for an ERC-20 token, so amounts can be entered in whole tokens. */
  async tokenInfo(token: string): Promise<TokenInfo> {
    if (!isAddress(token, { strict: false })) throw new Error("not a token address");
    const address = getAddress(token);
    const { publicClient, safe } = this.options;
    try {
      const [symbol, decimals, balance] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      ]);
      return { address, symbol, decimals, safeBalance: balance.toString() };
    } catch {
      throw new Error("no ERC-20 token at this address on this network");
    }
  }

  /** Signs the transaction's SafeTx hash with the current owner key and posts the confirmation. */
  confirm(safeTxHash: Hex): Promise<{ owner: Address }> {
    return this.exclusive(async () => {
      const { state, owner, pending, tx } = await this.load(safeTxHash);
      const verdict = this.evaluate(state, tx, pending, owner);
      if (verdict.action !== "confirm") throw new Error(`cannot confirm: ${[...verdict.blockers, `allowed action is ${verdict.action}`].join("; ")}`);
      const signed = this.logSigned(owner, tx.tx.nonce, tx.safeTxHash, "confirm");
      try {
        const signature = await owner.account.signTypedData(safeTxTypedData(state.chainId, state.safe, tx.tx));
        await this.options.txService.confirm(tx.safeTxHash, signature);
      } catch (error) {
        this.unlogSigned(signed);
        throw error;
      }
      return { owner: owner.account.address };
    });
  }

  /**
   * Executes as the last signer: simulate, then send through the execution RPC and return at once with the
   * transaction hash. Inclusion is tracked separately (`execution`), so a private RPC that holds the transaction can
   * never leave the signer waiting silently.
   */
  execute(safeTxHash: Hex, options: { untilSent?: boolean } = {}): Promise<Execution> {
    const untilSent = options.untilSent ?? true;
    return new Promise((resolve, reject) => {
      void this.exclusive(async () => {
        let prepared: Awaited<ReturnType<SignerSession["prepareExecution"]>>;
        try {
          prepared = await this.prepareExecution(safeTxHash);
        } catch (error) {
          reject(error);
          return;
        }
        if (!untilSent) resolve(prepared.record);
        try {
          await this.sendExecution(prepared);
          if (untilSent) resolve(prepared.record);
        } catch (error) {
          const { record } = prepared;
          record.status = "failed";
          record.message = (error as Error).message;
          const active = record.steps.find((step) => step.status === "active");
          if (active) Object.assign(active, { status: "failed", detail: record.message });
          if (untilSent) reject(error);
        }
      });
    });
  }

  /** Checks the rules and simulates; nothing is sent. The record starts with its steps laid out. */
  private async prepareExecution(safeTxHash: Hex) {
    const { publicClient, executionRpcUrl, gasFunding } = this.options;
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
    const fees = await publicClient.estimateFeesPerGas();
    const host = new URL(executionRpcUrl).host;
    const steps: ExecutionStep[] = [
      { id: "simulate", label: "Simulated", status: "done", detail: `succeeds, about ${gas.toLocaleString("en-US")} gas` },
      ...(gasFunding ? [{ id: "gas" as const, label: "Gas for your key", status: "waiting" as const }] : []),
      { id: "send", label: `Signed and sent via ${host}`, status: "waiting" },
      { id: "include", label: "Included in a block", status: "waiting" },
      { id: "rotate", label: "Signers rotated", status: "waiting" },
      ...(gasFunding ? [{ id: "sweep" as const, label: "Unused gas returned", status: "waiting" as const }] : []),
    ];
    const record: Execution = { safeTxHash: tx.safeTxHash, sentThrough: host, status: "preparing", steps, sweep: gasFunding ? { status: "waiting" } : undefined };
    this.executions.set(tx.safeTxHash.toLowerCase(), { record, nonce: tx.tx.nonce.toString(), index: owner.index, sentAtMs: Date.now(), account: owner.account });
    return { record, state, data, from, gasLimit: executionGasLimit(gas, tx.tx.safeTxGas), fees, owner, nonce: tx.tx.nonce };
  }

  /** Funds the key if needed, then signs and sends. Inclusion and the sweep are followed by `execution`. */
  private async sendExecution(prepared: Awaited<ReturnType<SignerSession["prepareExecution"]>>): Promise<void> {
    const { chain, executionRpcUrl, gasFunding, publicClient } = this.options;
    const { record, state, data, from, gasLimit, fees, owner, nonce } = prepared;
    const { account } = owner;
    const step = (id: ExecutionStepId, patch: Partial<ExecutionStep>) => {
      const found = record.steps.find((candidate) => candidate.id === id);
      if (found) Object.assign(found, patch);
    };

    if (gasFunding) {
      step("gas", { status: "active", detail: "checking your key's balance" });
      const funding = await this.fund(from, (gasLimit + SWEEP_GAS_ALLOWANCE) * fees.maxFeePerGas, () =>
        step("gas", { detail: "sending gas from your gas account, waiting for it to be mined" }),
      );
      record.funding = funding;
      step("gas", funding ? { status: "done", detail: `${formatEther(BigInt(funding.amount))} ETH from your gas account`, transactionHash: funding.transactionHash } : { status: "skipped", detail: "your key already holds enough" });
    }

    step("send", { status: "active", detail: "signing" });
    const wallet = createWalletClient({ account, chain, transport: http(executionRpcUrl) });
    // The account nonce is pinned so a speed-up can replace exactly this transaction.
    const accountNonce = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
    const request = { to: state.safe, data, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    const signed = this.logSigned(owner, nonce, record.safeTxHash, "execute");
    let transactionHash: Hex;
    try {
      transactionHash = await wallet.sendTransaction({ ...request, nonce: accountNonce, chain });
    } catch (error) {
      this.unlogSigned(signed);
      throw error;
    }
    Object.assign(record, { transactionHash, sentAt: new Date().toISOString(), status: "pending" });
    step("send", { status: "done", detail: undefined, transactionHash });
    step("include", { status: "active", detail: "waiting for a block" });
    const entry = this.executions.get(record.safeTxHash.toLowerCase())!;
    entry.sentAtMs = Date.now();
    entry.accountNonce = accountNonce;
    entry.request = { ...request, gas: request.gas.toString(), maxFeePerGas: request.maxFeePerGas.toString(), maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString() };
    this.executions.set(transactionHash.toLowerCase(), entry);
    this.saveAttempts();
    if (gasFunding) void this.sweepWhenMined(transactionHash);
  }

  /**
   * Resends an execution that has not landed: the same transaction from the same key and account nonce with higher
   * fees, so at most one of the two can ever be mined. Works after a restart and through a changed execution RPC.
   */
  speedUp(safeTxHash: Hex): Promise<Execution> {
    return this.exclusive(async () => {
      const attempt = this.openAttempt(safeTxHash);
      if (!attempt?.request || attempt.accountNonce === undefined) throw new Error("no execution of this transaction is out from this signer");
      const { record, request } = attempt;
      await this.execution(record.safeTxHash);
      if (record.status !== "pending" && record.status !== "stuck") throw new Error("this execution is already final");
      const { chain, executionRpcUrl, publicClient } = this.options;
      const account = await this.attemptAccount(attempt);
      const fees = await publicClient.estimateFeesPerGas();
      const bump = (previous: bigint) => (previous * SPEED_UP_BUMP.numerator) / SPEED_UP_BUMP.denominator + 1n;
      const maxFeePerGas = fees.maxFeePerGas > bump(BigInt(request.maxFeePerGas)) ? fees.maxFeePerGas : bump(BigInt(request.maxFeePerGas));
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > bump(BigInt(request.maxPriorityFeePerGas)) ? fees.maxPriorityFeePerGas : bump(BigInt(request.maxPriorityFeePerGas));
      const wallet = createWalletClient({ account, chain, transport: http(executionRpcUrl) });
      const transactionHash = await wallet.sendTransaction({ to: request.to, data: request.data, gas: BigInt(request.gas), maxFeePerGas, maxPriorityFeePerGas, nonce: attempt.accountNonce, chain });
      record.previousHashes = [...(record.previousHashes ?? []), record.transactionHash!];
      record.transactionHash = transactionHash;
      record.sentAt = new Date().toISOString();
      record.status = "pending";
      record.message = undefined;
      record.sentThrough = new URL(executionRpcUrl).host;
      const step = record.steps.find((candidate) => candidate.id === "send");
      if (step) Object.assign(step, { label: `Sent again via ${record.sentThrough}`, transactionHash });
      const include = record.steps.find((candidate) => candidate.id === "include");
      if (include) Object.assign(include, { status: "active", detail: "waiting for a block" });
      attempt.sentAtMs = Date.now();
      attempt.request = { ...request, maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString() };
      this.executions.set(transactionHash.toLowerCase(), attempt);
      this.saveAttempts();
      return record;
    });
  }

  /** The key an attempt was sent from, derived again after a restart. */
  private async attemptAccount(attempt: Attempt): Promise<LocalAccount> {
    if (attempt.account) return attempt.account;
    const tree = this.options.tree;
    const path = treeKeyPath(tree, attempt.index);
    attempt.account = await this.options.source.signer(path.account, path.index, path.branch);
    return attempt.account;
  }

  /**
   * Stages this signer's next keys from their tree until the guard's buffer is full, sent and paid by the gas account
   * (staging is permissionless, and the gas account is not an owner). Returns undefined when the buffer is already full.
   */
  refill(): Promise<Refill | undefined> {
    return this.exclusive(async () => {
      const { publicClient, chain, source } = this.options;
      const { state, owner, ownerError } = await this.snapshot();
      if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
      const slot = owner.slot;
      const count = Math.min(state.bufferSize - slot.staged.length, slot.unstaged);
      if (count <= 0) return undefined;
      this.loadedTree ??= loadTreeFile(JSON.stringify(this.options.tree));
      const { file, tree } = this.loadedTree;
      if (file.root !== slot.root) throw new Error("the slot's root on-chain is not your tree's; join the Safe again");

      const candidates = stageEntries(tree, file, slot.nextStageIndex, count);
      const used = await this.checker().used(candidates.map((entry) => entry.owner), { ownSafe: state.safe });
      const firstUsed = candidates.findIndex((entry) => used.some((key) => key.address === entry.owner));
      const entries = firstUsed < 0 ? candidates : candidates.slice(0, firstUsed);
      if (entries.length === 0) {
        throw new Error(`key ${candidates[0]!.index} was already used on ${used[0]!.networks.join(", ")}; skip past it (Overview, Skip used keys)`);
      }
      const call = guardCalls.stage(state.guard, state.safe, slot.slotId, entries);
      const gasAccount = await source.signer(OPERATOR_ACCOUNT);
      let gas: bigint;
      try {
        gas = await publicClient.estimateGas({ account: gasAccount.address, to: call.to, data: call.data });
      } catch (error) {
        throw new Error(`staging would fail: ${describeRevert(error) ?? (error as Error).message}`);
      }
      const [balance, fees] = await Promise.all([publicClient.getBalance({ address: gasAccount.address }), publicClient.estimateFeesPerGas()]);
      if (balance < gas * fees.maxFeePerGas) {
        throw new Error(`your gas account ${gasAccount.address} needs about ${formatEther(gas * fees.maxFeePerGas)} ETH to stage your next keys`);
      }
      const wallet = createWalletClient({ account: gasAccount, chain, transport: custom(publicClient) });
      const transactionHash = await wallet.sendTransaction({ to: call.to, data: call.data, gas: (gas * 12n) / 10n, chain });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") throw new Error(`staging reverted (${transactionHash})`);
      return { transactionHash, count: entries.length, fromIndex: slot.nextStageIndex };
    });
  }

  /** Refills when the buffer has room for several keys; records the outcome for the dashboard. Never throws. */
  async autoRefill(): Promise<Refill | undefined> {
    try {
      const { state, owner } = await this.snapshot();
      if (!owner) return undefined;
      await this.checkKeys(state, owner);
      const free = state.bufferSize - owner.slot.staged.length;
      if (owner.slot.unstaged === 0 || free === 0) return undefined;
      if (free < REFILL_FREE_PLACES && owner.slot.staged.length > 0) return undefined;
      const refill = await this.refill();
      if (refill) this.lastRefill = { at: new Date().toISOString(), refill };
      return refill;
    } catch (error) {
      this.lastRefill = { at: new Date().toISOString(), error: (error as Error).message };
      return undefined;
    }
  }

  /** Switches to a renewed key list once a renewal executed (the slot's root on-chain is that list's root). */
  private adoptRenewedTree(state: SafeState): void {
    const { tree, candidateTrees } = this.options;
    const onChain = state.slots.find((slot) => slot.slotId === tree.slotId)?.root;
    if (!onChain || onChain === tree.root) return;
    const renewed = candidateTrees?.find((candidate) => candidate.root === onChain);
    if (!renewed) return;
    this.options.tree = renewed;
    this.loadedTree = undefined;
    this.options.candidateTrees = candidateTrees!.filter((candidate) => candidate !== renewed);
    this.options.onTreeChange?.(renewed);
  }

  /**
   * Builds a renewal of this signer's key list: derives the next generation of the Safe's two-level path, starts at
   * its first run of unused keys, and returns the proposal (`setRoot` plus staging, one transaction) with the new tree,
   * which is kept as a candidate until the renewal executes.
   */
  async renewKeys(onProgress?: (done: number, total: number) => void, size = DEFAULT_TREE_SIZE): Promise<{ input: ProposalInput; tree: TreeFile }> {
    const { state, owner, ownerError } = await this.snapshot();
    if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
    const { tree: current, source, safe } = this.options;
    const chainId = state.chainId;
    let generation = 0;
    for (let g = 0; g < MAX_KEY_GENERATIONS; g++) {
      const path = safeKeyPath(chainId, safe, g);
      if (current.pathTemplate === BRANCH_PATH_TEMPLATE && current.base === path.account && current.branch === path.branch) generation = g + 1;
    }
    if (generation >= MAX_KEY_GENERATIONS) throw new Error("this slot has used every key list generation; set a new root manually");
    const path = safeKeyPath(chainId, safe, generation);
    const tree = await generateTree(source, { chainId, safe, slotId: owner.slot.slotId, base: path.account, branch: path.branch }, size, onProgress);
    const start = await this.checker().firstUnusedRun((index) => tree.addresses[index], 0, state.bufferSize + 1);
    if (start === undefined) throw new Error("could not find unused keys at the start of the new list");
    const loaded = loadTreeFile(JSON.stringify(tree));
    const input: ProposalInput = {
      kind: "renew-keys",
      slotId: owner.slot.slotId,
      root: tree.root,
      size: tree.size,
      startIndex: start,
      stage: stageEntries(loaded.tree, loaded.file, start, state.bufferSize),
    };
    this.options.candidateTrees = [...(this.options.candidateTrees ?? []), tree];
    return { input, tree };
  }

  private checker(): KeyChecker {
    return (this.options.keyChecker ??= new KeyChecker([this.options.publicClient]));
  }

  /** The tree address at `index`, if the tree has one. */
  private treeAddress(index: number): Address | undefined {
    return this.options.tree.addresses[index];
  }

  /** Checks the current key, the staged keys and the next unstaged ones for use elsewhere; the result feeds status. */
  private async checkKeys(state: SafeState, owner: CurrentOwner): Promise<void> {
    const slot = owner.slot;
    const firstStaged = slot.nextStageIndex - slot.staged.length;
    const indexes = Array.from({ length: slot.staged.length + Math.min(state.bufferSize, slot.unstaged) }, (_, i) => firstStaged + i);
    const addresses = indexes.map((index) => this.treeAddress(index)).filter((address): address is Address => address !== undefined);
    // The current key is an owner of this Safe by design, so only its nonce is checked.
    const [used, current] = await Promise.all([
      this.checker().used(addresses, { ownSafe: state.safe }),
      this.checker().used([owner.account.address], { checkOwners: false }),
    ]);
    this.keyAlert = {
      usedKeys: used.map((key) => ({ ...key, index: indexes[addresses.indexOf(key.address)]! })),
      currentKeyUsed: current[0]?.networks,
    };
  }

  /**
   * A proposal that moves this signer's slot past every used key among its staged and upcoming keys, and stages the
   * next run of fresh keys in the same transaction (skipping empties the slot's buffer).
   */
  async skipUsedKeysInput(): Promise<ProposalInput> {
    const { state, owner, ownerError } = await this.snapshot();
    if (!owner) throw new Error(ownerError ?? "your current owner key could not be resolved");
    await this.checkKeys(state, owner);
    const used = this.keyAlert?.usedKeys ?? [];
    if (used.length === 0) throw new Error("none of your staged or upcoming keys was used elsewhere");
    const from = Math.max(...used.map((key) => key.index)) + 1;
    const start = await this.checker().firstUnusedRun((index) => this.treeAddress(index), from, state.bufferSize);
    if (start === undefined) throw new Error("no run of fresh keys left in your key list; it needs renewing");
    this.loadedTree ??= loadTreeFile(JSON.stringify(this.options.tree));
    const { file, tree } = this.loadedTree;
    return { kind: "skip-keys", slotId: owner.slot.slotId, index: start, stage: stageEntries(tree, file, start, state.bufferSize) };
  }

  /** Checks every `intervalMs` and refills as needed until the returned function is called. */
  startAutoRefill(intervalMs = 60_000): () => void {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      await this.autoRefill();
      running = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
  }

  /** Tops `key` up from the operator account to `needed` wei, waiting until the transfer is mined. */
  private async fund(key: Address, needed: bigint, onSending?: () => void): Promise<Execution["funding"]> {
    const { publicClient, chain, source } = this.options;
    const balance = await publicClient.getBalance({ address: key });
    if (balance >= needed) return undefined;
    const amount = needed - balance;
    const operator = await source.signer(OPERATOR_ACCOUNT);
    // Funding a never-used key creates its account, which some networks price far above 21,000 gas.
    const [operatorBalance, gasPrice, transferGas] = await Promise.all([
      publicClient.getBalance({ address: operator.address }),
      publicClient.getGasPrice(),
      publicClient.estimateGas({ account: operator.address, to: key, value: 1n }).catch(() => 250_000n),
    ]);
    const required = amount + transferGas * gasPrice * 2n;
    if (operatorBalance < required) {
      throw new Error(`your gas account ${operator.address} needs about ${formatEther(required)} ETH for this execution and holds ${formatEther(operatorBalance)}; nothing was sent`);
    }
    onSending?.();
    const wallet = createWalletClient({ account: operator, chain, transport: custom(publicClient) });
    const transactionHash = await wallet.sendTransaction({ to: key, value: amount, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error(`funding the execution failed (${transactionHash}); nothing else was sent`);
    return { transactionHash, amount: amount.toString() };
  }

  /** Waits until the execution is mined (or given up on), then returns the key's remaining ETH to the operator. */
  private async sweepWhenMined(transactionHash: Hex): Promise<void> {
    const entry = this.executions.get(transactionHash.toLowerCase())!;
    const sweep = entry.record.sweep!;
    try {
      for (;;) {
        const record = await this.execution(transactionHash);
        if (record.status === "success" || record.status === "reverted") break;
        if (Date.now() - entry.sentAtMs > SWEEP_WATCH_MS) {
          sweep.status = "failed";
          sweep.message = "The execution was not mined; the key keeps its gas for the next attempt.";
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_MS));
      }
      await this.sweep(await this.attemptAccount(entry), sweep);
    } catch (error) {
      sweep.status = "failed";
      sweep.message = (error as Error).message;
    }
  }

  /**
   * Sends everything `key` holds to the operator account. A legacy transaction with its gas limit set to the estimate
   * costs exactly limit × price, so the key is left at zero. Waits for the transfer and reports a revert as a failure.
   */
  private async sweep(key: LocalAccount, sweep: NonNullable<Execution["sweep"]>): Promise<void> {
    const { publicClient, chain, source } = this.options;
    const operator = await source.address(OPERATOR_ACCOUNT);
    const [balance, gasPrice, gas] = await Promise.all([
      publicClient.getBalance({ address: key.address }),
      publicClient.getGasPrice().then((price) => (price * 12n) / 10n),
      publicClient.estimateGas({ account: key.address, to: operator, value: 1n }),
    ]);
    const cost = gas * gasPrice;
    if (balance <= cost) {
      sweep.status = "nothing";
      return;
    }
    const wallet = createWalletClient({ account: key, chain, transport: custom(publicClient) });
    const amount = balance - cost;
    const hash = await wallet.sendTransaction({ to: operator, value: amount, gas, gasPrice, type: "legacy", chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      Object.assign(sweep, { status: "failed", transactionHash: hash, message: "the transfer back to your gas account reverted" });
      return;
    }
    Object.assign(sweep, { status: "sent", transactionHash: hash, amount: amount.toString() });
  }

  /** Current status of an execution this signer sent. */
  async execution(hash: Hex): Promise<Execution> {
    const entry = this.executions.get(hash.toLowerCase());
    if (!entry) throw new Error(`no execution ${hash} was started by this signer`);
    const { record, sentAtMs } = entry;
    const step = (id: ExecutionStepId, patch: Partial<ExecutionStep>) => {
      const found = record.steps.find((candidate) => candidate.id === id);
      if (found) Object.assign(found, patch);
    };
    const syncSweep = () => {
      const sweep = record.sweep;
      if (!sweep || sweep.status === "waiting") return;
      if (sweep.status === "sent") step("sweep", { status: "done", detail: `${formatEther(BigInt(sweep.amount ?? "0"))} ETH back to your gas account`, transactionHash: sweep.transactionHash });
      else if (sweep.status === "nothing") step("sweep", { status: "skipped", detail: "nothing left to return" });
      else step("sweep", { status: "failed", detail: sweep.message });
    };
    if (!record.transactionHash || record.status === "failed" || record.status === "replaced") return record;
    if (record.status === "success" || record.status === "reverted") {
      syncSweep();
      return record;
    }

    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> | undefined;
    for (const candidate of this.hashesOf(record)) {
      receipt = await this.options.publicClient.getTransactionReceipt({ hash: candidate }).catch(() => undefined);
      if (receipt) {
        if (candidate !== record.transactionHash) {
          // An earlier send won the race: it is the execution; the speed-up can never be mined.
          record.previousHashes = this.hashesOf(record).filter((other) => other !== candidate);
          record.transactionHash = candidate;
          step("send", { transactionHash: candidate });
        }
        break;
      }
    }
    if (receipt) {
      record.gasUsed = receipt.gasUsed.toString();
      if (receipt.status === "success") {
        record.status = "success";
        // From the receipt's own logs: a load-balanced RPC may not have caught up with the receipt's block yet.
        record.rotated = parseEventLogs({ abi: rotationGuardAbi, eventName: "OwnerRotated", logs: receipt.logs })
          .filter((log) => isAddressEqual(log.args.safe, this.safe))
          .map((log) => ({ slotId: Number(log.args.slotId), from: log.args.oldOwner, to: log.args.newOwner }));
        record.message = undefined;
        step("include", { status: "done", detail: `block ${receipt.blockNumber}, ${receipt.gasUsed.toLocaleString("en-US")} gas` });
        step("rotate", { status: "done", detail: record.rotated.map((change) => `slot ${change.slotId}`).join(", ") || "none" });
        if (record.sweep?.status === "waiting") step("sweep", { status: "active", detail: "sending the rest back" });
      } else {
        record.status = "reverted";
        record.message = "The transaction was mined but reverted: its signatures are public and nobody rotated. Replace the keys that signed it now.";
        step("include", { status: "failed", detail: "mined but reverted" });
        step("rotate", { status: "failed", detail: "nobody rotated" });
      }
      syncSweep();
      this.saveAttempts();
      return record;
    }

    if (record.status === "stuck") {
      // Not mined, and the Safe moved past its nonce: another transaction took its place (a recovery, or a resend by another signer).
      const state = await readSafeState(this.options.publicClient, this.safe);
      if (state.nonce > BigInt(entry.nonce)) {
        record.status = "replaced";
        record.message = `Another transaction used nonce ${entry.nonce}, so this one can never be mined.`;
        step("include", { status: "skipped", detail: "replaced by another transaction" });
        step("rotate", { status: "skipped" });
        this.saveAttempts();
        return record;
      }
    }
    const timeout = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    if (Date.now() - sentAtMs > timeout && record.status !== "stuck") {
      const minutes = Math.round(timeout / 60_000) || 1;
      step("include", { detail: `still waiting for the network after ${minutes} minute${minutes === 1 ? "" : "s"}` });
      record.status = "stuck";
      record.message =
        `Still waiting for the network: not included after ${minutes} minute${minutes === 1 ? "" : "s"} through ${record.sentThrough}. It may still land. ` +
        "Speed up sends it again with a higher fee; if it never lands, replace the keys that signed it.";
      this.saveAttempts();
    }
    return record;
  }

  private evaluate(state: SafeState, tx: PendingTx, queue: readonly PendingTx[], owner: CurrentOwner): Verdict {
    return evaluate({
      state,
      pending: tx,
      queue,
      exposed: this.exposures(state, queue).exposed,
      openAttempt: this.hasOpenAttempt(),
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
