# Rotating Multisig: Plan

Status: phases 1-3 done, phase 4 (Safe App) in progress. Last updated 2026-10-08.

## 0. Progress

| Phase | State | Where |
|---|---|---|
| 1. Spec and threat model | Done | this file |
| 2. Contracts | Done, pending external audit | `src/`, `test/` (127 Solidity tests: unit, mainnet fork, fuzz, invariants, gas budgets; mutation-tested) |
| 3. Generator CLI | Done; Ledger mode still needs one run on a real device | `generator/` (26 TypeScript tests), cross-checked by `test/GeneratorVector.t.sol` |
| Demo | Done | `demo/run.sh`: Anvil mainnet fork, real Safe 1.5.0 contracts, 2-of-3 Safe rotating through generated trees |
| 4. Safe App and rotation signer | In progress: 4a-4d done (shared core, app shell, dashboard, setup wizard); Sepolia validation under way (guard deployed, Safe and trees ready), then 4i rotation signer | `app/`, `packages/core/`, `deployments/sepolia.json` (see section 12) |
| 5-8 | Not started | |

How to run everything:

- `forge test`: Solidity suite. Fork tests read `MAINNET_RPC_URL` from `.env` (gitignored) and skip without it.
- `cd generator && npm test`: TypeScript suite.
- `./demo/run.sh` (`KEEP=1` to leave Anvil running): end-to-end rotation on a local mainnet fork.
- `npm test` at the root: TypeScript suites for `packages/core` (including an integration test on a throwaway Anvil) and `generator/`.
- `npm run dev -w app`, then `http://localhost:5173/?rpc=http://127.0.0.1:8545&safe=<demo Safe>`: the Safe App dashboard against the demo.

Findings that changed the design during implementation:

- Re-committing an old tree at a low index would bring back already-exposed owners. Fixed with a per-root consumed-index mark (section 6). Found by the invariant suite.
- Without `to == safe`, any transaction carrying `setGuard(0)` calldata would bypass rotation. The check was already present; mutation testing showed no test pinned it, now one does.
- Measured rotation overhead is 65-82k gas per signer, not the 40-50k first estimated (section 6).
- Addresses depend only on the seed and account index, not on the Safe, so every Safe needs its own unused `--base` range (`generator/README.md`).
- Sepolia's hardfork of early October 2026 reprices contract and state creation. Deploying the guard costs 16,697,418 gas there (2.38M on mainnet today), 99.5% of the 2^24 per-transaction cap. Mainnet is likely to adopt the same rules, so the guard must not grow; any new on-chain feature (including the phase 7 co-signer) needs a size budget, and rotation gas must be re-measured under the new rules. The setup transaction for a 2-of-3 estimates at 4.4M gas on Sepolia.
- Under the same rules, a 2-of-3 transfer that rotates both signers used 649,233 gas on Sepolia, about 3.3x the 197k measured locally under Prague rules, so roughly 250-300k per rotated signer. The cost is dominated by the two storage entries each rotation creates (Safe's owner list entry and the guard's `ownerToSlot`). Candidate optimization: drop `ownerToSlot` and find a signer's slot by scanning the 2-5 slots, removing one new storage entry per rotation and shrinking the contract.

## 1. Background and threat model

The concern is that ECDSA over secp256k1 may break before Q-day, possibly within months, in the sense of fast private key recovery (for example one week on a large GPU cluster) from a public key. The defensive response proposed publicly is "bunker mode": keep funds behind addresses whose pubkeys have never been revealed, and move to a fresh address as soon as a key signs.

Key facts this design rests on:

- An Ethereum address is a hash of the pubkey. While a key has never signed anything, only the hash is public and the key is safe as long as the hash holds.
- The pubkey becomes public the first time the key signs anything: an on-chain tx, a Safe confirmation, an off-chain message (EIP-712, Permit, SIWE, Snapshot), or an on-chain `approveHash`.
- Exposure is binary. One signature reveals the full pubkey; further signatures give an attacker nothing more (deterministic RFC 6979 nonces rule out nonce-bias attacks). So "leaving more footprint" is not the issue, any footprint is.
- Consequently rotating keys on a timer (for example daily) adds nothing. A key that has not signed has nothing exposed. Rotation must happen per signature, not per day.

Why a multisig is the right container:

- The Safe address holds the funds and never moves. Only its owner set changes.
- An attacker needs a threshold of exposed keys, and must break each one inside the short window before it is rotated out.

Core rule: an owner whose pubkey has been exposed must stop being an owner as quickly as possible, and the system must make it impossible to forget.

## 2. Evolution of the design

