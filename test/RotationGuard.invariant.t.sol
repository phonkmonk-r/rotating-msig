// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Safe} from "@safe/Safe.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";
import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";

import {RotationGuard} from "../src/RotationGuard.sol";
import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {Reverter, RogueModule} from "./utils/Actors.sol";
import {MerkleBuilder} from "./utils/MerkleBuilder.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";

/**
 * @notice Drives a guarded Safe through honest executions, staging and every admin path, plus adversarial
 *         transactions and signature encodings. Ghost state records every address that ever left the owner set and
 *         every adversarial attempt that unexpectedly succeeded.
 */
contract RotationHandler is Test {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    address internal constant SENTINEL = address(0x1);
    uint32 public constant TREE_SIZE = 16;
    uint256 internal constant MIN_OWNERS = 2;
    uint256 internal constant MAX_OWNERS = 5;
    uint256 internal constant SAFE_TX_GAS = 5_000_000;

    Safe public immutable safe;
    RotationGuard public immutable guard;
    MultiSendCallOnly public immutable multiSend;
    Reverter internal immutable reverter;
    RogueModule internal immutable rogue;
    address internal immutable otherGuard;
    address public immutable recipient;

    mapping(bytes32 treeId => bytes32[]) internal leavesOf;
    mapping(bytes32 treeId => address[]) internal addressesOf;
    mapping(uint256 slotId => uint256) public genOf;
    uint256 internal nextGen = 1;
    mapping(address account => uint256) internal keyOf;

    mapping(address account => bool) public retired;
    address[] public exposed;
    uint256 public transferred;
    uint256 public executions;
    bool public adversarialSucceeded;
    uint256 public adversarialKind;
    bool public badStageAccepted;
    bool public honestStageFailed;
    bool public rotationMissed;
    bytes public lastRevert;

    constructor(Safe safe_, RotationGuard guard_, MultiSendCallOnly multiSend_, uint256 slots, address[] memory legacy, address recipient_) {
        safe = safe_;
        guard = guard_;
        multiSend = multiSend_;
        recipient = recipient_;
        reverter = new Reverter();
        rogue = new RogueModule();
        otherGuard = address(new RotationGuard(address(multiSend_)));
        for (uint256 i = 0; i < legacy.length; ++i) retired[legacy[i]] = true;
        for (uint256 slot = 0; slot < slots; ++slot) _buildTree(slot, 0);
    }

    /*//////////////////////////////////////////////////////////////
                            HONEST ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Transfer (or a failing inner call) signed by a random threshold of owners.
    function execute(uint256 seed, bool ethSign, bool failInner) external {
        if (failInner) {
            _exec(seed, ethSign, address(reverter), 0, abi.encodeCall(Reverter.boom, ()), Enum.Operation.Call, 100_000);
        } else if (_exec(seed, ethSign, recipient, 1, "", Enum.Operation.Call, SAFE_TX_GAS)) {
            transferred += 1;
        }
    }

    /// @notice Correct refill of a slot from an arbitrary caller. Must never fail when there is room.
    function stage(uint256 slotSeed, uint256 countSeed, address caller) public {
        _stageSlot(_randomSlot(slotSeed), countSeed, caller);
    }

    /// @notice Arbitrary stage attempt. Must only ever accept the tree address at the next index.
    function stageArbitrary(uint256 slotSeed, uint32 index, address owner, uint256 proofSeed, bool realOwner) external {
        uint256 slotId = _randomSlot(slotSeed);
        bytes32 treeId = _treeId(slotId, genOf[slotId]);
        uint256 proofIndex = proofSeed % TREE_SIZE;
        if (realOwner) owner = addressesOf[treeId][proofIndex];
        uint32 expectedIndex = guard.getSlot(address(safe), slotId).nextStageIndex;

        IRotationGuard.StageEntry[] memory list = new IRotationGuard.StageEntry[](1);
        list[0] = IRotationGuard.StageEntry(index, owner, MerkleBuilder.proof(leavesOf[treeId], proofIndex));
        try guard.stage(address(safe), slotId, list) {
            if (index != expectedIndex || index >= TREE_SIZE || owner != addressesOf[treeId][index]) badStageAccepted = true;
        } catch {}
    }

    function forceRotate(uint256 seed, uint256 slotSeed) external {
        uint256[] memory ids = new uint256[](1);
        ids[0] = _randomSlot(slotSeed);
        _exec(seed, false, address(guard), 0, abi.encodeCall(guard.forceRotate, (ids)), Enum.Operation.Call, SAFE_TX_GAS);
    }

    function skipTo(uint256 seed, uint256 slotSeed, uint8 delta) external {
        uint256 slotId = _randomSlot(slotSeed);
        uint32 index = guard.getSlot(address(safe), slotId).nextIndex + uint32(delta % 4);
        _exec(seed, false, address(guard), 0, abi.encodeCall(guard.skipTo, (slotId, index)), Enum.Operation.Call, SAFE_TX_GAS);
    }

    /// @notice Replaces a slot's root with a fresh tree, or carelessly re-commits the current tree at any index.
    function setRoot(uint256 seed, uint256 slotSeed, bool reuse, uint32 startSeed) external {
        uint256 slotId = _randomSlot(slotSeed);
        uint256 gen = reuse ? genOf[slotId] : nextGen++;
        if (!reuse) _buildTree(slotId, gen);
        bytes32 treeId = _treeId(slotId, gen);
        uint32 startIndex = reuse ? startSeed % TREE_SIZE : 0;
        bytes32 root = MerkleBuilder.root(leavesOf[treeId]);
        bytes memory data = abi.encodeCall(guard.setRoot, (slotId, root, TREE_SIZE, startIndex, "cid"));
        if (_exec(seed, false, address(guard), 0, data, Enum.Operation.Call, SAFE_TX_GAS)) genOf[slotId] = gen;
    }

    function changeThreshold(uint256 seed, uint256 thresholdSeed) external {
        uint256 threshold = bound(thresholdSeed, 1, safe.getOwners().length);
        _exec(seed, false, address(safe), 0, abi.encodeCall(safe.changeThreshold, (threshold)), Enum.Operation.Call, SAFE_TX_GAS);
    }

    function removeSlot(uint256 seed, uint256 slotSeed) external {
        uint256 owners = safe.getOwners().length;
        if (owners <= MIN_OWNERS) return;
        uint256 threshold = safe.getThreshold();
        if (threshold > owners - 1) threshold = owners - 1;
        bytes memory data = abi.encodeCall(guard.removeSlot, (_randomSlot(slotSeed), threshold));
        _exec(seed, false, address(guard), 0, data, Enum.Operation.Call, SAFE_TX_GAS);
    }

    function addSlot(uint256 seed) external {
        if (safe.getOwners().length >= MAX_OWNERS) return;
        (, uint32 slotId, ) = guard.getConfig(address(safe));
        uint256 gen = nextGen++;
        _buildTree(slotId, gen);
        bytes memory data = abi.encodeCall(guard.addSlot, (_config(slotId, gen, 0), safe.getThreshold()));
        if (_exec(seed, false, address(guard), 0, data, Enum.Operation.Call, SAFE_TX_GAS)) genOf[slotId] = gen;
    }

    /// @notice Re-initializes with fresh trees, or carelessly with the trees previously used under the same slot ids.
    function reinitialize(uint256 seed, bool reuse) external {
        address[] memory owners = safe.getOwners();
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](owners.length);
        uint256[] memory gens = new uint256[](owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            bool haveOld = addressesOf[_treeId(i, genOf[i])].length != 0;
            gens[i] = reuse && haveOld ? genOf[i] : nextGen++;
            if (!(reuse && haveOld)) _buildTree(i, gens[i]);
            configs[i] = _config(i, gens[i], 0);
        }
        bytes memory data = abi.encodeCall(guard.initialize, (owners, configs));
        if (_exec(seed, false, address(guard), 0, data, Enum.Operation.Call, SAFE_TX_GAS)) {
            for (uint256 i = 0; i < owners.length; ++i) genOf[i] = gens[i];
        }
    }

    /*//////////////////////////////////////////////////////////////
                         ADVERSARIAL ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Safe transactions that must always revert under the guard.
    function adversarialTx(uint256 seed, uint8 kindSeed, address victim) external {
        uint256 kind = kindSeed % 9;
        address[] memory owners = safe.getOwners();
        address owner = owners[seed % owners.length];
        address to = address(safe);
        bytes memory data;
        Enum.Operation operation = Enum.Operation.Call;

        if (victim == address(0) || victim == SENTINEL || safe.isOwner(victim) || victim == address(safe)) victim = address(0xBEEF);
        if (kind == 0) {
            data = abi.encodeCall(safe.addOwnerWithThreshold, (victim, safe.getThreshold()));
        } else if (kind == 1) {
            if (owners.length <= MIN_OWNERS) return;
            uint256 threshold = safe.getThreshold() > owners.length - 1 ? owners.length - 1 : safe.getThreshold();
            data = abi.encodeCall(safe.removeOwner, (_prevOwner(owner), owner, threshold));
        } else if (kind == 2) {
            data = abi.encodeCall(safe.swapOwner, (_prevOwner(owner), owner, victim));
        } else if (kind == 3) {
            data = abi.encodeCall(safe.setGuard, (otherGuard));
        } else if (kind == 4) {
            data = abi.encodeCall(safe.setModuleGuard, (address(0)));
        } else if (kind == 5) {
            data = abi.encodeCall(safe.disableModule, (_prevModule(address(guard)), address(guard)));
        } else if (kind == 6) {
            to = address(reverter);
            operation = Enum.Operation.DelegateCall;
        } else if (kind == 7) {
            to = address(guard);
            data = abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true));
        } else {
            to = address(multiSend);
            operation = Enum.Operation.DelegateCall;
            bytes memory inner = abi.encodeCall(safe.addOwnerWithThreshold, (victim, safe.getThreshold()));
            data = abi.encodeCall(MultiSendCallOnly.multiSend, (abi.encodePacked(uint8(0), address(safe), uint256(0), inner.length, inner)));
        }

        if (_exec(seed, false, to, 0, data, operation, SAFE_TX_GAS)) {
            adversarialSucceeded = true;
            adversarialKind = kind;
        }
    }

    /// @notice A rogue module may be enabled, but must never be able to act.
    function rogueModule(uint256 seed) external {
        if (!safe.isModuleEnabled(address(rogue))) {
            _exec(seed, false, address(safe), 0, abi.encodeCall(safe.enableModule, (address(rogue))), Enum.Operation.Call, SAFE_TX_GAS);
        }
        try rogue.drain(ISafe(payable(address(safe))), recipient) returns (bool ok) {
            if (ok) {
                adversarialSucceeded = true;
                adversarialKind = 100;
            }
        } catch {}
    }

    /// @notice Signature encodings that violate the executor rule. Must always revert.
    function badSignatures(uint256 seed, uint8 kindSeed, address relayer) external {
        uint256 kind = kindSeed % 3;
        address[] memory owners = safe.getOwners();
        uint256 threshold = safe.getThreshold();
        bytes32 hash = _hash(recipient, 1, "", Enum.Operation.Call, 0);
        address executor;
        address[] memory signers;
        bytes[] memory sigs;

        if (kind == 0) {
            if (safe.isOwner(relayer) || relayer == address(0)) relayer = address(0xCAFE);
            signers = _pick(owners, seed, threshold);
            sigs = new bytes[](threshold);
            for (uint256 i = 0; i < threshold; ++i) sigs[i] = _ecdsa(signers[i], hash, false);
            executor = relayer;
        } else if (kind == 1) {
            if (threshold + 1 > owners.length) return;
            signers = _pick(owners, seed, threshold + 1);
            executor = signers[0];
            sigs = new bytes[](threshold + 1);
            sigs[0] = _preValidated(executor);
            for (uint256 i = 1; i <= threshold; ++i) sigs[i] = _ecdsa(signers[i], hash, false);
        } else {
            if (threshold < 2) return;
            signers = _pick(owners, seed, threshold);
            executor = signers[0];
            sigs = new bytes[](threshold);
            sigs[0] = _preValidated(executor);
            vm.prank(signers[1]);
            safe.approveHash(hash);
            sigs[1] = _preValidated(signers[1]);
            for (uint256 i = 2; i < threshold; ++i) sigs[i] = _ecdsa(signers[i], hash, false);
        }

        vm.prank(executor);
        try safe.execTransaction(recipient, 1, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), _pack(signers, sigs)) {
            adversarialSucceeded = true;
            adversarialKind = 200 + kind;
        } catch {}
    }

    /*//////////////////////////////////////////////////////////////
                     LIVENESS PROBES (NOT TARGETED)
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether the escape hatch succeeds from the current state. State is restored afterwards.
    function probeEscape() external returns (bool ok) {
        uint256 snapshot = vm.snapshotState();
        ok = _exec(0, false, address(safe), 0, abi.encodeCall(safe.setGuard, (address(0))), Enum.Operation.Call, SAFE_TX_GAS);
        vm.revertToState(snapshot);
    }

    /// @notice Whether a transfer succeeds once every slot is refilled, when every slot has tree addresses left.
    function probeLiveness() external returns (bool ok) {
        uint256 snapshot = vm.snapshotState();
        _refillAll();
        address[] memory owners = safe.getOwners();
        ok = true;
        bool refillable = true;
        for (uint256 i = 0; i < owners.length; ++i) {
            (, uint256 slotId) = _slotOf(owners[i]);
            if (guard.getSlot(address(safe), slotId).staged.length == 0) refillable = false;
        }
        if (refillable) ok = _exec(1, false, recipient, 1, "", Enum.Operation.Call, SAFE_TX_GAS);
        bytes memory reason = lastRevert;
        vm.revertToState(snapshot);
        if (!ok) lastRevert = reason;
    }

    function exposedCount() external view returns (uint256) {
        return exposed.length;
    }

    function addressAt(uint256 slotId, uint256 index) external view returns (address) {
        return addressesOf[_treeId(slotId, genOf[slotId])][index];
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Behaves like the keeper. Skipped for one in five executions so that empty buffers stay reachable.
    function _refillAll() internal {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            (, uint256 slotId) = _slotOf(owners[i]);
            _stageSlot(slotId, guard.BUFFER_SIZE(), address(this));
        }
    }

    function _stageSlot(uint256 slotId, uint256 countSeed, address caller) internal {
        IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slotId);
        uint256 count = bound(countSeed, 1, guard.BUFFER_SIZE());
        if (view_.staged.length + count > guard.BUFFER_SIZE()) count = guard.BUFFER_SIZE() - view_.staged.length;
        if (view_.nextStageIndex + count > TREE_SIZE) count = TREE_SIZE - view_.nextStageIndex;
        if (count == 0) return;

        bytes32 treeId = _treeId(slotId, genOf[slotId]);
        IRotationGuard.StageEntry[] memory list = new IRotationGuard.StageEntry[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint32 index = view_.nextStageIndex + uint32(i);
            list[i] = IRotationGuard.StageEntry(index, addressesOf[treeId][index], MerkleBuilder.proof(leavesOf[treeId], index));
        }
        vm.prank(caller);
        try guard.stage(address(safe), slotId, list) {} catch {
            honestStageFailed = true;
        }
    }

    function _exec(
        uint256 seed,
        bool ethSign,
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 safeTxGas
    ) internal returns (bool executed) {
        if (seed % 5 != 0) _refillAll();
        address[] memory owners = safe.getOwners();
        uint256 threshold = safe.getThreshold();
        address[] memory signers = _pick(owners, seed, threshold);
        address executor = signers[0];
        bytes32 hash = _hash(to, value, data, operation, safeTxGas);
        bytes[] memory sigs = new bytes[](threshold);
        sigs[0] = _preValidated(executor);
        for (uint256 i = 1; i < threshold; ++i) sigs[i] = _ecdsa(signers[i], hash, ethSign);
        address[] memory signersCopy = new address[](threshold);
        for (uint256 i = 0; i < threshold; ++i) signersCopy[i] = signers[i];

        vm.prank(executor);
        try safe.execTransaction(to, value, data, operation, safeTxGas, 0, safeTxGas == 0 ? 0 : 1, address(0), payable(address(0)), _pack(signers, sigs)) returns (bool success) {
            executed = success;
            ++executions;
            bool escaped = to == address(safe) && keccak256(data) == keccak256(abi.encodeCall(safe.setGuard, (address(0))));
            for (uint256 i = 0; i < threshold; ++i) {
                exposed.push(signersCopy[i]);
                if (!escaped && safe.isOwner(signersCopy[i])) rotationMissed = true;
            }
        } catch (bytes memory reason) {
            lastRevert = reason;
        }

        for (uint256 i = 0; i < owners.length; ++i) {
            if (!safe.isOwner(owners[i])) retired[owners[i]] = true;
        }
    }

    function _pick(address[] memory owners, uint256 seed, uint256 count) internal pure returns (address[] memory picked) {
        picked = new address[](count);
        uint256 n;
        for (uint256 i = 0; n < count; ++i) {
            address candidate = owners[(seed % owners.length + i) % owners.length];
            bool taken;
            for (uint256 j = 0; j < n; ++j) if (picked[j] == candidate) taken = true;
            if (!taken) picked[n++] = candidate;
        }
    }

    function _randomSlot(uint256 seed) internal view returns (uint256 slotId) {
        address[] memory owners = safe.getOwners();
        (, slotId) = _slotOf(owners[seed % owners.length]);
    }

    function _slotOf(address owner) internal view returns (bool found, uint256 slotId) {
        if (owner == address(0)) return (false, 0);
        (, uint32 slotCount, ) = guard.getConfig(address(safe));
        for (uint256 id = 0; id < slotCount; ++id) {
            if (guard.getSlot(address(safe), id).owner == owner) return (true, id);
        }
        return (false, 0);
    }

    function _hash(address to, uint256 value, bytes memory data, Enum.Operation operation, uint256 safeTxGas)
        internal
        view
        returns (bytes32)
    {
        return safe.getTransactionHash(to, value, data, operation, safeTxGas, 0, safeTxGas == 0 ? 0 : 1, address(0), address(0), safe.nonce());
    }

    function _ecdsa(address signer, bytes32 hash, bool ethSign) internal view returns (bytes memory) {
        bytes32 digest = ethSign ? keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)) : hash;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[signer], digest);
        return abi.encodePacked(r, s, ethSign ? v + 4 : v);
    }

    function _preValidated(address signer) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(signer))), bytes32(0), uint8(1));
    }

    function _pack(address[] memory signers, bytes[] memory sigs) internal pure returns (bytes memory packed) {
        for (uint256 i = 1; i < signers.length; ++i) {
            for (uint256 j = i; j > 0 && signers[j - 1] > signers[j]; --j) {
                (signers[j - 1], signers[j]) = (signers[j], signers[j - 1]);
                (sigs[j - 1], sigs[j]) = (sigs[j], sigs[j - 1]);
            }
        }
        for (uint256 i = 0; i < sigs.length; ++i) packed = bytes.concat(packed, sigs[i]);
    }

    function _prevOwner(address owner) internal view returns (address) {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) if (owners[i] == owner) return i == 0 ? SENTINEL : owners[i - 1];
        return SENTINEL;
    }

    function _prevModule(address module) internal view returns (address) {
        (address[] memory modules, ) = safe.getModulesPaginated(SENTINEL, 10);
        for (uint256 i = 0; i < modules.length; ++i) if (modules[i] == module) return i == 0 ? SENTINEL : modules[i - 1];
        return SENTINEL;
    }

    function _treeId(uint256 slotId, uint256 gen) internal pure returns (bytes32) {
        return keccak256(abi.encode(slotId, gen));
    }

    /// @dev Generation 0 reproduces the fixture's trees, so the handler can sign for the initial owners.
    function _buildTree(uint256 slotId, uint256 gen) internal {
        bytes32 treeId = _treeId(slotId, gen);
        for (uint256 index = 0; index < TREE_SIZE; ++index) {
            bytes32 seed = gen == 0 ? keccak256(abi.encode("tree", slotId, index)) : keccak256(abi.encode("tree", slotId, index, gen));
            uint256 key = (uint256(seed) % (SECP256K1_N - 1)) + 1;
            address account = vm.addr(key);
            keyOf[account] = key;
            addressesOf[treeId].push(account);
            leavesOf[treeId].push(guard.leaf(address(safe), slotId, index, account));
        }
    }

    function _config(uint256 slotId, uint256 gen, uint32 index) internal view returns (IRotationGuard.SlotConfig memory) {
        bytes32 treeId = _treeId(slotId, gen);
        return IRotationGuard.SlotConfig(
            MerkleBuilder.root(leavesOf[treeId]), TREE_SIZE, index, addressesOf[treeId][index], MerkleBuilder.proof(leavesOf[treeId], index), "cid"
        );
    }
}

contract RotationGuardInvariantTest is RotationFixture {
    RotationHandler internal handler;
    uint256 internal initialBalance;

    function setUp() public override {
        super.setUp();
        handler = new RotationHandler(safe, guard, multiSend, SLOTS, legacyOwners, recipient);
        initialBalance = address(safe).balance;

        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = RotationHandler.execute.selector;
        selectors[1] = RotationHandler.execute.selector;
        selectors[2] = RotationHandler.stage.selector;
        selectors[3] = RotationHandler.stage.selector;
        selectors[4] = RotationHandler.stageArbitrary.selector;
        selectors[5] = RotationHandler.forceRotate.selector;
        selectors[6] = RotationHandler.skipTo.selector;
        selectors[7] = RotationHandler.setRoot.selector;
        selectors[8] = RotationHandler.changeThreshold.selector;
        selectors[9] = RotationHandler.removeSlot.selector;
        selectors[10] = RotationHandler.addSlot.selector;
        selectors[11] = RotationHandler.reinitialize.selector;
        selectors[12] = RotationHandler.adversarialTx.selector;
        selectors[13] = RotationHandler.rogueModule.selector;
        selectors[14] = RotationHandler.badSignatures.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Every signer of an executed transaction left the owner set in that same transaction.
    function invariant_signersRotatedInSameTx() public view {
        assertFalse(handler.rotationMissed());
    }

    /// @dev No key that signed an executed transaction is an owner now.
    function invariant_noExposedOwner() public view {
        uint256 count = handler.exposedCount();
        for (uint256 i = 0; i < count; ++i) assertFalse(safe.isOwner(handler.exposed(i)));
    }

    /// @dev No address that ever left the owner set comes back, through any path.
    function invariant_noRetiredOwnerReturns() public view {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) assertFalse(handler.retired(owners[i]));
    }

    /// @dev Retired addresses are never staged either.
    function invariant_noRetiredAddressStaged() public view {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            (, uint256 slotId) = slotOf(owners[i]);
            address[] memory staged = guard.getSlot(address(safe), slotId).staged;
            for (uint256 j = 0; j < staged.length; ++j) assertFalse(handler.retired(staged[j]));
        }
    }

    /// @dev The Safe's owners are exactly the slot owners, and the threshold is valid.
    function invariant_ownersMatchSlots() public view {
        address[] memory owners = safe.getOwners();
        (, , uint32 activeSlots) = guard.getConfig(address(safe));
        assertEq(owners.length, activeSlots);
        for (uint256 i = 0; i < owners.length; ++i) {
            (bool found, uint256 slotId) = slotOf(owners[i]);
            assertTrue(found);
            assertEq(guard.getSlot(address(safe), slotId).owner, owners[i]);
        }
        assertGe(safe.getThreshold(), 1);
        assertLe(safe.getThreshold(), owners.length);
    }

    /// @dev Buffers are bounded, ordered by tree index and hold the tree's addresses at those indexes.
    function invariant_buffersConsistent() public view {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            (, uint256 slotId) = slotOf(owners[i]);
            IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slotId);
            assertLe(view_.staged.length, guard.BUFFER_SIZE());
            assertEq(view_.nextIndex + view_.staged.length, view_.nextStageIndex);
            assertLe(view_.nextStageIndex, view_.size);
            for (uint256 j = 0; j < view_.staged.length; ++j) {
                assertEq(view_.staged[j], handler.addressAt(slotId, view_.nextIndex + j));
                assertFalse(safe.isOwner(view_.staged[j]));
            }
        }
    }

    /// @dev Honest staging never fails, and dishonest staging never succeeds.
    function invariant_stagingSound() public view {
        assertFalse(handler.honestStageFailed());
        assertFalse(handler.badStageAccepted());
    }

    /// @dev No adversarial transaction, rogue module or bad signature encoding ever succeeds.
    function invariant_adversarialNeverSucceeds() public view {
        assertFalse(handler.adversarialSucceeded(), vm.toString(handler.adversarialKind()));
    }

    /// @dev ETH only leaves the Safe through honest transfers.
    function invariant_balanceAccounted() public view {
        assertEq(address(safe).balance, initialBalance - handler.transferred());
    }

    /// @dev Hooks stay installed.
    function invariant_hooksInstalled() public view {
        assertEq(address(uint160(uint256(vm.load(address(safe), 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)))), address(guard));
        assertEq(address(uint160(uint256(vm.load(address(safe), 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947)))), address(guard));
        assertTrue(safe.isModuleEnabled(address(guard)));
    }

    /// @dev The Safe can always leave through the escape hatch, from any reachable state.
    function invariant_escapeAlwaysPossible() public {
        assertTrue(handler.probeEscape());
    }

    /// @dev Once buffers are refilled, owners can always execute. The guard never bricks the Safe.
    function invariant_liveAfterRefill() public {
        bool ok = handler.probeLiveness();
        assertTrue(ok, vm.toString(handler.lastRevert()));
    }
}
