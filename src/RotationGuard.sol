// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ITransactionGuard} from "@safe/base/GuardManager.sol";
import {IModuleGuard} from "@safe/base/ModuleManager.sol";
import {IERC165} from "@safe/interfaces/IERC165.sol";
import {IGuardManager} from "@safe/interfaces/IGuardManager.sol";
import {IOwnerManager} from "@safe/interfaces/IOwnerManager.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";
import {Enum} from "@safe/libraries/Enum.sol";

import {IRotationGuard} from "./interfaces/IRotationGuard.sol";

/**
 * @title RotationGuard
 * @notice Singleton transaction guard, module guard and module for Safe 1.5.0 that rotates out every owner who signs a
 *         guarded transaction, replacing it with the next pre-staged address committed under that owner's Merkle root.
 * @dev A Safe must enable this contract as a module, set it as both transaction guard and module guard, and call
 *      `initialize` in a single setup batch. Guarded transactions must then satisfy:
 *      - exactly `threshold` static signatures, no contract signatures;
 *      - the executor (`msg.sender` of `execTransaction`) is an owner signing through a pre-validated (v = 1) signature,
 *        and no other pre-validated signatures;
 *      - delegatecalls only to the allowlisted MultiSendCallOnly.
 *      After execution every signer still an owner is rotated, the owner set must equal the slot owners exactly, and
 *      the hooks must still be installed. The only exception is the escape hatch: a transaction that is exactly
 *      `setGuard(address(0))` on the Safe itself bypasses every check.
 */