1. Owner queue. Commit a list of future addresses on-chain (harmless, they are only hashes) and swap in a new one per tx. Lessons kept from this stage:
   - Swap, don't remove. Keep a normal owner set (for example 2-of-3) and swap, rather than starting with 100 owners at threshold 1.
   - Rotate exactly the owners who signed, not "one signer". Otherwise the exposed key stays live.
   - Enforce with a Guard, not just a multicall, so a forgotten swap reverts instead of silently leaving a key exposed.
   - One queue per signer slot, so each human's custody stays separate.
   - Avoid bricking: a Guard that wrongly reverts locks the Safe, so there must be an escape hatch.
   - Signatures the Guard cannot see (off-chain EIP-1271 messages, `approveHash`) burn the owner, who must be rotated in the next tx.
   - Cost: about 20k gas per stored address, so about 2M gas for 100.
2. Merkle root per signer (chosen). Each signer generates 10,000 addresses offline and only a 32-byte root is stored. Each rotation supplies the next address and its Merkle proof. Effectively unlimited rotations, a one-off setup cost of about 20k gas per slot, and the tree file can be regenerated from the seed.
3. Long term: a hash-based EIP-1271 co-signer (Winternitz/XMSS or SPHINCS+) so that breaking ECDSA alone gets an attacker nothing.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Safe version | 1.5.0 only |
| 2 | Chains | Ethereum mainnet only |
| 3 | Tree size | 10,000 addresses per signer (14 proof levels) |
| 4 | Language for generator and app | TypeScript, sharing one leaf and proof implementation |
| 5 | Staging model | Pre-staged on-chain: a per-slot ring buffer of 5 proven next owners, filled by a permissionless, strictly sequential `stage()`. A keeper we run refills it and tops up gas, funded from the Safe (section 7) |
| 6 | Signature collection | Option A: the public Safe Transaction Service, hardened by the executor rule in section 5 |

## 4. Components

| Component | Runs where | Responsibility |
|---|---|---|
| RotationGuard (one singleton contract, enabled as Guard, Module and Module Guard) | On-chain | Stores a Merkle root per signer slot, records who signed each tx, swaps out exactly those signers after execution, enforces the executor rule, reverts if anything is missing |
| Offline generator (CLI, TypeScript) | Each signer's own air-gapped machine or hardware wallet | Derives N fresh addresses from hardened paths and builds the signer's Merkle tree. Outputs the root and a tree file (addresses and proofs only, never pubkeys or xpubs) |
| Rotation Safe App | Inside Safe{Wallet} (iframe, Safe Apps SDK) | Setup wizard, slot dashboard, staging, exposure tracker, admin actions. Never touches seeds |
| Rotation signer (CLI first) | Each signer's machine, with their seed or Ledger | Confirms and executes queued Safe transactions with the signer's current owner key, so signers never manage per-rotation wallet accounts; enforces the executor rule, simulation and private RPC (section 10) |
| Keeper (TypeScript service we run; a Gelato Web3 Function is an alternative) | VPS or Gelato, non-owner EOA | Refills each slot's staging buffer from the IPFS tree file and tops up incoming owners with gas |
| Hash-based EIP-1271 co-signer (later phase) | On-chain | A second, non-ECDSA required owner |

## 5. Executor rule: the last signer must execute

### Rule

`execTransaction` may only be called by an owner whose signature in the tx is the pre-validated kind (v = 1 with r = `msgSender`). The other threshold-1 signers confirm through the Transaction Service as usual. No relayer, no third-party executor, no arbitrary address.

### Why it helps

- The executor never posts a confirmation. Their pubkey first appears when they broadcast the tx, and the same tx rotates them out.
- So at any time, the public confirmations for a single pending tx reveal at most threshold-1 pubkeys. An attacker who breaks every confirmed key still lacks one, and cannot execute because only an owner can execute and the remaining owner's key is still hidden.
- Every executed tx rotates all of its signers, including the executor.

### Limits and the hardening each needs

1. It does not stop an attacker who already holds threshold exposed keys. Such an attacker controls an owner EOA, can fund it with gas, and can execute from it. Exposure accumulates across:
   - concurrent pending txs (in 2-of-3, tx1 confirmed by A and tx2 confirmed by B means A and B are both exposed, which is a full threshold),
   - abandoned or replaced txs whose confirmers were never rotated,
   - off-chain messages and other signatures.

   The invariant that actually matters is: the number of exposed-but-not-rotated owners must always stay below the threshold. The Guard cannot see off-chain confirmations, so the app enforces it:
   - Policy: one pending tx at a time.
   - The exposure tracker computes the union of all pending confirmers and burned owners, warns at threshold-2 and blocks new confirmations through the app at threshold-1.
   - Abandoned txs trigger an immediate `forceRotate` of their confirmers.
