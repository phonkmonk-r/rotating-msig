# Architecture

How the rotating multisig works, from the big picture down to each package, file and function. PLAN.md is the design history and progress log; this file describes the system as it is built today.

## 1. The big picture

### The problem

A Safe is controlled by owner keys. Every time an owner signs, its signature reveals its public key, and an attacker who can derive a private key from a public key (the "harvest now, decrypt later" or quantum threat) could take that key over. An address alone reveals nothing: it is a hash of the public key.

### The idea

Use every owner key exactly once. The moment a key signs a Safe transaction, it is replaced by a fresh key that has never signed anything. Those fresh keys are committed in advance, so nobody (not even an attacker who just broke the old key) can choose what replaces it.

Concretely:

1. Each signer derives a long list of fresh addresses from their seed or Ledger (by default 10,000), one per future use. That list is their **tree**: a Merkle tree whose root is committed on-chain. Each signer owns one **slot** in the Safe.
2. The next few addresses of each slot are **staged** in the guard (a ring buffer of 5), each proven against the slot's root.
3. When a Safe transaction executes, the **RotationGuard** contract records who signed it, and after execution swaps every signer for the next staged address of their slot, in the same transaction.
4. The signer's desktop app (**Cicada**) always knows which key is current (it reads the chain), signs with it, refills the staged keys, and pays gas from a separate gas account.

### Actors and pieces

```
                 ┌──────────────────────────── on-chain ─────────────────────────────┐
  Cicada app    │  Safe 1.5.0 proxy ──(guard hooks, module calls)──► RotationGuard  │
  (per signer)   │   owners = current key of each slot             singleton, one per│
  seed or Ledger │                                                  network          │
       │         └───────────────────────────────────────────────────────────────────┘
       │ signs with current key, proposes, executes, stages next keys, pays gas
       ▼
  Safe Transaction Service (off-chain queue of proposals and confirmations, Safe's own API)
```

| Piece | Where | Role |
|---|---|---|
| RotationGuard | `src/` | The contract. Enforces the signing rules and rotates signers in the same transaction. |
| core | `packages/core` | Pure TypeScript shared by everything: tree format, Safe and guard calldata, state reading, rules engine, Transaction Service client, proposals, Safe creation. |
| keys | `packages/keys` | Key sources (seed, Ledger), derivation paths, finding the current owner key, finding a signer's slot. |
| generator | `generator` | Command-line tool that derives a tree file and prints proofs (the original, manual flow). |
| signer | `signer` | Cicada: the signing session (`src`), the desktop app (`desktop`), and its UI (`ui`). Also the `rotation-signer` command-line server. |
| app | `app` | The original Safe App (dashboard and install wizard inside Safe{Wallet}). Superseded by Cicada for daily use, kept for installing through Safe{Wallet}. |
| tests, scripts | `test`, `script`, `demo` | Solidity suites, deployment script, local demo. |

### The life of a Safe

