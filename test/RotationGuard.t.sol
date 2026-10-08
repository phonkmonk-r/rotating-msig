// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Enum} from "@safe/libraries/Enum.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";

import {RotationGuard} from "../src/RotationGuard.sol";
import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {MerkleBuilder} from "./utils/MerkleBuilder.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";
import {Reentrant, Reverter, RogueModule} from "./utils/Actors.sol";

contract RotationGuardTest is RotationFixture {
    /*//////////////////////////////////////////////////////////////
                               SETUP
    //////////////////////////////////////////////////////////////*/

    function test_setup_replacesLegacyOwnersWithIndexZero() public view {
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            assertTrue(safe.isOwner(treeAddress(slot, 0)));
            assertFalse(safe.isOwner(legacyOwners[slot]));
            IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slot);
            assertEq(view_.owner, treeAddress(slot, 0));
            assertEq(view_.nextIndex, 1);
            assertEq(view_.nextStageIndex, 6);
            assertEq(view_.staged.length, 5);
            assertEq(view_.staged[0], treeAddress(slot, 1));
        }
        (uint64 epoch, uint32 slotCount, uint32 activeSlots) = guard.getConfig(address(safe));
        assertEq(epoch, 1);
        assertEq(slotCount, SLOTS);
        assertEq(activeSlots, SLOTS);
    }

    function test_supportsInterfaces() public view {
        assertTrue(guard.supportsInterface(0xe6d7a83a));
        assertTrue(guard.supportsInterface(0x58401ed8));
        assertTrue(guard.supportsInterface(0x01ffc9a7));
        assertFalse(guard.supportsInterface(0xffffffff));
    }

    /*//////////////////////////////////////////////////////////////
                              ROTATION
    //////////////////////////////////////////////////////////////*/

    function test_rotatesSignerAndExecutor() public {
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        address bystander = currentOwner(2);

        assertTrue(execBySlots(call(recipient, 1 ether, ""), 0, 1));

        assertEq(recipient.balance, 1 ether);
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
        assertTrue(safe.isOwner(bystander));
        assertEq(currentOwner(0), treeAddress(0, 1));
        assertEq(currentOwner(1), treeAddress(1, 1));
        assertEq(currentOwner(2), bystander);
        (bool found, ) = guard.slotOf(address(safe), signer);
        assertFalse(found);
        (found, ) = guard.slotOf(address(safe), executor);
        assertFalse(found);
        uint256 slotId;
        (found, slotId) = guard.slotOf(address(safe), treeAddress(0, 1));
        assertTrue(found);
        assertEq(slotId, 0);
        assertEq(guard.getSlot(address(safe), 0).staged.length, 4);
        assertEq(guard.getSlot(address(safe), 2).staged.length, 5);
    }

    function test_rotatesThroughEntireTreeWithRefills() public {
        for (uint256 i = 1; i < TREE_SIZE; ++i) {
            refillAll();
            assertTrue(execBySlots(call(recipient, 1, ""), 0, 1));
            assertEq(currentOwner(0), treeAddress(0, i));
            assertEq(currentOwner(1), treeAddress(1, i));
        }
        assertEq(guard.getSlot(address(safe), 0).nextIndex, TREE_SIZE);
        (bytes memory sigs, address executor) = prepareBySlots(call(recipient, 1, ""), 0, 1);
        vm.expectPartialRevert(IRotationGuard.BufferEmpty.selector);
        execRaw(call(recipient, 1, ""), sigs, executor);
    }

    function test_rotatesEthSignSigner() public {
        address signer = currentOwner(2);
        address executor = currentOwner(0);
        SafeTx memory t = call(recipient, 1, "");
        address[] memory ecdsaSigners = new address[](1);
        ecdsaSigners[0] = signer;
        assertTrue(execRaw(t, signatures(t, ecdsaSigners, executor, true), executor));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
    }

    function test_rotatesWhenInnerCallFails() public {
        Reverter reverter = new Reverter();
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        SafeTx memory t = call(address(reverter), 0, abi.encodeCall(Reverter.boom, ()));
        t.safeTxGas = 100_000;
        assertFalse(exec(t, signer, executor));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
    }

    function test_rotatesThroughMultiSend() public {
        bytes memory batch = bytes.concat(packCall(recipient, 1, ""), packCall(recipient, 2, ""));
        assertTrue(execBySlots(multiSendTx(batch), 2, 0));
        assertEq(recipient.balance, 3);
        assertEq(currentOwner(2), treeAddress(2, 1));
        assertEq(currentOwner(0), treeAddress(0, 1));
    }

    function test_thresholdOne_executorAlone() public {
        assertTrue(execBySlots(call(address(safe), 0, abi.encodeCall(safe.changeThreshold, (1))), 0, 1));
        address executor = currentOwner(2);
        SafeTx memory t = call(recipient, 1, "");
        assertTrue(execRaw(t, preValidatedSignature(executor), executor));
        assertFalse(safe.isOwner(executor));
        assertEq(currentOwner(2), treeAddress(2, 1));
    }

    /*//////////////////////////////////////////////////////////////
                           EXECUTOR RULE
    //////////////////////////////////////////////////////////////*/

    function test_revert_executorNotSigner() public {
        address relayer = makeAddr("relayer");
        SafeTx memory t = call(recipient, 1, "");
        bytes32 hash = txHash(t);
        address[] memory signers = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        signers[0] = currentOwner(0);
        signers[1] = currentOwner(1);
        sigs[0] = ecdsaSignature(signers[0], hash, false);
        sigs[1] = ecdsaSignature(signers[1], hash, false);
        bytes memory packed = packSignatures(signers, sigs);

        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ExecutorMustSign.selector, relayer));
        execRaw(t, packed, relayer);

        address otherOwner = currentOwner(2);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ExecutorMustSign.selector, otherOwner));
        execRaw(t, packed, otherOwner);
    }

    function test_revert_approvedHashFromNonExecutor() public {
        address approver = currentOwner(0);
        address executor = currentOwner(1);
        SafeTx memory t = call(recipient, 1, "");
        bytes32 hash = txHash(t);
        vm.prank(approver);
        safe.approveHash(hash);

        address[] memory signers = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        signers[0] = approver;
        signers[1] = executor;
        sigs[0] = preValidatedSignature(approver);
        sigs[1] = preValidatedSignature(executor);

        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ApprovedHashNotAllowed.selector, approver));
        execRaw(t, packSignatures(signers, sigs), executor);
    }

    function test_revert_extraSignature() public {
        SafeTx memory t = call(recipient, 1, "");
        address[] memory ecdsaSigners = new address[](2);
        ecdsaSigners[0] = currentOwner(0);
        ecdsaSigners[1] = currentOwner(2);
        address executor = currentOwner(1);
        bytes memory sigs = signatures(t, ecdsaSigners, executor, false);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.UnexpectedSignatureLength.selector, 195, 130));
        execRaw(t, sigs, executor);
    }

    /*//////////////////////////////////////////////////////////////
                           RESTRICTIONS
    //////////////////////////////////////////////////////////////*/

    function test_revert_emptyBuffer() public {
        for (uint256 i = 0; i < 5; ++i) execBySlots(call(recipient, 1, ""), 0, 2);
        (bytes memory sigs, address executor) = prepareBySlots(call(recipient, 1, ""), 0, 2);
        vm.expectPartialRevert(IRotationGuard.BufferEmpty.selector);
        execRaw(call(recipient, 1, ""), sigs, executor);
    }

    function test_revert_directOwnerChange() public {
        address outsider = makeAddr("outsider");
        (bytes memory sigs, address executor) = prepareBySlots(call(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (outsider, 2))), 0, 1);
        vm.expectRevert(IRotationGuard.OwnerSetMismatch.selector);
        execRaw(call(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (outsider, 2))), sigs, executor);
    }

    function test_revert_delegateCallToOtherTarget() public {
        SafeTx memory t = call(address(new Reverter()), 0, "");
        t.operation = Enum.Operation.DelegateCall;
        (bytes memory sigs, address executor) = prepareBySlots(t, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.DelegateCallNotAllowed.selector, t.to));
        execRaw(t, sigs, executor);
    }

    function test_revert_removingModuleGuard() public {
        (bytes memory sigs, address executor) = prepareBySlots(call(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(0)))), 0, 1);
        vm.expectRevert(IRotationGuard.HooksRemoved.selector);
        execRaw(call(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(0)))), sigs, executor);
    }

    function test_revert_replacingGuard() public {
        address otherGuard = address(new RotationGuard(address(multiSend)));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(safe), 0, abi.encodeCall(safe.setGuard, (otherGuard))), 0, 1);
        vm.expectRevert(IRotationGuard.HooksRemoved.selector);
        execRaw(call(address(safe), 0, abi.encodeCall(safe.setGuard, (otherGuard))), sigs, executor);
    }

    function test_revert_rogueModuleBlocked() public {
        RogueModule rogue = new RogueModule();
        assertTrue(execBySlots(call(address(safe), 0, abi.encodeCall(safe.enableModule, (address(rogue)))), 0, 1));
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ModuleTransactionNotAllowed.selector, address(rogue)));
        rogue.drain(ISafe(payable(address(safe))), recipient);
    }

    function test_revert_rogueModuleOwnerCall() public {
        RogueModule rogue = new RogueModule();
        assertTrue(execBySlots(call(address(safe), 0, abi.encodeCall(safe.enableModule, (address(rogue)))), 0, 1));
        address victim = currentOwner(0);
        bytes memory data = abi.encodeCall(safe.swapOwner, (_prev(victim), victim, makeAddr("attacker")));
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ModuleTransactionNotAllowed.selector, address(rogue)));
        rogue.call(ISafe(payable(address(safe))), data);
    }

    function test_revert_moduleGuardRejectsNonOwnerCallFromGuard() public {
        bytes memory data = abi.encodeCall(safe.enableModule, (makeAddr("module")));
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.ModuleTransactionNotAllowed.selector, address(guard)));
        guard.checkModuleTransaction(address(safe), 0, data, Enum.Operation.Call, address(guard));
    }

    function test_moduleGuardAllowsOwnerCallsFromGuard() public {
        bytes[3] memory calls = [
            abi.encodeCall(safe.swapOwner, (address(0x1), address(0x2), address(0x3))),
            abi.encodeCall(safe.addOwnerWithThreshold, (address(0x2), 1)),
            abi.encodeCall(safe.removeOwner, (address(0x1), address(0x2), 1))
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            vm.prank(address(safe));
            guard.checkModuleTransaction(address(safe), 0, calls[i], Enum.Operation.Call, address(guard));
        }
    }

    function _prev(address owner) private view returns (address) {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 1; i < owners.length; ++i) if (owners[i] == owner) return owners[i - 1];
        return address(0x1);
    }

    function test_revert_nestedExecution() public {
        Reentrant reentrant = new Reentrant();
        SafeTx memory inner = call(recipient, 1, "");
        bytes32 innerHash = safe.getTransactionHash(
            inner.to, inner.value, inner.data, inner.operation, 0, 0, 0, address(0), payable(address(0)), safe.nonce() + 1
        );
        address[] memory signers = new address[](2);
        bytes[] memory innerSigs = new bytes[](2);
        signers[0] = currentOwner(0);
        signers[1] = currentOwner(2);
        innerSigs[0] = ecdsaSignature(signers[0], innerHash, false);
        innerSigs[1] = ecdsaSignature(signers[1], innerHash, false);
        bytes memory payload = abi.encodeCall(
            safe.execTransaction,
            (inner.to, inner.value, inner.data, inner.operation, 0, 0, 0, address(0), payable(address(0)), packSignatures(signers, innerSigs))
        );

        SafeTx memory outer = call(address(reentrant), 0, abi.encodeCall(Reentrant.reenter, (address(safe), payload)));
        (bytes memory sigs, address executor) = prepareBySlots(outer, 0, 1);
        vm.expectRevert(IRotationGuard.NestedExecution.selector);
        execRaw(outer, sigs, executor);
    }

    function test_revert_hooksCalledDirectly() public {
        vm.expectRevert(IRotationGuard.NoTransactionInProgress.selector);
        guard.checkAfterExecution(bytes32(0), true);
    }

    /*//////////////////////////////////////////////////////////////
                            ESCAPE HATCH
    //////////////////////////////////////////////////////////////*/

    function test_escapeHatch_worksWithEmptyBuffers() public {
        for (uint256 i = 0; i < 5; ++i) execBySlots(call(recipient, 1, ""), 0, 1);
        address signer = currentOwner(0);
        address executor = currentOwner(2);

        assertTrue(exec(call(address(safe), 0, abi.encodeCall(safe.setGuard, (address(0)))), signer, executor));

        bytes32 guardSlot = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
        assertEq(vm.load(address(safe), guardSlot), bytes32(0));
        assertTrue(safe.isOwner(signer));

        address[] memory ecdsaSigners = new address[](1);
        ecdsaSigners[0] = signer;
        SafeTx memory t = call(recipient, 1, "");
        assertTrue(execRaw(t, signatures(t, ecdsaSigners, executor, false), executor));
    }

    /*//////////////////////////////////////////////////////////////
                              STAGING
    //////////////////////////////////////////////////////////////*/

    function test_stage_permissionless() public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        vm.prank(makeAddr("keeper"));
        guard.stage(address(safe), 0, entries(0, 6, 1));
        IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), 0);
        assertEq(view_.staged.length, 5);
        assertEq(view_.staged[4], treeAddress(0, 6));
        assertEq(view_.nextStageIndex, 7);
    }

    function test_revert_stage_full() public {
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.BufferFull.selector, 0));
        guard.stage(address(safe), 0, entries(0, 6, 1));
    }

    function test_revert_stage_skipsIndex() public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.NonSequentialIndex.selector, 7, 6));
        guard.stage(address(safe), 0, entries(0, 7, 1));
    }

    function test_revert_stage_invalidProof() public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        IRotationGuard.StageEntry[] memory list = entries(0, 6, 1);
        list[0].owner = makeAddr("attacker");
        vm.expectRevert(IRotationGuard.InvalidProof.selector);
        guard.stage(address(safe), 0, list);
    }

    function test_revert_stage_proofFromOtherSlot() public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        IRotationGuard.StageEntry[] memory list = entries(1, 6, 1);
        vm.expectRevert(IRotationGuard.InvalidProof.selector);
        guard.stage(address(safe), 0, list);
    }

    function test_revert_stage_currentOwner() public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        IRotationGuard.StageEntry[] memory list = entries(0, 6, 1);
        list[0].owner = currentOwner(2);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.InvalidOwner.selector, currentOwner(2)));
        guard.stage(address(safe), 0, list);
    }

    function test_revert_stage_unknownSlot() public {
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.UnknownSlot.selector, 7));
        guard.stage(address(safe), 7, entries(0, 6, 1));
    }

    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_forceRotate_burnedOwner() public {
        address burned = currentOwner(2);
        uint256[] memory slots = new uint256[](1);
        slots[0] = 2;
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.forceRotate, (slots))), 0, 1));
        assertFalse(safe.isOwner(burned));
        assertEq(currentOwner(2), treeAddress(2, 1));
        assertEq(currentOwner(0), treeAddress(0, 1));
        assertEq(currentOwner(1), treeAddress(1, 1));
    }

    function test_forceRotate_signerRotatedOnce() public {
        uint256[] memory slots = new uint256[](1);
        slots[0] = 0;
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.forceRotate, (slots))), 0, 1));
        assertEq(currentOwner(0), treeAddress(0, 1));
        assertEq(guard.getSlot(address(safe), 0).staged.length, 4);
    }

    function test_skipTo() public {
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.skipTo, (2, 9))), 0, 1));
        IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), 2);
        assertEq(view_.staged.length, 0);
        assertEq(view_.nextStageIndex, 9);
        guard.stage(address(safe), 2, entries(2, 9, 2));
        assertTrue(execBySlots(call(recipient, 1, ""), 2, 0));
        assertEq(currentOwner(2), treeAddress(2, 9));
    }

    function test_revert_skipTo_backwards() public {
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, abi.encodeCall(guard.skipTo, (2, 0))), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.IndexOutOfRange.selector, 0));
        execRaw(call(address(guard), 0, abi.encodeCall(guard.skipTo, (2, 0))), sigs, executor);
    }

    function test_setRoot() public {
        bytes32 newRoot = keccak256("root");
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.setRoot, (2, newRoot, 100, 0, "cid2"))), 0, 1));
        IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), 2);
        assertEq(view_.root, newRoot);
        assertEq(view_.size, 100);
        assertEq(view_.staged.length, 0);
        assertEq(view_.nextStageIndex, 0);
    }

    function test_removeSlot() public {
        address removed = currentOwner(2);
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.removeSlot, (2, 2))), 0, 1));
        assertFalse(safe.isOwner(removed));
        assertEq(safe.getOwners().length, 2);
        (, , uint32 activeSlots) = guard.getConfig(address(safe));
        assertEq(activeSlots, 2);
    }

    function test_removeSlot_ofSigner() public {
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.removeSlot, (0, 2))), 0, 1));
        assertEq(safe.getOwners().length, 2);
        assertEq(currentOwner(1), treeAddress(1, 1));
    }

    function test_addSlot() public {
        uint256 newSlot = SLOTS;
        bytes32[] memory leaves = new bytes32[](4);
        uint256[] memory keys = new uint256[](4);
        for (uint256 i = 0; i < 4; ++i) {
            keys[i] = (uint256(keccak256(abi.encode("new", i))) % (SECP256K1_N - 1)) + 1;
            leaves[i] = guard.leaf(address(safe), newSlot, i, vm.addr(keys[i]));
        }
        IRotationGuard.SlotConfig memory config = IRotationGuard.SlotConfig(
            _root(leaves), 4, 0, vm.addr(keys[0]), _proof(leaves, 0), "cid3"
        );
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.addSlot, (config, 2))), 0, 1));
        assertTrue(safe.isOwner(vm.addr(keys[0])));
        assertEq(safe.getOwners().length, 4);
        (bool found, uint256 slotId) = guard.slotOf(address(safe), vm.addr(keys[0]));
        assertTrue(found);
        assertEq(slotId, newSlot);
    }

    function test_revert_adminRequiresInitializedCaller() public {
        uint256[] memory slots = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.NotInitialized.selector, address(this)));
        guard.forceRotate(slots);
    }

    function test_reinitialize_newEpoch() public {
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](SLOTS);
        address[] memory oldOwners = new address[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            configs[slot] = slotConfig(slot, 10);
            oldOwners[slot] = currentOwner(slot);
        }
        bytes memory batch = packCall(address(guard), 0, abi.encodeCall(guard.initialize, (oldOwners, configs)));
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            batch = bytes.concat(batch, packCall(address(guard), 0, abi.encodeCall(guard.stage, (address(safe), slot, entries(slot, 11, 2)))));
        }
        assertTrue(execBySlots(multiSendTx(batch), 0, 1));

        (uint64 epoch, , ) = guard.getConfig(address(safe));
        assertEq(epoch, 2);
        for (uint256 slot = 0; slot < SLOTS; ++slot) assertEq(currentOwner(slot), treeAddress(slot, 10));

        assertTrue(execBySlots(call(recipient, 1, ""), 0, 1));
        assertEq(currentOwner(0), treeAddress(0, 11));
    }

    function test_revert_setRoot_reusesConsumedIndex() public {
        assertTrue(execBySlots(call(recipient, 1, ""), 2, 1));
        bytes memory data = abi.encodeCall(guard.setRoot, (2, rootOf[2], TREE_SIZE, 0, "cid"));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, data), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.RootIndexConsumed.selector, rootOf[2], 0, 2));
        execRaw(call(address(guard), 0, data), sigs, executor);
    }

    function test_setRoot_sameRootFromNextIndex() public {
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.setRoot, (2, rootOf[2], TREE_SIZE, 1, "cid"))), 0, 1));
        assertEq(guard.consumedUpTo(address(safe), rootOf[2]), 1);
        guard.stage(address(safe), 2, entries(2, 1, 1));
        assertTrue(execBySlots(call(recipient, 1, ""), 2, 0));
        assertEq(currentOwner(2), treeAddress(2, 1));
    }

    function test_revert_reinitialize_reusesConsumedIndex() public {
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](SLOTS);
        address[] memory oldOwners = new address[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            configs[slot] = slotConfig(slot, 0);
            oldOwners[slot] = currentOwner(slot);
        }
        bytes memory data = abi.encodeCall(guard.initialize, (oldOwners, configs));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, data), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.RootIndexConsumed.selector, rootOf[0], 0, 1));
        execRaw(call(address(guard), 0, data), sigs, executor);
    }

    function test_removeSlot_recordsConsumed() public {
        assertTrue(execBySlots(call(recipient, 1, ""), 2, 1));
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.removeSlot, (2, 2))), 0, 1));
        assertEq(guard.consumedUpTo(address(safe), rootOf[2]), 2);
    }

    function test_setGuardCalldataToOtherTargetIsGuarded() public {
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        assertTrue(exec(call(recipient, 0, abi.encodeCall(safe.setGuard, (address(0)))), signer, executor));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
        bytes32 guardSlot = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
        assertEq(address(uint160(uint256(vm.load(address(safe), guardSlot)))), address(guard));
    }

    function test_revert_stage_beyondCommittedSize() public {
        bytes memory data = abi.encodeCall(guard.setRoot, (2, rootOf[2], 7, 6, "cid"));
        assertTrue(execBySlots(call(address(guard), 0, data), 0, 1));
        guard.stage(address(safe), 2, entries(2, 6, 1));
        IRotationGuard.StageEntry[] memory list = entries(2, 7, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.IndexOutOfRange.selector, 7));
        guard.stage(address(safe), 2, list);
    }

    function test_revert_stage_duplicateAddressInTree() public {
        uint256 newSlot = SLOTS;
        address dup = vm.addr(0xD0D0);
        bytes32[] memory leaves = new bytes32[](4);
        leaves[0] = guard.leaf(address(safe), newSlot, 0, vm.addr(0xA0A0));
        leaves[1] = guard.leaf(address(safe), newSlot, 1, dup);
        leaves[2] = guard.leaf(address(safe), newSlot, 2, dup);
        leaves[3] = guard.leaf(address(safe), newSlot, 3, vm.addr(0xB0B0));
        IRotationGuard.SlotConfig memory config =
            IRotationGuard.SlotConfig(_root(leaves), 4, 0, vm.addr(0xA0A0), _proof(leaves, 0), "cid");
        assertTrue(execBySlots(call(address(guard), 0, abi.encodeCall(guard.addSlot, (config, 2))), 0, 1));

        IRotationGuard.StageEntry[] memory list = new IRotationGuard.StageEntry[](2);
        list[0] = IRotationGuard.StageEntry(1, dup, _proof(leaves, 1));
        list[1] = IRotationGuard.StageEntry(2, dup, _proof(leaves, 2));
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.InvalidOwner.selector, dup));
        guard.stage(address(safe), newSlot, list);
    }

    function test_revert_addSlot_invalidProof() public {
        IRotationGuard.SlotConfig memory config = slotConfig(0, 9);
        config.proof = proofOf(0, 10);
        bytes memory data = abi.encodeCall(guard.addSlot, (config, 2));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, data), 0, 1);
        vm.expectRevert(IRotationGuard.InvalidProof.selector);
        execRaw(call(address(guard), 0, data), sigs, executor);
    }

    function test_revert_initialize_invalidProof() public {
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](SLOTS);
        address[] memory oldOwners = new address[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            configs[slot] = slotConfig(slot, 10);
            oldOwners[slot] = currentOwner(slot);
        }
        configs[1].owner = makeAddr("attacker");
        bytes memory data = abi.encodeCall(guard.initialize, (oldOwners, configs));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, data), 0, 1);
        vm.expectRevert(IRotationGuard.InvalidProof.selector);
        execRaw(call(address(guard), 0, data), sigs, executor);
    }

    function test_revert_addSlot_existingOwner() public {
        address existing = currentOwner(2);
        IRotationGuard.SlotConfig memory config = slotConfig(0, 9);
        config.owner = existing;
        bytes memory data = abi.encodeCall(guard.addSlot, (config, 2));
        (bytes memory sigs, address executor) = prepareBySlots(call(address(guard), 0, data), 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IRotationGuard.InvalidOwner.selector, existing));
        execRaw(call(address(guard), 0, data), sigs, executor);
    }

    function _root(bytes32[] memory leaves) private pure returns (bytes32) {
        return MerkleBuilder.root(leaves);
    }

    function _proof(bytes32[] memory leaves, uint256 index) private pure returns (bytes32[] memory) {
        return MerkleBuilder.proof(leaves, index);
    }
}