2. The executor must not also have confirmed off-chain. If they did, their key was exposed early and the benefit is lost. The Guard can only see that the executor used v = 1. The app warns if the executor's confirmation exists in the Transaction Service.
3. A top-level revert is the most dangerous failure. If `execTransaction` reverts (for example the Guard reverts because a stage is missing) but the tx is still mined, all threshold pubkeys are now public in calldata and nothing was rotated. Requirements:
   - Always simulate (`eth_call`) before broadcasting.
   - The executor must broadcast through a private, revert-protected RPC (for example Flashbots Protect), which does not include reverting txs and also removes the few seconds of public mempool exposure.
   - If a reverted tx is ever mined anyway, every signer in it is burned and must be force-rotated at once.
4. Gas logistics. The executor's address needs ETH, but freshly rotated-in addresses hold none. Receiving ETH does not expose a pubkey, so:
   - The keeper (or the rotation tx itself, via a transfer appended by the app) tops up each staged next owner with a small gas amount.
   - Optionally use Safe's built-in refund (`gasPrice`, `refundReceiver`) to reimburse the executor.
   - Dust left in rotated-out EOAs is low value and can be swept later.
5. Lost liveness options. Relayers and automation services cannot execute; an owner must be online. Contract owners (the future 1271 co-signer) cannot be `msg.sender`, so the executor must always be an ECDSA owner.
6. On-chain `approveHash` is disallowed. A v = 1 signature from anyone other than `msgSender` relies on an earlier on-chain `approveHash` tx, which exposed that owner before this tx. The Guard rejects it.

## 6. On-chain design (RotationGuard)

### Storage, keyed by Safe address

Slot state lives under a per-Safe epoch, so `initialize` can start over cleanly:

- `slot -> { root, owner, size, nextStageIndex, head, count, buffer[5] }`. The first five fields pack into one storage slot. `nextIndex` (the next owner to rotate in) is derived as `nextStageIndex - count`.
- `buffer[slot]`: a ring buffer of up to 5 next owners, each already proven against the root. Storage slots are never zeroed, so refills after the first fill are non-zero to non-zero writes.
- `ownerToSlot[owner]`, stored as `slotId + 1` so zero means "no slot".
- `consumedUpTo[safe][root]`, outside the epoch: the first index of a root that never held an owner, recorded whenever a root leaves a slot (`setRoot`, `removeSlot`, re-`initialize`). Any later commitment of that root must start at or above it. This closes address reuse: without it, re-committing an old tree at a low index puts already-exposed addresses back in as owners (found by the invariant suite).
- The tree file's IPFS CID is emitted in `SlotConfigured`, not stored.

### Leaf format

`keccak256(keccak256(abi.encode(chainId, safe, slot, index, address)))`

- The double hash prevents second-preimage tricks on internal nodes.
- Binding `chainId` and `safe` prevents a proof from being reused under another Safe.

### Staging

Why stage at all: to rotate a signer, the Guard needs that slot's next address and its Merkle proof, but it only stores the root. The proof cannot be built into each proposal because the proposer does not know who will sign, and the signed Safe tx cannot be changed after confirmations start. Supplying proofs for every slot inside every tx was rejected because it forces every tx through our app and breaks the Safe UI's normal send, WalletConnect dapps and other Safe Apps. Pre-staging keeps the signed tx unchanged, so txs from any interface work.

`stage(safe, slot, entries[])`, with each entry `(index, address, proof)`, is permissionless. For each entry it checks:

- the proof against the slot's root,
- `index == nextStageIndex` (strictly sequential; a permissionless call that could skip would let a griefer stage index 9,999 and burn the tree; only the Safe itself may skip, through an admin function),
- `index < size`,
- `address` is not already an owner, not already in the buffer, and not the zero address, the sentinel or the Safe,
- the buffer is not full (capacity 5).

On rotation the Guard pops the head of each signer's buffer and swaps it in; no proof or external data is needed at execution time.

A stager cannot inject an address (it would fail the proof) or skip indexes, so the worst a malicious or broken stager can do is waste its own gas or fail to stage, which only delays txs until someone else stages. Anyone with the public tree file can stage.

`setRoot` clears the slot's buffer and sets `nextStageIndex` to the new start index.

### `checkTransaction` (receives `msgSender`)

1. Recompute the safeTxHash using `nonce - 1`, since Safe has already incremented the nonce.
2. Require `signatures` to be exactly `threshold * 65` bytes. Extra signatures would be public without being rotated, so they are rejected rather than parsed.
3. Recover every signer, mirroring Safe's `checkNSignatures`:
   - ECDSA,
   - eth_sign (v > 30, prefixed hash),
   - pre-validated (v = 1): allowed only when r = `msgSender`,
   - contract signature (v = 0): rejected for now. With the exact-length rule this branch is unreachable (a contract signature needs dynamic data after the static part); it stays as defense in depth. Phase 7's hash-based 1271 co-signer will need this rule relaxed for flagged non-rotating owners.