1. **Create or join.** Cicada creates a Safe through Safe's factory and installs the guard (or joins an existing guarded Safe and rebuilds the signer's tree from the seed).
2. **Install.** One Safe transaction: enable the guard as module, set it as transaction guard and module guard, call `initialize` (each slot's root and first owner), stage each slot's next 5 keys, set the threshold.
3. **Use.** A signer proposes a transaction (signing it is their confirmation), other signers confirm, and the last signer executes. Every signer rotates. With threshold 1, the only signer executes directly.
4. **Maintain.** Each Cicada refills its own slot's staged keys from its gas account, skips keys found to be used elsewhere, and admin actions (add or remove signers, threshold) go through the same transaction flow.

## 2. Repository map

```
src/RotationGuard.sol            the contract
src/interfaces/IRotationGuard.sol its interface, structs, events, errors
test/                            Solidity tests (unit, fork, SafeL2, fuzz, invariants, gas, generator vectors)
script/                          DeployGuard (singleton deployment), Demo (local fork demo)
demo/run.sh                      end-to-end local demo on an Anvil mainnet fork
packages/core/                   shared TypeScript logic (no keys, no network beyond a PublicClient)
packages/keys/                   key sources and derivation
generator/                       rotation-tree command-line tool
signer/src/                      the signing session and everything it needs (no Electron)
signer/desktop/                  Electron main process, preloads, vault, profiles, dApp browser
signer/ui/                       React UI (shared by the desktop app and the local web server)
signer/test/                     signer tests on a local Anvil chain with real Safe and guard contracts
signer/ui/test/                  unit tests for the UI's logic (signer/ui/src/lib)
signer/e2e/                      the desktop app driven by Playwright against Anvil and a fake Transaction Service
app/                             the original Safe App
deployments/sepolia.json         deployed addresses on Sepolia
PLAN.md                          design, decisions, progress
```

The TypeScript packages are npm workspaces. Packages export a `source` condition so tests and tools can run the TypeScript directly; `npm run build` compiles them to `dist`.

## 3. The smart contract: RotationGuard

`src/RotationGuard.sol`, Solidity 0.8.30, compiled with `via_ir`, optimizer 200 runs, EVM version Prague. About 10.3 KB of runtime code.

### 3.1 One contract, three roles, one deployment

A Safe 1.5.0 can attach three kinds of extensions. RotationGuard is all three at once for every Safe that installs it:

| Role | Safe calls it | Why it needs it |
|---|---|---|
| **Transaction guard** | `checkTransaction` before and `checkAfterExecution` after every `execTransaction` | To see who signed and enforce the signing rules before, and to rotate those signers after. |
| **Module** | Safe executes calls the guard makes through `execTransactionFromModule` | Changing owners is an owner-only operation; as a module the guard can call `swapOwner`, `addOwnerWithThreshold` and `removeOwner` on the Safe. |
| **Module guard** | `checkModuleTransaction` before every module call | So that no other module can ever bypass the guard, and the guard itself can only do owner management. |

It is a **singleton**: deployed once per network (`script/DeployGuard.s.sol`; on Sepolia the current guard is `0x0f91…3391`, the first one `0xbE62…5E36` still serves the earliest Safes), with no owner, no admin and no upgrade path. Every Safe that installs it uses the same code; all per-Safe data is keyed by the Safe's address, and every state-changing function takes the Safe to be `msg.sender` (the Safe calling its own guard) except `stage`, which is permissionless but proof-gated. So one Safe can never touch another Safe's configuration, and creating a Safe never deploys a guard. The only constructor argument is the allowed MultiSendCallOnly address (immutable).

A new version is a new deployment at a new address; a Safe moves to it by removing the old guard (escape hatch) and installing the new one.

### 3.2 Storage layout

```solidity
struct Slot {
    bytes32 root;            // word 0: Merkle root of the slot's tree
    address owner;           // word 1: current owner (20 bytes)
    uint32 size;             //         tree size
    uint32 nextStageIndex;   //         next tree index stage() must use
    uint8 head;              //         ring buffer read position
    uint8 count;             //         staged keys in the buffer
    address[5] buffer;       // words 2-6: staged next owners (ring buffer)
}
struct SafeConfig { uint64 epoch; uint32 slotCount; uint32 activeSlots; }   // one word

mapping(address safe => SafeConfig) _configs;                                                 // storage slot 0
mapping(address safe => mapping(uint64 epoch => mapping(uint256 slotId => Slot))) _slots;     // storage slot 1
mapping(address safe => mapping(bytes32 root => uint32)) _consumedUpTo;                       // storage slot 2
```

- **Packing.** `owner`, `size`, `nextStageIndex`, `head` and `count` share one 32-byte word, so a rotation reads and writes one word for the slot header plus one buffer word.
- **Epoch.** `initialize` bumps the epoch; slots live under `(safe, epoch, slotId)`. Re-initializing therefore starts a fresh set of slots without deleting the old ones (no per-slot cleanup cost), and old slots are simply never read again.
- **`slotCount` and `activeSlots`.** `slotCount` is the number of slot IDs ever handed out in this epoch (IDs are never reused after `removeSlot`); `activeSlots` is how many exist now. `MAX_SLOTS = 32` caps `slotCount` per epoch.
- **No owner-to-slot index.** To find a signer's slot, `_findSlot` scans slot IDs `0..slotCount-1` comparing `owner`. This was a deliberate gas optimization: a mapping from owner to slot would cost one new storage entry (a zero-to-nonzero write) per rotation, which is expensive, especially under Sepolia's state-creation repricing. Scanning 2 to 5 slots costs one cold read each the first time and warm reads after; `MAX_SLOTS` bounds the worst case. Removed slots have `owner == 0` and never match (`_findSlot` rejects the zero address explicitly).
- **`_consumedUpTo[safe][root]`.** The highest tree index of `root` that has ever held ownership for this Safe. Re-committing an old root (via `initialize` or `setRoot`) at a lower start index would bring back keys that have already signed; `_requireUnconsumed` rejects that. Found by the invariant suite.

### 3.3 Transient storage and the assembly

The guard needs to pass the list of signers from `checkTransaction` (before execution) to `checkAfterExecution` (after execution) within one transaction. That is exactly what EIP-1153 transient storage is for: it lives for the transaction only, is cleared automatically at its end, and costs about 100 gas per access instead of thousands for regular storage.

Solidity 0.8.30 has no high-level syntax for transient storage of dynamic data, so the contract uses the two opcodes directly:

```solidity
function _tload(uint256 key) internal view returns (uint256 value) {
    assembly ("memory-safe") { value := tload(key) }
}
function _tstore(uint256 key, uint256 value) internal {
    assembly ("memory-safe") { tstore(key, value) }
}
```

These are the only two assembly blocks. They touch no memory, so they are marked `memory-safe`, which lets the `via_ir` optimizer keep its memory optimizations around them.

The layout, per Safe:

| Transient key | Value |
|---|---|
| `base = keccak256(abi.encode(safe, keccak256("RotationGuard.transaction")))` | state: `TX_NONE` (0), `TX_ACTIVE` (1) or `TX_ESCAPE` (2) |
| `base + 1` | number of signers |
| `base + 2 + i` | signer `i`, as `uint160` |

Keying by Safe means two different Safes executing within one transaction (for example one Safe calling another) do not see each other's signers. The state word also blocks re-entry: a nested `execTransaction` on the same Safe reverts with `NestedExecution`, because a guarded transaction already in progress would otherwise have its signer list overwritten. `checkAfterExecution` zeroes every key it used, so nothing leaks to a later call in the same transaction.

The other low-level detail is `_readAddress`: the guard reads the Safe's guard and module-guard addresses through Safe's own `getStorageAt(slot, 1)` (Safe stores them at fixed hashed slots, `GUARD_STORAGE_SLOT` and `MODULE_GUARD_STORAGE_SLOT`), to verify after every transaction that the hooks are still installed.

### 3.4 A guarded transaction, step by step

**`checkTransaction(to, value, data, operation, …, signatures, msgSender)`**, called by the Safe before executing:

1. Revert `NestedExecution` if this Safe already has a guarded transaction in progress, or if this hook already ran for the Safe's current nonce in this Ethereum transaction (the nonce lock, 3.8). Safe increments its nonce before calling the hook, so a genuine call always sees a fresh nonce; a call replayed from inside the transaction sees the same one.
2. If the transaction is exactly the escape hatch (3.8), mark `TX_ESCAPE` and return: nothing else is checked here.
3. Revert `NotInitialized` if the Safe never called `initialize`.
4. Allow delegatecall only to `MULTI_SEND_CALL_ONLY` (`DelegateCallNotAllowed`). Batches therefore go through MultiSendCallOnly, which cannot itself delegatecall.
5. Require `safeTxGas` and `gasPrice` both non-zero (`SafeTxGasRequired`), and the refund in ETH to the executor: no `gasToken`, no `refundReceiver` (`RefundNotAllowed`). Each closes a way for the whole `execTransaction` to revert after the signatures are public, which would undo the rotation:
   - with both zero, Safe reverts the whole transaction when the inner call fails;
   - with `gasPrice` zero, Safe hands the inner call all remaining gas (63/64 of it reaches the callee), so a callee that burns it leaves too little for `checkAfterExecution`; with `gasPrice` set, Safe caps the inner call at `safeTxGas`;
   - a refund to a receiver that rejects ETH, or in a token that fails, reverts the whole transaction (GS011, GS012); a refund in ETH to `tx.origin`, an account, cannot fail by design.
   Why `gasPrice` matters, what the refund it brings is, how the app pays it, and why this rules out proposing from Safe{Wallet}: section 3.9.
6. Require `signatures.length == threshold * 65` exactly (`UnexpectedSignatureLength`). Extra signatures would be public without being rotated, so they are rejected rather than ignored.
7. Recompute the Safe transaction hash with `nonce - 1` (Safe has already incremented the nonce) and recover each signer the same way Safe does:
   - `v == 0` (contract signature): rejected. With the exact-length rule this is unreachable (a contract signature needs dynamic data after the static part); kept as defense in depth.
   - `v == 1` (pre-validated, "approved hash"): allowed only if the signer is `msgSender`, the account executing. Any other v = 1 signature would rely on an earlier on-chain `approveHash`, which exposed that owner in a separate transaction (`ApprovedHashNotAllowed`).
   - `v > 30`: eth_sign over the prefixed hash.
   - otherwise: plain ECDSA over the hash.
   Safe's own signature check, which runs before this hook, has already verified that every signer is a current owner; a call replayed from inside the transaction with made-up signatures cannot get here (the nonce lock, step 1).
8. **Executor rule:** the executor must be one of the signers, through v = 1 (`ExecutorMustSign`). Sending a transaction exposes the sender's public key, so the sender must be rotated too.
9. Store the signers and their count, set `TX_ACTIVE`.

**`checkAfterExecution(hash, success)`**, called by the Safe after executing:

1. If `TX_ESCAPE`, clear it and return. Only a genuine escape reaches this state (the nonce lock stops a replay from inside a transaction), and its inner call is exactly `setGuard(address(0))`, so there is nothing to check.
2. Read and clear the signer list.
3. For every signer still an owner, find its slot and rotate it, **whether or not the inner call succeeded**: a failed call still used the nonce and exposed the signatures. Signers no longer owners (removed or force-rotated by this very transaction) are skipped. A signer with no slot is `UnmanagedOwner`, unreachable while the owner-set check below holds, pinned by a test that corrupts storage.
4. `_checkOwnerSet`: the Safe's owner list must have exactly `activeSlots` entries and each owner must be some slot's owner. Owners are distinct and each slot has one owner, so with equal counts this is a one-to-one match. Any direct `addOwner`, `removeOwner` or `swapOwner` that bypasses the guard breaks it and reverts the whole transaction.
5. `_checkHooksInstalled`: the guard must still be the transaction guard, the module guard and an enabled module (`HooksRemoved`). Only the escape hatch may remove it.

### 3.5 Rotation and the ring buffer

`_rotate(safe, epoch, slotId)` first drops staged entries that are already owners: staging checks only current owners and the slot's own buffer, so another slot (a malicious signer whose key list includes this slot's next address, or a newcomer's crafted package) can rotate into an address this slot has staged, and rotating into an existing owner would revert every transaction this slot signs. The dropped indexes count as used. It then pops the head of the slot's buffer (`BufferEmpty` if nothing is left), sets `slot.owner` to it, and calls `swapOwner(prev, old, new)` on the Safe as a module. `prev` is found by `_prevOwner`, which walks Safe's linked owner list (`getOwners()`); Safe needs the predecessor to unlink an owner. The new owner's tree index is `nextStageIndex - count` before popping, and `OwnerRotated(safe, slotId, oldOwner, newOwner, index)` is emitted.

The buffer holds 5 addresses (`BUFFER_SIZE`). It exists because rotation happens inside the Safe's transaction, where the guard cannot receive Merkle proofs; proofs are checked earlier, at staging, and rotation just pops a pre-verified address.

### 3.6 Staging and the Merkle leaves

`stage(safe, slotId, entries)` is **permissionless**: anyone may pay to add keys. It is still safe, because every entry must:

- be the slot's next index exactly (`NonSequentialIndex`): no skipping, no reordering;
- be below the tree size (`IndexOutOfRange`);
- not be a current owner, the Safe, the zero address or Safe's sentinel `0x1` (`InvalidOwner`). A key repeated in the tree, or staged by two slots, is not rejected here: rotation skips a staged key that is already an owner when its turn comes (3.5);
- carry a Merkle proof against the slot's root (`InvalidProof`);
- fit in the buffer (`BufferFull`).

The leaf is `keccak256(keccak256(abi.encode(block.chainid, safe, slotId, index, owner)))`. The double hash matches OpenZeppelin's StandardMerkleTree (it prevents second-preimage attacks where an inner node is passed off as a leaf), and binding chain, Safe, slot and index means a tree can only ever be used for the exact slot and position it was made for. `leaf(...)` exposes the same computation so off-chain code can cross-check it (`test/GeneratorVector.t.sol` does).

### 3.7 Admin functions

All are called by the Safe on itself (so they need the Safe's threshold, through a normal guarded transaction), and all but `initialize` require the Safe to be initialized.

| Function | What it does |
|---|---|
| `initialize(oldOwners, configs)` | Setup, and a full reset under a new epoch. Records consumed indexes of every old slot, then for each config creates a slot (root, size, start index, first owner with proof) and swaps `oldOwners[i]` for its first owner. Ends with the owner-set check and the hooks-installed check, so a Safe cannot end up with fresh owners and no rotation. |
| `addSlot(config, newThreshold)` | Creates a slot and adds its first owner with `addOwnerWithThreshold`. |
| `removeSlot(slotId, newThreshold)` | Records consumed indexes, deletes the slot, and removes its owner with `removeOwner`. |
| `setRoot(slotId, root, size, startIndex, cid)` | Replaces a slot's tree (renewal, re-keying). Rejects an already-consumed start index. Empties the buffer. |
| `skipTo(slotId, index)` | Moves `nextStageIndex` forward past keys known to be burned, and empties the buffer. The only way to skip indexes. |
| `forceRotate(slotIds)` | Rotates chosen slots immediately, for keys exposed outside the guard's view. |

`_createSlot` checks the config (`InvalidConfig`), the consumed mark, that the first owner is a valid new owner (every slot owner is a Safe owner, so this also rules out another slot's owner), the `MAX_SLOTS` cap, and the first owner's proof, then emits `SlotConfigured`.

### 3.8 Module guard and escape hatch

`checkModuleTransaction` allows exactly one thing: the guard itself, as module, calling the Safe (no value, plain call) with `swapOwner`, `addOwnerWithThreshold` or `removeOwner`. Every other module, and every other call, reverts `ModuleTransactionNotAllowed`. This closes the "a module can do anything" hole on-chain. `checkAfterModuleExecution` is a no-op.

The escape hatch is a transaction that is exactly `setGuard(address(0))` on the Safe itself (value 0, plain call). Both hooks return immediately for it, so it works even if the guard's own checks are what is broken. Its signers are not rotated, so their keys must be treated as burned. `to == safe` is essential: without it, any transaction carrying that calldata to any address would skip rotation (caught by mutation testing). After the escape, the Safe is a plain Safe; the module and module guard can then be removed by the owners.

The hooks cannot tell the Safe's genuine calls from calls the Safe makes from inside a transaction: a MultiSendCallOnly batch, or a fallback handler, runs with the Safe as `msg.sender`. Such a batch could call `checkAfterExecution` (rotating and resetting the state), change the owners, then call `checkTransaction` with escape-shaped arguments, and the real after-hook would then skip every check. Decoding the payload cannot close this, because of the fallback handler path. The first review's fix snapshotted the owner set in the escape `checkTransaction`, but a batch could change the owners before that call (second review, 2026-10-09). The guard now runs `checkTransaction` at most once per Safe nonce, tracked in transient storage: Safe increments its nonce before calling the hook, so the genuine call always sees a fresh nonce and any replay inside the same Safe transaction sees the same nonce and reverts with `NestedExecution`. The batch then fails as a whole and the real after-hook rotates the signers and checks everything; a lone fake `checkAfterExecution` leaves nothing for the real one (`NoTransactionInProgress`), which reverts the transaction. Pinned by `test/RotationGuard.poc.t.sol`.

### 3.9 Gas price, the gas refund, and why Safe{Wallet} cannot propose

The guard requires every guarded transaction to sign `gasPrice` above zero (step 5 of 3.4). In Safe 1.5.0 that one field controls two things at once, and there is no way to get the first without the second.

1. **How much gas the transaction's call gets.**
   - With `gasPrice` 0, Safe hands the call almost all the remaining gas (63/64 of it reaches the callee). A malicious or broken contract can burn it all, leaving too little to rotate the signers, so the whole transaction reverts with every signature public and nobody rotated. With `safeTxGas` also 0, Safe goes further and re-raises any failure of the call, reverting everything.
   - With `gasPrice` above 0, Safe caps the call at `safeTxGas` and never reverts the whole transaction because the call failed, so the rotation always keeps its gas. This is the property the guard wants.
2. **A gas refund.** Safe's refund feature exists so a relayer can execute a transaction for someone and be paid back. Whenever `gasPrice` is above 0, Safe pays whoever sent the transaction (`tx.origin`) `(gasUsed + baseGas) × min(gasPrice, tx.gasprice)`, out of the Safe's own ETH, after the call. If the Safe cannot pay it, Safe reverts the whole transaction (GS011), which undoes the rotation like any other revert. A refund in a token or to another receiver could fail the same way, so the guard allows neither (`RefundNotAllowed`).

**How the app handles it.** Cicada signs `gasPrice` = 1 wei and `baseGas` = 0, so the refund is gas used × 1 wei, effectively nothing. It sizes `safeTxGas` from a simulation (1.5x, at least 100k) or uses 1M, and sends each execution with a gas limit covering the simulated cost plus the whole `safeTxGas`, so the rotation keeps its gas even if the call uses all of it on-chain. Because `execTransaction` is payable, the executor also sends the most the refund can be, gas limit × `gasPrice`, along with the transaction (`refundCover` in `signer/src/session.ts`):

```
executor ──(gas limit × 1 wei)──▶ Safe
Safe     ──(gas used  × 1 wei)──▶ executor   (the refund)
```

The refund is then covered whatever the Safe holds, an empty Safe included; the difference, (gas limit − gas used) wei, stays in the Safe. Simulations run at gas price 0, where the refund is 0, so they could not catch an unpayable refund themselves: that is how an empty 1-of-1 Safe on Sepolia reverted every execution before this (PLAN.md 4j-22). The escape hatch keeps `safeTxGas` and `gasPrice` at 0: its call (`setGuard(0)`) cannot fail and it needs no refund.

**Why Safe{Wallet} cannot propose.** A proposal is not a description of calls: the proposer signs the exact Safe transaction, and its hash covers every field, `safeTxGas` and `gasPrice` included. Safe{Wallet} proposes with both at 0 (as far as we know it offers no way to set `gasPrice`). The guard rejects such a transaction when it is executed, and Cicada cannot raise the fields afterwards, because any change gives a new hash and voids every signature already collected. So proposals must be made in Cicada, which signs `gasPrice` = 1 wei; Safe{Wallet} still shows the Safe, its balances and its history, and lists Cicada's proposals, since both use the same Transaction Service. Cicada's rules engine marks a proposal with either field at 0 as blocked ("propose it again from this app"). The alternative, accepting 0/0 again and relying on the executor sending through a relay that drops reverting transactions, was considered and set aside: the guard cannot check which RPC was used, testnets have no such relay, and it would bring back the gas-burning case above.

### 3.10 Views and events

`getSlot` returns a slot's root, owner, size, current index (`nextIndex`), next stage index and staged addresses in order. `getConfig` and `leaf` expose the rest; a signer's slot is found off-chain by matching `getSlot(...).owner`, and the consumed marks are enforced on-chain only (`RootIndexConsumed`), both dropped as views to keep the guard under Sepolia's per-transaction deploy gas cap. Events (`Initialized`, `SlotConfigured`, `SlotRemoved`, `OwnerStaged`, `OwnerRotated`, `IndexSkipped`) are what off-chain tools index; Cicada's collision alarm reads `OwnerStaged` and `OwnerRotated` (section 7.2).

### 3.11 Contract tests

| File | What it covers |
|---|---|
| `test/RotationGuard.t.sol` | Unit tests for every rule, error and admin path, plus storage-corruption tests for unreachable branches. |
| `test/RotationGuard.fork.t.sol` | The unit suite against the canonical Safe 1.5.0 mainnet deployments at a pinned block (needs `MAINNET_RPC_URL`). |
| `test/RotationGuard.l2.t.sol` | The unit suite against SafeL2 1.5.0. |
| `test/RotationGuard.fuzz.t.sol` | Fuzzed signatures, orders, indexes and configs. |
| `test/RotationGuard.invariant.t.sol` | Drives a guarded Safe through honest and adversarial sequences; invariants: signers rotate in the same transaction, no exposed key stays an owner, retired keys never return or get staged, owners equal slot owners, buffers consistent, adversarial calls never succeed, hooks stay installed, escape always possible, liveness after refill. |
| `test/RotationGuard.gas.t.sol` | Overhead against an unguarded Safe, with budgets: 2-of-3 about 43.5k gas per signer (local, Prague rules). |
| `test/GeneratorVector.t.sol` | The TypeScript generator's leaves and proofs (`test/vectors`) verified by the contract. |
| `test/HandlerCoverage.t.sol` | Checks the invariant handlers actually reach their paths. |
| `test/utils/` | `RotationFixture` (a guarded 2-of-3 Safe), `MerkleBuilder`, `Actors`, and `QueueMocks` (token and vault for the signer's queue tests). |

Mutation testing (each safety check deleted or weakened in turn) is used to prove tests pin every check; see PLAN.md.

## 4. packages/core: shared logic

No keys and no Electron. Everything that both the UI, the session and the tools need to agree on lives here.

| File | Purpose and main functions |
|---|---|
| `addresses.ts` | Canonical Safe 1.5.0 deployments per network (`DEPLOYMENTS`): singleton, factory, MultiSendCallOnly, creation singleton (SafeL2 on Sepolia, Safe on mainnet, as Safe{Wallet} does), fallback handler, our guard and its deployment block. `deploymentsFor(chainId)`. Safe's guard storage slots. |
| `abi/` | Contract ABIs generated from Foundry artifacts by `scripts/abi.mjs`; `test/abi.test.ts` fails if they drift from the compiled contract. |
| `base.ts` | Where a Safe's keys live in a seed: `safeKeyPath` (two-level path, current), `safeAccount` (one-level per-Safe path), `defaultBase` (ranged path, earliest). See section 8. `DEFAULT_TREE_SIZE` (10,000). |
| `tree.ts` | The tree format. `TreeMeta`/`TreeFile` (chain, Safe, slot, path layout, size, root, addresses; never public keys), path templates and `treeKeyPath(layout, i)`, `leafValue`/`leafHash` (same leaf as the contract), `buildTree`/`createTreeFile`/`loadTreeFile` (the root is always recomputed, never trusted), `proofFor`, `stageEntries`, `slotConfig`. |
| `calls.ts` | Calldata builders. `safeCalls` (enable module, set guards, change threshold, escape) and `guardCalls` (initialize, addSlot, removeSlot, setRoot, skipTo, forceRotate, stage). `encodeMultiSend` and `batch` (wraps calls in one delegatecall to MultiSendCallOnly). `installCalls`/`installTx` (the setup batch). |
| `safetx.ts` | Safe transaction hashing and signatures: `safeTxTypedData`, `safeTxHash`, `preValidatedSignature` (the executor's v = 1), `packSignatures` (sorted by owner, as Safe requires), `execTransactionData`, `plainSafeTx`. |
| `state.ts` | `readSafeState`: owners, threshold, nonce, balance, guard, module guard, whether the guard is fully installed, and every slot (owner, current index, staged keys, unused keys). `assess` turns state into findings (out of staged keys, tree running low, owner needs gas). |
| `decode.ts` | `decodeActions`: turns a Safe transaction into plain-language actions (transfers, token transfers and approvals, Safe and guard admin, escape), unpacking MultiSend batches; flags anything the guard would reject. Each action also carries the call's target, value, data, operation, decoded function name and selector for the details view. `unpackMultiSend`. |
| `rules.ts` | `evaluate` (and `forceRotatedSlots`): the rules engine every Cicada action passes through. Decides confirm, execute or nothing for this signer: transactions in nonce order; at most threshold − 1 off-chain confirmations; the last signer executes; every involved slot has a staged key; confirmations that no longer count (rotated owners) are ignored; no confirmation that would leave a threshold of exposed keys across the queue. |
| `txservice.ts` | Minimal client for Safe's Transaction Service: `pending` (queue, every hash recomputed locally), `propose`, `confirm`. |
| `proposals.ts` | What the app can propose (`ProposalInput`): ETH and ERC-20 transfers, force-rotate, dApp calls, threshold, add and remove signer, escape, skip used keys, and queued batches. `buildProposal` turns each into the Safe call; `dappCall` refuses dApp calls to the Safe or the guard; `batchCalls` flattens a queue into plain calls. |
| `setup.ts` | Installing on an existing Safe: `readGuardInfo`, `validateInstall` (every reason not to install), `planInstall`. `INSTALL_STAGE_COUNT` (5). |
| `create.ts` | Creating a new Safe: invites (`createInvite`, `verifyInvite`, encode and decode), CREATE2 address prediction (`predictSafeAddress`, `safeInitializer`, `creationCall`), slot packages (`createSlotPackage`, `checkPackage`, `verifyPackages`, `packageKeys`), package signatures (`packageMessage`, `packageDigest`, `packageSignedByOperator`, `verifySignedPackages`), and `installFromPackages`. |
| `errors.ts` | `describeRevert`: turns raw revert data into the guard's or Safe's error names. |

## 5. packages/keys: keys and derivation

Keys never leave this package's sources: the seed stays in process memory, Ledger keys stay on the device. No source ever exposes a public key or an extended public key.

| File | Purpose |
|---|---|
| `source.ts` | `AddressSource`: the interface every key source implements (`address(account, index?, branch?)`, `signer(...)`, `close`). `derivationPath`, `OPERATOR_ACCOUNT` (account 0, the gas account). |
| `seed.ts` | `seedSource(mnemonic)`: BIP-39 seed, BIP-32 derivation with @scure, private keys wiped after each signer is built. |
| `ledger.ts` | `ledgerSource`/`openLedgerSource`: the same interface over Ledger's USB transport and Ethereum app. Typed data is signed from its domain and message hashes. Messages may only be signed by the operator account (for slot packages); owner keys refuse them. |
| `owner.ts` | `resolveCurrentOwner(source, tree, state)`: reads the slot's current index from the chain and derives exactly that key, refusing if it is not the on-chain owner. The signer never picks an account; the chain does. |
| `discover.ts` | `discoverSlot`: finds which slot of a Safe belongs to a seed by deriving each slot's current key under each candidate path layout. `generateTree`: derives a full tree with progress. |
| `prompt.ts` | `readSecret`: hidden terminal input for the command-line tools. |

## 6. generator: the rotation-tree command

`generator/src/cli.ts`, the original manual flow, still useful for scripting and audits.

- `generate`: derive a tree for a Safe and slot (two-level path by default, `--layout account|range` for earlier ones), from a seed file or a Ledger, and write the tree file.
- `verify`: rebuild the root, compare it with an expected one, re-derive a sample of addresses.
- `proof`, `entries`, `config`: print a staging entry, a staging batch, or a slot config for `initialize`/`addSlot`.

`scripts/vectors.ts` writes the cross-check vectors used by `test/GeneratorVector.t.sol`. Secrets are never accepted as arguments.

## 7. signer: Cicada

### 7.1 signer/src: the signing session

Everything that signs, proposes, executes and maintains a slot. Runs inside the desktop app's main process or the `rotation-signer` command-line server; no UI code.

| File | Purpose |
|---|---|
| `session.ts` | `SignerSession`, one per Safe a profile signs for. Every action re-reads chain and queue and re-runs the rules engine, so nothing the UI sends can bypass a rule. |
| `create.ts` | `createSession` (wires RPCs, Transaction Service, key checker, and the data directory for the signing log and open executions) and `keyCheckerFor`. |
| `store.ts` | `SessionStore`: where a session keeps `signing-log.json` and `executions.json`. `fileStore` writes them atomically under the Safe's folder in the profile (`sessions/<chain>-<safe>-slot<n>`); `memoryStore` for the command-line server and tests. |
| `join.ts` | `joinSafe`: from a seed and a Safe address alone, finds the network, the slot, the path layout, rebuilds the tree and checks its root on-chain. `keyLayouts` lists where keys may live. `detectChains`, `readClient`. |
| `newsafe.ts` | `planSafe`, `readInvite`, `prepareSlot`, `prepareNewSlot` (being added to an existing Safe), `createSafe` (deploy then install from the creator's gas account). Slot packages start at the first six never-used keys. |
| `keycheck.ts` | `KeyChecker`: a key is used if its nonce is above zero on the Safe's network or mainnet (it signed a transaction), or if the guard already staged or rotated to it for another Safe (searched from the guard's events, in chunks, cached). `firstUnusedRun`. |
| `simulate.ts` | `simulateCalls` (runs calls as the Safe with `eth_simulateV1`, reports outcomes, balance changes and approvals) and `readAfter` (a dApp's read on top of queued calls). |
| `dapp.ts` | `DappProvider`: the wallet dApps see in the built-in browser (section 7.4). |
| `server.ts`, `cli.ts` | The `rotation-signer` command: a local HTTP server with a session token serving the same UI. |
| `networks.ts` | Supported chains, default public RPCs, default execution RPC (Flashbots Protect on mainnet). |

`SignerSession` in more detail:

- **Reading:** `status` (Safe, this signer, every slot, findings, gas account), `queue` (pending transactions with this signer's verdict), `tokenInfo`, `rpc`, `proposalStatus`.
- **Signing:** `propose` (checks, signs the Safe transaction hash with the current key, posts it; the signature is the proposer's confirmation), `confirm`, `execute`. On a Safe with threshold 1 the proposer is the only signature needed, so `propose` posts nothing: it keeps the transaction in the session (`directTxs`, listed in the queue and the status until its nonce is used) and starts the normal execution at once, with the same steps. The UI's `SoleSignerContext` turns "Sign & propose" into "Execute" and adjusts the messages. Token transfers and approvals are described with the token's symbol, name and decimals, read from the chain once per token (`withTokenNames`), e.g. "Approve 0x… to spend 1,234.5 USDC (USD Coin)", with approvals of 2^255 or more shown as unlimited; an action stays as decoded if the token does not answer.
- **Executing:** `execute` returns at once with a list of steps the UI follows: simulate, fund the key from the gas account if needed (`fund`, waits for the transfer), sign and send through the execution RPC, wait for inclusion, record rotations (read from the receipt's `OwnerRotated` events), sweep the key's remaining ETH back to the gas account (`sweepWhenMined`, `sweep`; the transfer's gas is estimated so the key ends at zero or within a fraction of a gwei). `execution` reports progress.
- **Maintaining:** `refill` stages the slot's next keys from the gas account (skipping past any used key), `autoRefill` and `startAutoRefill` run it every minute once two buffer places are free, `skipUsedKeysInput` builds a proposal that skips used keys and restages in one transaction, `renewKeys` derives the next generation of the slot's key list and builds the `setRoot` plus staging proposal, and `adoptRenewedTree` switches the session to that list once its root is on-chain.
- **Queue:** `draft`, `setQueueMode`, `addToDraft`, `removeFromDraft`, `moveInDraft`, `clearDraft`, `simulateDraft`, `readAfterDraft`, `proposeDraft` (the whole queue as one MultiSend transaction).
- **Checks:** `check` validates every proposal kind against chain state before anything is signed.
- **Executions that never land:** every signature by an owner key is written to the signing log before it leaves the app (`logSigned`: key, slot, tree index, Safe nonce, safeTxHash, confirm or execute). Sent executions are saved with their account nonce and request (`saveAttempts`) and come back after a restart; the sweep watcher resumes with them. While an attempt is open, the queue item carries it (`QueueItem.attempt`), the rules engine refuses a second execution from the same key (`openAttempt`), and once the timeout passes the record turns `stuck` with a plain message. `speedUp` resends the same transaction from the same key and account nonce with fees raised at least 13%, so only one of the sends can ever be mined; `execution` checks every hash of the attempt and marks it `replaced` once the Safe moved past its nonce. `exposures` reads the log on every snapshot: a recorded key that is still an owner while its transaction is gone from the queue (an execution that never landed, a confirmation whose transaction was replaced) is an exposure, together with the confirmers of that transaction. `status` reports it (`exposure`, plus a critical finding) and the rules engine counts those keys like confirmations (`exposed`): with a full threshold exposed, only a force-rotate covering every exposed slot may be confirmed. `recover` proposes exactly that, at the current nonce so it also cancels the lost transaction; its signers rotate as usual.

### 7.2 Cicada desktop (signer/desktop)

Electron. The UI runs sandboxed with no Node access; it can only call the handlers the preload exposes, and every handler checks the call comes from the app's own window.

| File | Purpose |
|---|---|
| `main.ts` | The main process: profiles and their unlock, one running session per Safe of the active profile (`start`, `resume`, `setActive`), joining and creating Safes, being added, IPC handlers (`app:*`, `profiles:*`, `vault:*`, `safes:*`, `signer:*`, `draft:*`, `create:*`, `adding:*`, `browser:*`), the macOS window without a title bar, and test hooks (environment variables, off by default). |
| `vault.ts` | The encrypted seed: scrypt (N = 2^17) and AES-256-GCM, file mode 0600, password unlock. Stores the gas account address in clear so the unlock screen can show it. |
| `profiles.ts` | `ProfileStore`: several profiles (seed or Ledger), each in its own folder with its vault, settings (all its Safes), key lists and Safe creations in progress. Migrates older single-wallet installs. |
| `browser.ts` | `DappBrowser`: a separate web view for dApps with its own storage partition and no permissions, laid over the UI's viewport; hidden whenever a request is under review so a page can never cover or imitate the review. |
| `preload.cjs` | The bridge from the UI to the main process. |
| `dapp-preload.cjs` | The bridge in dApp pages: injects an EIP-1193 wallet (`window.ethereum`, announced through EIP-6963) whose only capability is forwarding requests. |
| `assets/` | The Cicada icon (SVG source, PNG, macOS `.icns`). |

### 7.3 Cicada UI (signer/ui)

React, built with Vite; the same UI runs in the desktop app (through the preload bridge) and against the local web server (through HTTP).

| File | Purpose |
|---|---|
| `api.ts` | Every call the UI can make, through the desktop bridge or HTTP. |
| `data.ts` | `useSignerData`: polls status, queue and the local queue. |
| `App.tsx` | Routing: the welcome page on first launch, add or pick a profile, unlock or connect the Ledger, set up a Safe, then the shell (sidebar with the Safe switcher, queue toggle, profile chip). |
| `Welcome.tsx` | First launch (no profile yet): what the app does in three cards, a note that it works from addresses only (Ledger keys stay on the device, a seed is encrypted locally), and Get started. |
| `Skeleton.tsx` | Placeholder blocks while the first status loads: an Overview-shaped skeleton in the shell and lines in the Safe switcher. |
| `Wallet.tsx` | Add profile (seed or Ledger), profile picker (with removal), unlock, connect Ledger. |
| `Setup.tsx`, `JoinSafe.tsx` | Connect a Safe: join, create (creator room), use an invite (signer room), being added (waiting room). |
| `SafeSwitcher.tsx` | The Safe card at the top of the sidebar: switch, add, forget Safes. |
| `pages/Overview.tsx` | This signer's slot, gas account, next keys (manual refill), health findings (skip used keys). |
| `pages/Transactions.tsx` | Pending transactions with this signer's action, the execution timeline, Speed up and recovery for a stuck execution, New transaction, and the queue card. |
| `pages/TxDetails.tsx` | A transaction's Details: each call's target, value, decoded function or selector and data (shortened, click to expand, copy), then the Safe transaction (nonce, operation, safeTxGas, hash, proposer, time, each signature with its slot). |
| `pages/Recover.tsx` | Replace exposed keys: previews and proposes the force-rotate that recovers from an execution that never landed. |
| `pages/NewTransaction.tsx`, `pages/ContractCall.tsx` | Send ETH, send a token, call any contract (ABI or raw data), rotate signers. |
| `pages/RenewKeys.tsx` | Renew this signer's key list (Settings, and Overview when the list runs low). |
| `pages/QueueCard.tsx` | The local queue: reorder, simulate, review, propose all. |
| `pages/Browse.tsx` | The dApp browser's address bar and request review. |
| `pages/Signers.tsx`, `pages/Manage.tsx` | Every slot's state; add, remove, re-threshold, escape hatch. |
| `pages/Settings.tsx` | Profile (rename, remove), Safe (add another, remove from Cicada), connection. |
| `ui.tsx`, `icons.tsx`, `format.ts`, `styles.css` | Shared components, icons, formatting and the design tokens. |
| `lib/` | The UI's logic as plain functions, unit tested in `ui/test`: contract-call parsing and encoding, profile form checks, slot package preview, execution state. Components keep only state and markup. |

Tests: `npm test -w @rotating-msig/signer` runs the session, desktop and UI unit tests. `npm run test:app -w @rotating-msig/signer` builds the desktop app and drives it with Playwright (`playwright-core`, Electron mode): it starts Anvil with a guarded Safe whose keys use the app's two-level path, points the app at it through the `ROTATION_SIGNER_TEST_CHAIN` hook (registers the local chain, its contracts and a local Transaction Service), then adds a seed profile and joins, proposes, executes with gas funding and sweep, and removes the profile. Set `E2E_SCREENSHOTS` to a folder to keep a screenshot after each test. `npm run screenshots -w @rotating-msig/signer` (`scripts/screenshots.ts`) drives the same flow to regenerate the README images in `screenshots/`. Joining still probes mainnet and Sepolia public RPCs during network detection, so it needs internet.

### 7.4 How the dApp browser works

The dApp sees the **Safe** as its account. Reads (`eth_call`, balances, logs) go to the RPC. `eth_sendTransaction` and EIP-5792 `wallet_sendCalls` open a review in Cicada; the user either proposes it (signed with the current key) or adds it to the local queue. Message signing is refused, since it would expose an owner key without rotating it, and dApps cannot call the Safe or the guard.

What the dApp gets back depends on how it reads the chain:

- `eth_sendTransaction` answers with the **real execution's transaction hash** once a signer executes the proposal, because many dApps (testnet.raac.io among them) look the hash up through their own RPC.
- Queued requests get a placeholder hash whose receipt reports success at once, and while the queue is not empty the dApp's reads run on top of the queued calls (`readAfterDraft`), so approve then deposit works before anything is on-chain. This only helps dApps that read through the wallet; Cicada detects dApps that read their own RPC (they set the nonce, or never read through the wallet) and recommends proposing instead.
- `wallet_sendCalls` answers with an ID that `wallet_getCallsStatus` follows.

The wallet connects per site, like MetaMask: `eth_accounts` is empty until the site calls `eth_requestAccounts` (or sends a request, which the user reviews), and connected sites are forgotten on lock. A dApp that finds an account on a network it does not support may stall instead of loading (Curve on Sepolia did); without one it loads read-only until the user connects. The injected `window.ethereum` stays extensible and writable, since dApps set legacy MetaMask fields on it (Uniswap crashed on a frozen one).

The browser has tabs (`DappBrowser`: one `WebContentsView` per tab, only the selected one shown over the UI's viewport). A page's `window.open` or popup opens as a new, selected tab through Electron's `createWindow`, adopting the page Chromium prepared, so it keeps `window.opener` (sign-in and connect popups report back to their opener) and the wallet preload; a popup that closes itself closes its tab. Every tab may send wallet requests. Links to non-https pages still go to the system browser. Saved pages are kept per profile in `bookmarks.json` (main process, `bookmarks:*` IPC, `bookmarks:state` events); the address bar's star saves or removes the current page, and the sidebar's dropdown under Browse dApps (`SavedPages.tsx`) opens one in a new tab.

## 8. Keys: where each Safe's keys live

Each signer's seed (or Ledger) holds:

- the **gas account**, `m/44'/60'/0'/0/0`: pays for creating Safes, executions and staging; never an owner (except briefly as an initial owner of a Safe being created);
- one **key list per Safe**, at a path derived from the network and Safe address, so the app finds it again from the Safe alone, on any device:

| Layout | Path of key `i` | Collision between two Safes of one seed | Used by |
|---|---|---|---|
| Two-level (current) | `m/44'/60'/{account}'/{branch}'/{i}`, both from one hash; each renewal of a slot's list uses the next generation of the hash | about 1 in 4.6 × 10^18 | Safes created since 2026-10-08 |
| One-level per Safe | `m/44'/60'/{account}'/0/{i}` | about 1 in 2 billion | Briefly, the same day |
| Ranged | `m/44'/60'/{base + i}'/0/0` | about 1 in 50,000 | The first Sepolia Safes |

Joining tries them in that order. Each derivation step has a fixed cost regardless of the numbers, so the two-level path costs a Ledger the same per address as the others. On top of the derivation:

- `KeyChecker` refuses keys that already sent a transaction, or that the guard already staged or rotated to for another Safe (best effort; it cannot see a slot's very first key);
- slot packages start at the first six unused keys;
- `skipTo` moves a slot past a key found to be used after it was committed.

## 9. Key flows end to end

**Creating a Safe.** The creator lists every signer's gas address and the threshold (`planSafe`); the invite holds the owners, threshold, salt and predicted address. Each signer's app recomputes the address (`verifyInvite`), derives their tree and returns a slot package (first key, next 5 keys, proofs). The creator's app verifies every package (`verifyPackages`), then deploys the Safe (owners = gas addresses, threshold 1) and installs (`installFromPackages`: guard, slot swaps, staging, final threshold) in two transactions. Two are needed because tree leaves bind the Safe address, which depends on the initializer. Every signer then joins and checks their own root on-chain.

**Joining.** `joinSafe` with seed and address only: detect the network, read the slots, find the seed's slot and layout, rebuild the tree, check the root.

**Signing and executing.** A proposer signs the Safe transaction hash with their current key (`propose`); others confirm until threshold − 1 confirmations exist (`confirm`); the last signer executes with the confirmations plus their own v = 1 signature (`execute`). The guard rotates every signer; each signer's app refills its buffer.

**Being added.** The newcomer's app generates a tree for the next slot ID and a package signed by their signer address; the owner confirms that address with the newcomer directly, then proposes `addSlot` plus staging in one batch; after execution, the newcomer's app sees the slot and joins.

**Signed packages.** Every slot package (creating or being added) is signed by the signer's gas address. When creating, each signature must come from the address the creator listed for that slot; when adding, the owner confirms the address out of band. A package swapped in transit is rejected or shows an address the owner does not recognize.

**Queueing.** With the queue on, actions collect locally; the queue is simulated as the Safe would run it and proposed as one transaction, so each signer signs and rotates once.

## 10. Trust boundaries and what protects what

| Concern | Protection |
|---|---|
| A key signs and stays an owner | Guard rotates every signer in the same transaction; executor must sign; exact signature count; approved hashes only from the executor. |
| An attacker picks the next owner | Next owners are committed (Merkle root) and staged with proofs before they are needed. |
| A retired key comes back | `_consumedUpTo` per root; staging requires strictly sequential indexes. |
| Owners changed around the guard | Owner-set check after every transaction; module guard blocks other modules. |
| Guard removed silently | Hooks-installed check; only the exact escape transaction skips it. |
| Hooks replayed from inside a transaction | `checkTransaction` runs at most once per Safe nonce (transient nonce lock), so a replay reverts. Cicada also blocks transactions that call the hooks or change owners or hooks directly. |
| A failing or gas-burning call undoes the rotation | `safeTxGas` and `gasPrice` must both be non-zero: Safe never reverts the whole transaction on inner failure and caps the inner call at `safeTxGas`; the app's gas limit covers all of `safeTxGas` plus the rotation. |
| A failing refund undoes the rotation | Refunds only in ETH to the executor (`RefundNotAllowed`), and the executor sends the refund's upper bound with the transaction, so even an empty Safe can pay it (3.9). |
| Another slot rotates into a staged address | Rotation skips staged entries that are already owners. |
| Off-chain confirmations exposing too many keys | Rules engine: at most threshold − 1 confirmations, exposure checked across the queue. |
| Seed theft from disk | Encrypted vault (scrypt, AES-256-GCM), unlocked per session, wiped on lock. |
| A web page | dApp view sandboxed, own storage, no permissions, review hidden from the page, no message signing, no calls to Safe or guard. |
| The UI itself | Sandboxed renderer; every action re-checked in the session against chain state. |
| Keys reused across Safes or wallets | Two-level per-Safe path, nonce and guard-history checks, skip used keys. |
| A swapped slot package | Packages signed by the signer's gas address; checked against the invite's owner list, or confirmed by the owner out of band. |

## 11. Where to change what

| To change | Look in |
|---|---|
| A signing or rotation rule | `src/RotationGuard.sol` (`checkTransaction`, `checkAfterExecution`) and its tests; mirror it in `packages/core/src/rules.ts`. |
| What the app may propose | `packages/core/src/proposals.ts` (`buildProposal`) and `SignerSession.check`. |
| How keys are derived | `packages/core/src/base.ts`, `tree.ts` (`treeKeyPath`), `signer/src/join.ts` (`keyLayouts`). |
| The tree or leaf format | `packages/core/src/tree.ts` and `RotationGuard._leaf` together; regenerate the vectors. |
| Execution, funding, sweep | `SignerSession.prepareExecution`, `sendExecution`, `execution`, `fund`, `sweep`. |
| dApp behaviour | `signer/src/dapp.ts`, `signer/desktop/browser.ts`, `dapp-preload.cjs`. |
| Supported networks and deployments | `packages/core/src/addresses.ts`, `signer/src/networks.ts`, `deployments/`. |
| Desktop storage | `signer/desktop/profiles.ts`, `vault.ts`, settings handling in `main.ts`. |
