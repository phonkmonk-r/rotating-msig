// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title IRotationGuard
 * @notice Transaction guard, module guard and module for Safe 1.5.0 that rotates every owner whose public key is
 *         exposed by signing a Safe transaction. Each owner occupies a slot backed by a Merkle root over fresh,
 *         never-used addresses derived offline by that signer. After every guarded transaction, each signer is swapped
 *         for the next pre-staged address of its slot, so an exposed key never remains an owner.
 * @dev Leaves are `keccak256(bytes.concat(keccak256(abi.encode(chainId, safe, slotId, index, owner))))` with
 *      `(uint256, address, uint256, uint256, address)` types, matching OpenZeppelin's `StandardMerkleTree`.
 */
interface IRotationGuard {
    /**
     * @notice Configuration of a new slot.
     * @param root Merkle root over the signer's addresses.
     * @param size Number of leaves in the tree. Valid indexes are `[0, size)`.
     * @param startIndex Index of `owner` in the tree. Staging continues from `startIndex + 1`.
     * @param owner Address that becomes the slot's owner.
     * @param proof Merkle proof of `owner` at `startIndex`.
     * @param cid IPFS CID of the public tree file, emitted so anyone can stage.
     */
    struct SlotConfig {
        bytes32 root;
        uint32 size;
        uint32 startIndex;
        address owner;
        bytes32[] proof;
        string cid;
    }

    /**
     * @notice One address to append to a slot's staging buffer.
     * @param index Tree index of `owner`. Must equal the slot's next stage index.
     * @param owner Address to stage.
     * @param proof Merkle proof of `owner` at `index`.
     */
    struct StageEntry {
        uint32 index;
        address owner;
        bytes32[] proof;
    }

    /**
     * @notice Read-only view of a slot.
     * @param root Merkle root of the slot.
     * @param owner Current owner of the slot.
     * @param size Number of leaves in the tree.
     * @param nextIndex Tree index of the next owner to be rotated in (the buffer head).
     * @param nextStageIndex Tree index the next `stage` entry must use.
     * @param staged Staged addresses in rotation order.
     */
    struct SlotView {
        bytes32 root;
        address owner;
        uint32 size;
        uint32 nextIndex;
        uint32 nextStageIndex;
        address[] staged;
    }

    /**
     * @notice Emitted when a Safe is (re)initialized.
     * @param safe The Safe.
     * @param epoch New configuration epoch. Slots of earlier epochs are discarded.
     * @param slotCount Number of slots created.
     */
    event Initialized(address indexed safe, uint64 epoch, uint256 slotCount);

    /**
     * @notice Emitted when a slot is created or its root is replaced.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param root Merkle root.
     * @param size Number of leaves.
     * @param startIndex First tree index used under this root.
     * @param cid IPFS CID of the public tree file.
     */
    event SlotConfigured(address indexed safe, uint256 indexed slotId, bytes32 root, uint32 size, uint32 startIndex, string cid);

    /**
     * @notice Emitted when a slot and its owner are removed.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param owner The removed owner.
     */
    event SlotRemoved(address indexed safe, uint256 indexed slotId, address owner);

    /**
     * @notice Emitted when an address is appended to a slot's staging buffer.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param index Tree index of the staged address.
     * @param owner The staged address.
     */
    event OwnerStaged(address indexed safe, uint256 indexed slotId, uint32 index, address owner);

    /**
     * @notice Emitted when a slot's owner is swapped for its next staged address.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param oldOwner The exposed owner removed.
     * @param newOwner The fresh owner added.
     * @param index Tree index of `newOwner`.
     */
    event OwnerRotated(address indexed safe, uint256 indexed slotId, address oldOwner, address newOwner, uint32 index);

    /**
     * @notice Emitted when a slot skips ahead in its tree, discarding any staged addresses.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param nextStageIndex New next stage index.
     */
    event IndexSkipped(address indexed safe, uint256 indexed slotId, uint32 nextStageIndex);