4. Executor rule: `msgSender` must be among the signers through v = 1 (Safe has already checked it is an owner).
5. Delegatecall is allowed only to the allowlisted MultiSendCallOnly.
6. Revert if a guarded transaction is already in progress for this Safe (no nested `execTransaction`).
7. Store the signer set in transient storage (EIP-1153), keyed by Safe.

### `checkAfterExecution`

1. Rotate every recorded signer regardless of `success`. A failed inner call still consumed the nonce and exposed the signatures.
2. Signers that are no longer owners (removed or force-rotated earlier in the same transaction) are skipped.
3. Each rotation pops the head of the slot's buffer and calls `execTransactionFromModule(safe, swapOwner(prev, old, next))`, then updates the slot owner and `ownerToSlot`, and emits `OwnerRotated(safe, slot, oldOwner, newOwner, index)`.
4. Revert if any signer's buffer is empty. (The executor's pre-flight simulation must catch this before broadcast; see section 5, limit 3.)
5. Invariant: `getOwners()` equals exactly the set of current slot owners.
6. Invariant: the transaction guard, module guard and module are all still this contract.

### Module guard (Safe 1.5.0)

Set RotationGuard as the module guard as well. It rejects module txs from any module other than itself, which closes the "other modules bypass the guard" hole on-chain. It must allow, and be tested for, its own `execTransactionFromModule` call made from inside `checkAfterExecution` (reentrancy into the Safe during the guard hook).

### Admin functions (callable only by the Safe itself, so they need the threshold)

- `initialize(oldOwners, configs)`: setup, and also a full reset under a new epoch. Records every old slot's consumed indexes first.
- `addSlot(config, threshold)` and `removeSlot(slot, threshold)`, which add or remove the owner through the module.
- `setRoot(slot, root, size, startIndex, cid)`, for an exhausted tree or a signer re-keying. Rejects a start index already consumed under that root.
- `forceRotate(slots[])`, for owners exposed outside the Guard's view. Uses the slot's buffer like a normal rotation.
- `skipTo(slot, index)`, the only way to skip indexes (for example after an address is known to be burned before use). Clears the slot's buffer.

### Restrictions

- Direct `addOwnerWithThreshold`, `removeOwner` and `swapOwner` calls outside the Guard's flow break the owner-set invariant and revert. `changeThreshold` is allowed.
- No other modules (enforced by the module guard).

### Escape hatch

If the tx is exactly `setGuard(address(0))` to the Safe itself (value 0, plain call), both hooks return immediately. This must be explicit: Safe caches the guard address before execution, so `checkAfterExecution` still runs on the old guard after `setGuard(0)`.

The escape tx skips every check, including the executor rule and rotation, because the point of the hatch is to work even if those checks are what is broken. Its signers are exposed and not rotated, so they must be treated as burned. The module guard and module stay installed after escaping; removing them is a follow-up (now unguarded) transaction.

The `to == safe` part matters: without it, any tx carrying `setGuard(0)` calldata to any address would skip rotation (caught by mutation testing).

### Gas estimates

Measured (`test/RotationGuard.gas.t.sol`, before refunds), against an identical unguarded Safe:

| Safe | Unguarded | Guarded | Overhead per signer |
|---|---|---|---|
| 2-of-3 | 67k | 197k | 65k |
| 3-of-5 | 71k | 278k | 69k |
| 7-of-10 | 87k | 608k | 74k |
| 20-of-20 | 139k | 1.79M | 82k |