contract RotationGuard is IRotationGuard, ITransactionGuard, IModuleGuard {
    /// @notice Capacity of each slot's staging ring buffer.
    uint256 public constant BUFFER_SIZE = 5;

    /// @notice The only delegatecall target allowed in guarded transactions.
    address public immutable MULTI_SEND_CALL_ONLY;

    address internal constant SENTINEL = address(0x1);
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant MODULE_GUARD_STORAGE_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
    bytes32 internal constant TRANSIENT_SEED = keccak256("RotationGuard.transaction");

    uint256 internal constant TX_NONE = 0;
    uint256 internal constant TX_ACTIVE = 1;
    uint256 internal constant TX_ESCAPE = 2;

    struct Slot {
        bytes32 root;
        address owner;
        uint32 size;
        uint32 nextStageIndex;
        uint8 head;
        uint8 count;
        address[BUFFER_SIZE] buffer;
    }

    struct SafeConfig {
        uint64 epoch;
        uint32 slotCount;
        uint32 activeSlots;
    }

    mapping(address safe => SafeConfig) internal _configs;
    mapping(address safe => mapping(uint64 epoch => mapping(uint256 slotId => Slot))) internal _slots;
    /// @dev Stores `slotId + 1` so that zero means "no slot".
    mapping(address safe => mapping(uint64 epoch => mapping(address owner => uint256))) internal _slotOf;

    /**
     * @param multiSendCallOnly The MultiSendCallOnly deployment allowed as a delegatecall target.
     */
    constructor(address multiSendCallOnly) {
        MULTI_SEND_CALL_ONLY = multiSendCallOnly;
    }

    modifier onlyInitialized() {
        if (_configs[msg.sender].epoch == 0) revert NotInitialized(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              GUARD HOOKS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc ITransactionGuard
     * @dev Records the signers of the transaction in transient storage for `checkAfterExecution`.
     */
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address msgSender
    ) external override {
        address safe = msg.sender;
        uint256 base = _transientBase(safe);
        if (_tload(base) != TX_NONE) revert NestedExecution();

        if (_isEscape(safe, to, value, data, operation)) {
            _tstore(base, TX_ESCAPE);
            return;
        }

        if (_configs[safe].epoch == 0) revert NotInitialized(safe);
        if (operation == Enum.Operation.DelegateCall && to != MULTI_SEND_CALL_ONLY) revert DelegateCallNotAllowed(to);

        uint256 threshold = _safe(safe).getThreshold();
        if (signatures.length != threshold * 65) revert UnexpectedSignatureLength(signatures.length, threshold * 65);

        bytes32 txHash = _safe(safe).getTransactionHash(
            to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, _safe(safe).nonce() - 1
        );

        bool executorSigned;
        for (uint256 i = 0; i < threshold; ++i) {
            address signer;
            uint256 offset = i * 65;
            bytes32 r = bytes32(signatures[offset:offset + 32]);
            bytes32 s = bytes32(signatures[offset + 32:offset + 64]);
            uint8 v = uint8(signatures[offset + 64]);
            if (v == 0) {
                revert ContractSignatureNotAllowed(address(uint160(uint256(r))));
            } else if (v == 1) {
                signer = address(uint160(uint256(r)));
                if (signer != msgSender) revert ApprovedHashNotAllowed(signer);
                executorSigned = true;
            } else if (v > 30) {
                signer = ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", txHash)), v - 4, r, s);
            } else {
                signer = ecrecover(txHash, v, r, s);
            }
            _tstore(base + 2 + i, uint256(uint160(signer)));
        }
        if (!executorSigned) revert ExecutorMustSign(msgSender);

        _tstore(base + 1, threshold);
        _tstore(base, TX_ACTIVE);
    }

    /**
     * @inheritdoc ITransactionGuard
     * @dev Rotates every recorded signer that is still an owner, whether or not the inner call succeeded, then checks
     *      the owner set and hook invariants.
     */
    function checkAfterExecution(bytes32, bool) external override {
        address safe = msg.sender;
        uint256 base = _transientBase(safe);
        uint256 state = _tload(base);
        if (state == TX_ESCAPE) {
            _tstore(base, TX_NONE);
            return;
        }
        if (state != TX_ACTIVE) revert NoTransactionInProgress();

        uint256 signerCount = _tload(base + 1);
        address[] memory signers = new address[](signerCount);
        for (uint256 i = 0; i < signerCount; ++i) {
            signers[i] = address(uint160(_tload(base + 2 + i)));
            _tstore(base + 2 + i, 0);
        }
        _tstore(base + 1, 0);
        _tstore(base, TX_NONE);

        uint64 epoch = _configs[safe].epoch;
        for (uint256 i = 0; i < signerCount; ++i) {
            address signer = signers[i];
            if (!_safe(safe).isOwner(signer)) continue;
            uint256 slotIdPlusOne = _slotOf[safe][epoch][signer];
            if (slotIdPlusOne == 0) revert UnmanagedOwner(signer);
            _rotate(safe, epoch, slotIdPlusOne - 1);
        }

        _checkOwnerSet(safe, epoch);
        _checkHooksInstalled(safe);
    }

    /**
     * @inheritdoc IModuleGuard
     * @dev Only owner-management calls from this contract to the Safe itself are allowed.
     */
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        address module
    ) external view override returns (bytes32) {
        if (module != address(this) || to != msg.sender || value != 0 || operation != Enum.Operation.Call || data.length < 4) {
            revert ModuleTransactionNotAllowed(module);
        }
        bytes4 selector = bytes4(data[:4]);
        if (
            selector != IOwnerManager.swapOwner.selector &&
            selector != IOwnerManager.addOwnerWithThreshold.selector &&
            selector != IOwnerManager.removeOwner.selector
        ) revert ModuleTransactionNotAllowed(module);
        return bytes32(0);
    }

    /// @inheritdoc IModuleGuard
    function checkAfterModuleExecution(bytes32, bool) external pure override {}

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(ITransactionGuard).interfaceId ||
            interfaceId == type(IModuleGuard).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    /*//////////////////////////////////////////////////////////////
                             SAFE ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRotationGuard
    function initialize(address[] calldata oldOwners, SlotConfig[] calldata configs) external override {
        address safe = msg.sender;
        if (configs.length == 0 || oldOwners.length != configs.length) revert InvalidConfig();

        SafeConfig storage config = _configs[safe];
        uint64 epoch = ++config.epoch;
        config.slotCount = 0;
        config.activeSlots = 0;

        for (uint256 i = 0; i < configs.length; ++i) {
            address newOwner = _createSlot(safe, epoch, configs[i]);
            _execAsModule(
                safe,
                abi.encodeCall(IOwnerManager.swapOwner, (_prevOwner(safe, oldOwners[i]), oldOwners[i], newOwner))
            );
        }
        _checkOwnerSet(safe, epoch);

        emit Initialized(safe, epoch, configs.length);
    }

    /// @inheritdoc IRotationGuard
    function addSlot(SlotConfig calldata config, uint256 newThreshold) external override onlyInitialized {
        address safe = msg.sender;
        address newOwner = _createSlot(safe, _configs[safe].epoch, config);
        _execAsModule(safe, abi.encodeCall(IOwnerManager.addOwnerWithThreshold, (newOwner, newThreshold)));
    }

    /// @inheritdoc IRotationGuard
    function removeSlot(uint256 slotId, uint256 newThreshold) external override onlyInitialized {
        address safe = msg.sender;
        SafeConfig storage config = _configs[safe];
        uint64 epoch = config.epoch;
        Slot storage slot = _existingSlot(safe, epoch, slotId);

        address owner = slot.owner;
        delete _slotOf[safe][epoch][owner];
        delete _slots[safe][epoch][slotId];
        --config.activeSlots;

        _execAsModule(safe, abi.encodeCall(IOwnerManager.removeOwner, (_prevOwner(safe, owner), owner, newThreshold)));
        emit SlotRemoved(safe, slotId, owner);
    }

    /// @inheritdoc IRotationGuard
    function setRoot(
        uint256 slotId,
        bytes32 root,
        uint32 size,
        uint32 startIndex,
        string calldata cid
    ) external override onlyInitialized {
        address safe = msg.sender;
        if (root == bytes32(0) || startIndex >= size) revert InvalidConfig();
        Slot storage slot = _existingSlot(safe, _configs[safe].epoch, slotId);
        slot.root = root;
        slot.size = size;
        slot.nextStageIndex = startIndex;
        slot.count = 0;
        emit SlotConfigured(safe, slotId, root, size, startIndex, cid);
    }

    /// @inheritdoc IRotationGuard
    function skipTo(uint256 slotId, uint32 index) external override onlyInitialized {
        address safe = msg.sender;
        Slot storage slot = _existingSlot(safe, _configs[safe].epoch, slotId);
        if (index < slot.nextStageIndex - slot.count || index > slot.size) revert IndexOutOfRange(index);
        slot.nextStageIndex = index;
        slot.count = 0;
        emit IndexSkipped(safe, slotId, index);
    }

    /// @inheritdoc IRotationGuard
    function forceRotate(uint256[] calldata slotIds) external override onlyInitialized {
        address safe = msg.sender;
        uint64 epoch = _configs[safe].epoch;
        for (uint256 i = 0; i < slotIds.length; ++i) {
            _existingSlot(safe, epoch, slotIds[i]);
            _rotate(safe, epoch, slotIds[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               STAGING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRotationGuard
    function stage(address safe, uint256 slotId, StageEntry[] calldata entries) external override {
        uint64 epoch = _configs[safe].epoch;
        if (epoch == 0) revert NotInitialized(safe);
        Slot storage slot = _existingSlot(safe, epoch, slotId);

        bytes32 root = slot.root;
        uint32 size = slot.size;
        uint32 nextStageIndex = slot.nextStageIndex;
        uint256 head = slot.head;
        uint256 count = slot.count;

        for (uint256 i = 0; i < entries.length; ++i) {
            StageEntry calldata entry = entries[i];
            if (count == BUFFER_SIZE) revert BufferFull(slotId);
            if (entry.index != nextStageIndex) revert NonSequentialIndex(entry.index, nextStageIndex);
            if (entry.index >= size) revert IndexOutOfRange(entry.index);
            if (!_isValidNewOwner(safe, entry.owner)) revert InvalidOwner(entry.owner);
            for (uint256 j = 0; j < count; ++j) {
                if (slot.buffer[(head + j) % BUFFER_SIZE] == entry.owner) revert InvalidOwner(entry.owner);
            }
            if (!MerkleProof.verifyCalldata(entry.proof, root, _leaf(safe, slotId, entry.index, entry.owner))) {
                revert InvalidProof();
            }

            slot.buffer[(head + count) % BUFFER_SIZE] = entry.owner;
            ++count;
            ++nextStageIndex;
            emit OwnerStaged(safe, slotId, entry.index, entry.owner);
        }

        slot.nextStageIndex = nextStageIndex;
        slot.count = uint8(count);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRotationGuard
    function leaf(address safe, uint256 slotId, uint256 index, address owner) external view override returns (bytes32) {
        return _leaf(safe, slotId, index, owner);
    }

    /// @inheritdoc IRotationGuard
    function getSlot(address safe, uint256 slotId) external view override returns (SlotView memory view_) {
        Slot storage slot = _slots[safe][_configs[safe].epoch][slotId];
        view_.root = slot.root;
        view_.owner = slot.owner;
        view_.size = slot.size;
        view_.nextIndex = slot.nextStageIndex - slot.count;
        view_.nextStageIndex = slot.nextStageIndex;
        view_.staged = new address[](slot.count);
        for (uint256 i = 0; i < slot.count; ++i) {
            view_.staged[i] = slot.buffer[(slot.head + i) % BUFFER_SIZE];
        }
    }

    /// @inheritdoc IRotationGuard
    function getConfig(address safe) external view override returns (uint64 epoch, uint32 slotCount, uint32 activeSlots) {
        SafeConfig storage config = _configs[safe];
        return (config.epoch, config.slotCount, config.activeSlots);
    }

    /// @inheritdoc IRotationGuard
    function slotOf(address safe, address owner) external view override returns (bool found, uint256 slotId) {
        uint256 slotIdPlusOne = _slotOf[safe][_configs[safe].epoch][owner];
        if (slotIdPlusOne == 0) return (false, 0);
        return (true, slotIdPlusOne - 1);
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _createSlot(address safe, uint64 epoch, SlotConfig calldata config) internal returns (address) {
        if (config.root == bytes32(0) || config.startIndex >= config.size) revert InvalidConfig();
        if (!_isValidNewOwner(safe, config.owner) || _slotOf[safe][epoch][config.owner] != 0) {
            revert InvalidOwner(config.owner);
        }

        SafeConfig storage safeConfig = _configs[safe];
        uint256 slotId = safeConfig.slotCount++;
        ++safeConfig.activeSlots;

        if (!MerkleProof.verifyCalldata(config.proof, config.root, _leaf(safe, slotId, config.startIndex, config.owner))) {
            revert InvalidProof();
        }

        Slot storage slot = _slots[safe][epoch][slotId];
        slot.root = config.root;
        slot.owner = config.owner;
        slot.size = config.size;
        slot.nextStageIndex = config.startIndex + 1;
        _slotOf[safe][epoch][config.owner] = slotId + 1;

        emit SlotConfigured(safe, slotId, config.root, config.size, config.startIndex, config.cid);
        return config.owner;
    }

    function _rotate(address safe, uint64 epoch, uint256 slotId) internal {
        Slot storage slot = _slots[safe][epoch][slotId];
        uint256 count = slot.count;
        if (count == 0) revert BufferEmpty(slotId);

        uint256 head = slot.head;
        address oldOwner = slot.owner;
        address newOwner = slot.buffer[head];
        uint32 index = slot.nextStageIndex - uint32(count);

        slot.head = uint8((head + 1) % BUFFER_SIZE);
        slot.count = uint8(count - 1);
        slot.owner = newOwner;
        delete _slotOf[safe][epoch][oldOwner];
        _slotOf[safe][epoch][newOwner] = slotId + 1;

        _execAsModule(
            safe,
            abi.encodeCall(IOwnerManager.swapOwner, (_prevOwner(safe, oldOwner), oldOwner, newOwner))
        );
        emit OwnerRotated(safe, slotId, oldOwner, newOwner, index);
    }

    function _existingSlot(address safe, uint64 epoch, uint256 slotId) internal view returns (Slot storage slot) {
        slot = _slots[safe][epoch][slotId];
        if (slot.root == bytes32(0)) revert UnknownSlot(slotId);
    }

    function _checkOwnerSet(address safe, uint64 epoch) internal view {
        address[] memory owners = _safe(safe).getOwners();
        if (owners.length != _configs[safe].activeSlots) revert OwnerSetMismatch();
        for (uint256 i = 0; i < owners.length; ++i) {
            uint256 slotIdPlusOne = _slotOf[safe][epoch][owners[i]];
            if (slotIdPlusOne == 0 || _slots[safe][epoch][slotIdPlusOne - 1].owner != owners[i]) {
                revert OwnerSetMismatch();
            }
        }
    }

    function _checkHooksInstalled(address safe) internal view {
        if (
            _readAddress(safe, GUARD_STORAGE_SLOT) != address(this) ||
            _readAddress(safe, MODULE_GUARD_STORAGE_SLOT) != address(this) ||
            !_safe(safe).isModuleEnabled(address(this))
        ) revert HooksRemoved();
    }

    function _isEscape(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) internal pure returns (bool) {
        return
            to == safe &&
            value == 0 &&
            operation == Enum.Operation.Call &&
            data.length == 36 &&
            bytes4(data[:4]) == IGuardManager.setGuard.selector &&
            bytes32(data[4:36]) == bytes32(0);
    }

    function _isValidNewOwner(address safe, address owner) internal view returns (bool) {
        return owner != address(0) && owner != SENTINEL && owner != safe && !_safe(safe).isOwner(owner);
    }

    function _prevOwner(address safe, address owner) internal view returns (address) {
        address[] memory owners = _safe(safe).getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == owner) return i == 0 ? SENTINEL : owners[i - 1];
        }
        revert UnmanagedOwner(owner);
    }

    function _execAsModule(address safe, bytes memory data) internal {
        if (!_safe(safe).execTransactionFromModule(safe, 0, data, Enum.Operation.Call)) revert ModuleCallFailed();
    }

    function _leaf(address safe, uint256 slotId, uint256 index, address owner) internal view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, safe, slotId, index, owner))));
    }

    function _readAddress(address safe, bytes32 storageSlot) internal view returns (address) {
        bytes memory word = _safe(safe).getStorageAt(uint256(storageSlot), 1);
        return address(uint160(uint256(bytes32(word))));
    }

    function _safe(address safe) internal pure returns (ISafe) {
        return ISafe(payable(safe));
    }

    function _transientBase(address safe) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(safe, TRANSIENT_SEED)));
    }

    function _tload(uint256 key) internal view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(key)
        }
    }

    function _tstore(uint256 key, uint256 value) internal {
        assembly ("memory-safe") {
            tstore(key, value)
        }
    }
}