    /// @notice The Safe has not called `initialize`.
    error NotInitialized(address safe);
    /// @notice `execTransaction` was re-entered for the same Safe while a guarded transaction was in progress, or the
    ///         hook was called again for the same Safe nonce (replayed from inside the transaction).
    error NestedExecution();
    /// @notice `checkAfterExecution` was called without a matching `checkTransaction`.
    error NoTransactionInProgress();
    /// @notice A delegatecall targeted something other than the allowlisted MultiSendCallOnly.
    error DelegateCallNotAllowed(address to);
    /// @notice `safeTxGas` or `gasPrice` is zero. With `gasPrice` zero Safe hands the inner call all remaining gas (a
    ///         callee can burn it and starve the rotation), and with both zero it reverts the whole transaction on a
    ///         failing inner call; either way signatures already public would not rotate.
    error SafeTxGasRequired();
    /// @notice The gas refund names a gas token or a refund receiver; a failing refund would revert the whole
    ///         transaction, so refunds are paid only in ETH to the executor.
    error RefundNotAllowed();
    /// @notice The signatures are not exactly `threshold` static 65-byte signatures.
    error UnexpectedSignatureLength(uint256 length, uint256 expected);
    /// @notice A contract (EIP-1271) signature was supplied.
    error ContractSignatureNotAllowed(address signer);
    /// @notice A pre-validated signature was supplied for someone other than the executor (an on-chain `approveHash`).
    error ApprovedHashNotAllowed(address signer);
    /// @notice The executor did not sign through a pre-validated (v = 1) signature.
    error ExecutorMustSign(address executor);
    /// @notice An owner is not tracked by any slot.
    error UnmanagedOwner(address owner);
    /// @notice The Safe's owners do not match the slot owners exactly.
    error OwnerSetMismatch();
    /// @notice The transaction guard, module guard or module was removed outside the escape hatch.
    error HooksRemoved();
    /// @notice The slot has no staged address to rotate in.
    error BufferEmpty(uint256 slotId);
    /// @notice The slot's staging buffer is full.
    error BufferFull(uint256 slotId);
    /// @notice A staged index is not the slot's next stage index.
    error NonSequentialIndex(uint32 index, uint32 expected);
    /// @notice An index lies outside the slot's tree or behind already-used indexes.
    error IndexOutOfRange(uint32 index);
    /// @notice An address cannot become an owner.
    error InvalidOwner(address owner);
    /// @notice A Merkle proof does not verify against the slot's root.
    error InvalidProof();
    /// @notice The slot does not exist.
    error UnknownSlot(uint256 slotId);
    /// @notice A root is re-committed at an index already consumed under it.
    error RootIndexConsumed(bytes32 root, uint32 startIndex, uint32 consumedUpTo);
    /// @notice A configuration parameter is invalid.
    error InvalidConfig();
    /// @notice A Safe call made through the module failed.
    error ModuleCallFailed();
    /// @notice A module transaction was not an owner-management call from this contract.
    error ModuleTransactionNotAllowed(address module);

    /**
     * @notice Configures the calling Safe, replacing every current owner with the first address of its slot's tree.
     * @dev Called by the Safe itself in the setup batch, after enabling this contract as a module and setting it as
     *      transaction guard and module guard; it reverts with `HooksRemoved` otherwise. Starts a new epoch, so
     *      calling it again discards all existing slots, after recording their consumed indexes so their roots can
     *      never be re-committed below them. `oldOwners[i]` is swapped for `configs[i].owner`.
     * @param oldOwners Current owners, one per slot, all of which must be covered.
     * @param configs Slot configurations, in slot id order.
     */
    function initialize(address[] calldata oldOwners, SlotConfig[] calldata configs) external;

    /**
     * @notice Adds a slot and its owner to the calling Safe.
     * @param config Slot configuration.
     * @param newThreshold Safe threshold after the owner is added.
     */
    function addSlot(SlotConfig calldata config, uint256 newThreshold) external;

    /**
     * @notice Removes a slot and its owner from the calling Safe.
     * @param slotId The slot.
     * @param newThreshold Safe threshold after the owner is removed.
     */
    function removeSlot(uint256 slotId, uint256 newThreshold) external;

    /**
     * @notice Replaces a slot's Merkle root, for an exhausted tree or a re-keyed signer. Clears the staging buffer.
     * @dev Records the outgoing root's consumed indexes first, so the same root can be re-committed only from an
     *      index that never held an owner.
     * @param slotId The slot.
     * @param root New Merkle root.
     * @param size Number of leaves in the new tree.
     * @param startIndex First index to stage from the new tree.
     * @param cid IPFS CID of the new tree file.
     */
    function setRoot(uint256 slotId, bytes32 root, uint32 size, uint32 startIndex, string calldata cid) external;

    /**
     * @notice Moves a slot's next stage index forward, discarding staged addresses. The only way to skip indexes.
     * @param slotId The slot.
     * @param index New next stage index. Must not be behind the slot's next unused index.
     */
    function skipTo(uint256 slotId, uint32 index) external;

    /**
     * @notice Rotates slots immediately, for owners exposed outside guarded transactions.
     * @param slotIds Slots to rotate. Each must have a staged address.
     */
    function forceRotate(uint256[] calldata slotIds) external;

    /**
     * @notice Appends proven addresses to a slot's staging buffer. Permissionless.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param entries Addresses to stage, in strictly sequential index order.
     */
    function stage(address safe, uint256 slotId, StageEntry[] calldata entries) external;

    /**
     * @notice Returns the leaf hash for an address at a tree index of a slot.
     * @param safe The Safe.
     * @param slotId The slot.
     * @param index Tree index.
     * @param owner The address.
     * @return The leaf hash.
     */
    function leaf(address safe, uint256 slotId, uint256 index, address owner) external view returns (bytes32);

    /**
     * @notice Returns a slot of a Safe in its current epoch.
     * @param safe The Safe.
     * @param slotId The slot.
     * @return The slot view.
     */
    function getSlot(address safe, uint256 slotId) external view returns (SlotView memory);

    /**
     * @notice Returns the configuration counters of a Safe.
     * @param safe The Safe.
     * @return epoch Current epoch, zero if never initialized.
     * @return slotCount Number of slot ids ever created in this epoch.
     * @return activeSlots Number of slots currently holding an owner.
     */
    function getConfig(address safe) external view returns (uint64 epoch, uint32 slotCount, uint32 activeSlots);

}