About 44k of each rotation is two unavoidable zero-to-nonzero writes (Safe's owner list and `ownerToSlot`); the rest is the module call through the module guard, signature recovery and bookkeeping. Overhead grows with owner count because `_prevOwner` re-reads the owner list per rotation; caching the list across rotations is a possible later optimization. No size approaches the block gas limit.

Staging: after the first fill, about 15-20k per address (non-zero SSTORE plus proof calldata and verification). A batch of 5 is roughly 100-120k gas, about 0.0002-0.0005 ETH at 2-4 gwei.

## 7. Keeper and funding

### What the keeper does

A small TypeScript service that we run (on a VPS, or as a Gelato Web3 Function if we prefer not to host it), using a plain non-owner EOA.

1. Watches the Guard's `Rotated(safe, slot, oldOwner, newOwner, index)` events.
2. When a slot's buffer drops below the low-water mark (2 of 5), fetches the slot's tree file from IPFS by its on-chain CID, builds the next proofs and calls `stage` with a batch that refills the buffer.
3. Tops up gas: each slot's current owner must hold enough ETH to execute one rotation tx, so the keeper sends a small amount (for example 0.003 ETH) to each newly rotated-in owner. Receiving ETH does not expose a pubkey.

With a buffer of 5 and a refill at 2, the keeper refills about once every 3 rotations per slot and is not time-critical.

### Who pays

The Safe pays, through the keeper. The keeper EOA is funded from the Safe with a normal tx (for example 0.05 ETH, enough for many rotations). The dashboard shows its balance and warns when low. The keeper's own pubkey being exposed is irrelevant: it has no power over the Safe and holds only a small balance.

Hard rule: an owner must never send stage or top-up txs from an owner address, since that exposes the pubkey outside the rotation flow.

### Keeper down

`stage` is permissionless, so anyone with any non-owner wallet can press "Stage" in the Safe App (which reads the tree from IPFS), and a backup machine can run the same keeper script. The executor's pre-flight check blocks broadcast if any slot's buffer is empty or the executor lacks gas, so the worst case is a delay, never a mined revert that exposes keys.

### Trust model

A compromised keeper can waste its own ETH or stop staging (a delay until someone else stages). It cannot inject owners, skip indexes or move funds.

### Rejected alternative

Having the Guard pull the gas top-up from the Safe automatically during rotation. It adds external calls and failure modes inside the Guard hooks, against the rule of keeping the Guard small so it cannot brick the Safe.

## 8. Exposure paths the Guard cannot see

| Leak | Handling |
|---|---|
| Confirmations posted to the Safe Transaction Service are public before execution | Executor rule keeps a single pending tx below threshold; one pending tx at a time; tracker monitors the union of confirmers |
| Signed but never executed (replaced or rejected nonce) | Signers marked burned; `forceRotate` in the next tx |
| Off-chain messages (EIP-1271 via SignMessageLib, Permit, SIWE, Snapshot) | Burned. Operational rule: owner keys sign Safe txs only |
| An owner EOA that has ever sent a tx (`nonce > 0`) other than as the executor of a rotating tx | Burned |
| A reverted `execTransaction` that was mined | All its signers burned; immediate `forceRotate`; prevented by simulation and a revert-protected private RPC |
| Same owner address used on another chain | Mainnet only for now. Never reuse an owner address elsewhere |

## 9. Off-chain key management

- Hardened derivation only, for example Ledger Live style `m/44'/60'/{base+i}'/0/0`, with a distinct `base` per Safe. Never share an xpub; a non-hardened xpub reveals every child pubkey. Share addresses only.
- Generator modes:
  - Seed on an air-gapped machine: fast, but the seed sits in software.
  - Hardware wallet `getAddress` loop: about 100 ms per address, so roughly 17 minutes for 10,000, and the seed never leaves the device.
  - In both modes the CLI discards pubkeys immediately and outputs addresses only.
- The tree file is not secret and not trusted. It holds only hashes, and a tampered proof fails against the on-chain root. It is pinned to IPFS and its CID is emitted on-chain so anyone can stage.
- The root is the trust anchor. Before setup is signed, each signer compares their slot's on-chain root with their own CLI output. A wrong root committed at setup hands future ownership of that slot to an attacker.
- Lost tree file: regenerate from the seed with the same parameters, which reproduces the same root.

## 10. Safe App and rotation signer

### Safe App features

1. Setup wizard: point to the singleton, register each signer's slot (root, size, CID), then one batch that enables the module, sets the guard and module guard, swaps all current owners to index 0 and stages indexes 1-5 for every slot. Existing owners have almost certainly signed before, so they are treated as exposed.
2. Dashboard: per slot, current owner, index, addresses remaining, buffer depth, gas balance of the current owner, exposure status; keeper balance. Warns below about 10% of the tree remaining, on an empty or low buffer, and on a low keeper balance.
3. Signing helper: tells each signer which derivation index and path to connect for the next signature, and who the designated executor is.
4. Staging: manual "Stage" button that refills buffers from the IPFS tree file using any non-owner wallet (fallback when the keeper is down), and can also add a `stage` call to batches the app builds.
5. Exposure tracker: scans Transaction Service confirmations, message signatures, `ApproveHash` events, owner EOA nonces and the signers of any escape-hatch tx; computes exposed-but-not-rotated owners; warns at threshold-2, blocks at threshold-1; offers one-click `forceRotate`.
6. Executor flow: simulate, check that every signer has a staged next owner with gas, warn if the executor already confirmed off-chain, then broadcast through a private revert-protected RPC.
7. Admin: add or remove a signer, replace a root, force-rotate all, remove the guard (escape hatch).

### Architecture

- Runs as a Safe App inside Safe{Wallet} (Safe Apps SDK). Transactions are proposed into the Safe{Wallet} queue with `sdk.txs.send`, so owners confirm and execute in the normal Safe UI. The app never holds keys.
- Also runs standalone, read-only, against any RPC and Safe address. This is how it is developed and tested against the Anvil demo, since Safe{Wallet} cannot load a local chain.
- Shared logic lives in `packages/core` (npm workspace): the tree format, leaf and proof code moved out of the generator, the RotationGuard ABI, read helpers and calldata builders. The generator and app both depend on it, so there is one implementation of the leaf.
- Tree files come from an upload or from IPFS, using the CID in the `SlotConfigured` event. They are verified on load (root rebuilt from addresses) and against the on-chain root.
- Pending transactions and confirmations come from the Safe Transaction Service API.
- The executor flow cannot choose the RPC Safe{Wallet} broadcasts through. It runs the pre-flight checks and tells the executor to point their wallet at a private, revert-protected RPC (for example Flashbots Protect) before executing.

### Rotation signer (milestone 4i)

The problem: after every signature, a signer's owner address moves to the next address in their tree. Ordinary wallets (Rabby, MetaMask, Ledger Live) are built around a few stable accounts, so every rotation means adding or switching to a new account before the next signature. This is the largest day-to-day cost of the design.

Options considered:

| Option | Verdict |
|---|---|
| Pre-load the next 10-20 tree accounts into the wallet | Stopgap for testing: still a manual switch per signature, wallet clutter, periodic refresh |
| Derive trees on the standard wallet path `m/44'/60'/0'/0/i` from a dedicated seed (or Ledger passphrase wallet), so "Add account" yields the next owner | Not adopted: needs a separate seed per signer per Safe, still a click per rotation, and non-hardened children mean a leaked account xpub would expose every future public key |
| A dedicated signing tool that always signs with the right key | **Chosen** |
| Hash-based co-signer (phase 7) | The long-term exit: owners that do not rely on ECDSA need no rotation |

Design:

- Interface (decided): a local web UI. `rotation-signer` starts a process on the signer's machine that holds the key (seed file or Ledger over USB) and serves a browser UI on `127.0.0.1`. Keys never enter the browser. The session is protected by a random token in the URL fragment, a Host-header check against DNS rebinding, and no cross-origin access.
- Scope of v1 (decided): confirm and execute. Transactions are still created in Safe{Wallet}. v2 adds proposing from the app, signed as the proposer's own confirmation; a fixed non-owner proposer was tested on Sepolia and does not survive rotation (see open questions).
- Layers: browser-safe logic in `packages/core` (Transaction Service client, local EIP-712 SafeTx hashing, action decoding, and a rules engine that decides per transaction and per signer whether Confirm or Execute is allowed and why not); key handling in a Node-only `packages/keys` (seed and Ledger sources moved out of the generator); the server and UI in `signer/`. It is not part of the generator, which stays offline-only; the signer needs network access.
- Key source: the signer's seed file or Ledger, with the same derivation and code as the generator. The signer's tree file identifies their slot; the tool reads the slot's current owner index on-chain and derives exactly that key. The signer never picks an account.
- Safe{Wallet} stays the place where transactions are created and the queue is viewed. Only confirming and executing move into the tool.
- Commands:
  - `status`: my slot, my current owner address and tree index, buffer depth, owner gas, pending transactions and how many confirmations each has.
  - `confirm <safeTxHash>`: fetch the transaction from the Safe Transaction Service, recompute its hash locally from the fields (never trust the service's hash), show a decoded summary, sign the EIP-712 SafeTx hash (on the Ledger, clear-signed where the app supports it) and post the confirmation.
  - `execute <safeTxHash>`: for the last signer. Collect the confirmations, add the executor's pre-validated signature, sort, simulate with `eth_call` from the executor, then broadcast through a private, revert-protected RPC and report the new owners.
- Rules the tool enforces instead of leaving them to memory:
  - never post a confirmation that would exceed `threshold - 1` off-chain confirmations; the last signer must execute;
  - refuse to confirm or execute when any involved slot has an empty buffer, when the transaction's nonce is not next, or when simulation reverts;
  - execute only through the configured private RPC;
  - warn when the exposure tracker's findings (section 8) say exposed-but-not-rotated owners would reach the threshold;
  - never send any other transaction from a tree key.
- Proposing: creating a transaction in Safe{Wallet} needs a current owner or a registered proposer, and an owner's proposal counts as their confirmation. The tool should support proposing from a non-owner proposer account once the Sepolia test shows how proposers behave across rotation (open questions below).

Open questions to settle on Sepolia before mainnet:

- Settled on Sepolia (setup tx `0x7584d52c…9c116799`): Safe{Wallet} creates Safes at 1.5.0 (SafeL2), and batches through MultiSendCallOnly `0xA83c…1836`, the one the guard allows.
- Settled: when the last owner clicks Execute without confirming first, Safe{Wallet} submits their signature as pre-validated (v = 1, `APPROVED_HASH` in the Transaction Service) next to the other confirmation, exactly `threshold` signatures. This is the form the executor rule requires.
- Settled: the 2-of-3 setup transaction used 4,367,352 gas on Sepolia.
- Settled: the first guarded transaction (`0xb163d027…f091fd`, a 2-of-3 transfer) rotated exactly its two signers to tree index 1, matching the generated trees. The Transaction Service accepted a confirmation from an owner rotated in by the previous transaction with no delay.
- Settled: the rotation signer works on Sepolia end to end. Nonce 2 (`0x0edb6cfc…28098d4a`, 662,328 gas) was confirmed from signer 1's app through the real Transaction Service and executed from signer 3's app; both rotated as their trees predict, with no keys imported anywhere.
- Found: Flashbots Protect on Sepolia held the execution privately and never included it (few Flashbots-connected Sepolia builders), and the app waited without a timeout. Resending through the normal RPC worked. Fixes: show the transaction hash immediately with a status and a timeout, and default to the read RPC on Sepolia (Flashbots Protect stays the mainnet default).
- The Transaction Service API has moved to `https://api.safe.global/tx-service/<network>/api/v1/...` (for Sepolia, `sep`); the per-network domains now redirect.
- When more owners confirm than the threshold needs, does Safe{Wallet} include the extra signatures (which the guard rejects)?
- Does Rabby's Safe integration execute with the owner's own pre-validated signature, like Safe{Wallet}?
- Settled, no: registered proposers do not survive rotation. A proposer registered by slot 2's owner (Transaction Service delegate, EIP-712 domain "Safe Transaction Service") proposed nonce 2 with zero owner confirmations, but once that owner rotated out the service deleted the delegate and rejected its next proposal ("not an owner or delegate"). Registering also needs an owner's off-chain signature, which exposes that key. So the rotation signer proposes itself instead: proposing signs as the proposer's own confirmation, which costs no extra exposure.
- How quickly does the Transaction Service accept confirmations from a newly rotated-in owner?

## 11. Testing and assurance

Status: in place for phase 2. Run with `forge test`; fork tests read `MAINNET_RPC_URL` from `.env` (gitignored) and skip without it.

- Unit tests (`test/RotationGuard.t.sol`): rotation, executor rule, every restriction, escape hatch, staging and every admin path.
- Fork tests (`test/RotationGuard.fork.t.sol`): the full unit suite rerun against the canonical Safe 1.5.0 mainnet singleton (`0xFf51A5898e281Db6DfC7855790607438dF2ca44b`), proxy factory (`0x14F2982D601c9458F93bd70B218933A6f8165e7b`) and MultiSendCallOnly (`0xA83c336B20401Af773B6219BA5027174338D1836`) at a pinned block.
- Fuzz (`test/RotationGuard.fuzz.t.sol`):
  - exactly the signers rotate, for any threshold, signer subset and signature type,
  - a differential test of every signature encoding (ECDSA, eth_sign, executor and non-executor pre-validated, relayer executor, appended extra) against a reference model of the executor rule,
  - proofs bound to the chain and the Safe; any tampered proof element, index or address is rejected.
- Invariants (`test/RotationGuard.invariant.t.sol`), with `fail_on_revert` on, over honest executions, staging, every admin path, careless operators re-committing old trees, adversarial Safe transactions, rogue modules and bad signature encodings:
  - every signer of an executed tx leaves the owner set in that tx,
  - no address that ever left the owner set comes back or is staged,
  - the owner set equals the slot owners and the threshold stays valid,
  - buffers stay bounded, ordered and equal to the tree addresses,
  - honest staging never fails, dishonest staging never succeeds,
  - no adversarial action succeeds and ETH only leaves through honest transfers,
  - hooks stay installed,
  - liveness: the escape hatch always works, and owners can always execute after a refill.
  `test/HandlerCoverage.t.sol` asserts the handler really exercises every admin path.
- Gas budgets (`test/RotationGuard.gas.t.sol`): per-signer overhead regression limits from 2-of-3 to 20-of-20.
- Mutation testing: 35 mutants that each delete or weaken one safety check. 34 are killed; the survivor is the unreachable v = 0 branch described in section 6.

Still to do:

- Optional coverage-guided campaign with Echidna/Medusa.
- External audit before any mainnet value, then a low-value mainnet canary.

## 12. Phases

1. Spec and threat model (this document).
2. Contracts: RotationGuard, Foundry tests, fuzz and invariant suite. Done, pending audit.
3. Generator CLI (TypeScript): both modes, tree file format, shared leaf and proof library. Done in `generator/`, cross-checked against the contract.
4. Safe App: setup, dashboard, staging, exposure tracker, executor flow, admin. In progress, in milestones:
   - 4a. `packages/core`: shared tree code, guard ABI, read helpers, calldata builders and revert decoding. Done; 24 tests including an integration run on a local chain.
   - 4b. App shell: Vite + React + TypeScript, Safe Apps SDK connection, standalone read-only mode. Done.
   - 4c. Dashboard: slots, owners, tree progress, buffers, owner gas, warnings. Done (keeper balance waits for phase 5, when the keeper has an address).
   - 4d. Setup wizard: load tree files, check roots, propose the install batch. Done (validation in `packages/core/src/setup.ts`).
   - 4e. Staging: refill buffers from tree files, from a non-owner wallet or inside a batch.
   - 4f. Exposure tracker: Transaction Service confirmations, `ApproveHash` events, owner nonces, escape-hatch signers; one-click `forceRotate`.
   - 4g. Executor pre-flight: simulate the next transaction with the executor's signature, check buffers and gas, warn on prior confirmation, point to a private RPC.
   - 4h. Admin: add or remove a slot, replace a root, skip indexes, escape hatch.
   - 4i. Rotation signer: local web UI that confirms and executes with the signer's current owner key (section 10). In progress:
     - 4i-1. Core: Transaction Service client, SafeTx hashing checked against the contract, action decoding, rules engine.
     - 4i-2. `packages/keys`: seed and Ledger sources shared with the generator; resolve the current owner key from tree file and chain.
     - 4i-3. Local server and JSON API (status, queue, confirm, execute) with token, Host check and private-RPC execution. Done, with the `rotation-signer` CLI (Flashbots Protect by default).
     - 4i-4. React UI: identity header, decoded queue, one action per transaction with blocking reasons, pre-flight checklist. Done (`signer/ui`; `npm run demo -w signer` runs it locally).
     - 4i-5. End-to-end tests on a local chain with three signer instances: done (`signer/test/e2e.test.ts`), and a Sepolia run with the real Transaction Service: done.
     - 4i-6. Desktop app (Electron 44): same UI, talking to the signing process over IPC instead of HTTP (no port, no token), with a setup screen and an all-signers view. Done for seed files; Ledger in the desktop app needs the USB library rebuilt for Electron. Packaging and code signing are not done.
   - 4j. One app for each signer, from onboarding to daily use (decided 2026-10-08). The desktop app becomes the main interface; Safe{Wallet} is an optional viewer. Each signer runs their own copy holding only their own keys; signers share only public data (chain, Transaction Service queue, slot packages).
     - Decisions: seeds live in an encrypted vault in the app's data folder (scrypt + AES-256-GCM, password unlock each launch), with Ledger as the hardware alternative; slot packages travel by copy-paste or file; external wallets are limited to seed and Ledger (tree keys need one of them); v1 proposals cover ETH and ERC-20 transfers plus guard admin actions.
     - Accounts: the seed's standard first account is the signer's operator account (their initial owner, which stops being an owner at install) and pays for staging and gas top-ups; tree accounts are only ever used as owners.
     - 4j-1. Wallet vault: import or unlock, replacing seed files in the desktop app. Done (`signer/desktop/vault.ts`).
     - 4j-2. Join a Safe. Done for Safes that already have the guard: the signer enters only seed, password and Safe address; the app detects the network, finds the signer's slot by matching the key at each slot's current tree index, rebuilds the tree and checks it against the on-chain root (`signer/src/join.ts`), using public RPCs by default. Tree ranges now start at a base derived from chain and Safe (`defaultBase` in core; the generator defaults to it too), with 100,000 tried as a fallback for the first Sepolia test Safe. Still to do for brand-new Safes: generate the tree for the signer's future slot and export a slot package.
     - 4j-3. Coordinator install: import every slot package, check roots and bindings, propose and execute the setup from the app.
     - 4j-4. Self-staging and gas: the app stages its own slot's next keys and tops up its current owner from the operator account, automatically when low.
     - 4j-5. Propose in the app: transfers and guard admin, signed as the proposer's own confirmation. Done for ETH and ERC-20 transfers and force-rotating chosen slots (`buildProposal` in core, `SignerSession.propose`, New transaction on the Transactions page); a proposal needs threshold 2 or more and an empty queue, is checked by the same rules as a confirmation, and is posted to the Transaction Service with the proposer's signature. Proposers (delegates) are not used: a delegate dies when the owner who registered it rotates. Other guard admin actions are still to do.
     - 4j-6. Ledger in Electron, then packaging and code signing.
   - Sepolia validation: deploy the guard, create a 2-of-3 Safe in Safe{Wallet} with three independent test signers, install through the app, and settle the open questions in section 10. Test seeds live in `.sepolia/` (gitignored, testnet only).
5. Keeper: buffer refills and gas top-ups.
6. Audit, then mainnet canary.
7. Hash-based EIP-1271 co-signer (path out of bunker mode).
8. Optional hardening: private signature collection through a standalone signing app (option B), which removes the Transaction Service exposure window entirely.
