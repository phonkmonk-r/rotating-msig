// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {Safe} from "@safe/Safe.sol";

import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";
import {Reverter} from "./utils/Actors.sol";

/// @notice Regression tests for the security review findings. Each test states the attack and the behaviour the fix
///         enforces; the "before the fix" assertions are in the comments.
contract RotationGuardPoCTest is RotationFixture {
    address internal constant SENTINEL = address(0x1);
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant MODULE_GUARD_STORAGE_SLOT = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    address internal attacker = makeAddr("attacker");

    /*//////////////////////////////////////////////////////////////
        Finding 1: re-arming the hook state machine from inside a
        guarded transaction to skip the post-execution checks
    //////////////////////////////////////////////////////////////*/

    function _fakeCheckTransaction() internal view returns (bytes memory) {
        bytes memory escapeData = abi.encodeCall(safe.setGuard, (address(0)));
        return abi.encodeCall(
            guard.checkTransaction,
            (address(safe), 0, escapeData, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0))
        );
    }

    /// @dev Before the fix this batch was accepted: the inner `checkAfterExecution` reset the state, the inner
    ///      `checkTransaction` with escape-shaped arguments set TX_ESCAPE, and the Safe's real after-hook returned
    ///      without checking anything. The attacker ended up as sole owner with threshold 1 and no guard.
    function test_finding1_reArmToEscapeIsRejected() public {
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(guard), 0, _fakeCheckTransaction()),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1))),
            packCall(address(safe), 0, abi.encodeCall(safe.setGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.disableModule, (SENTINEL, address(guard))))
        );
        (bytes memory sigs, address executor) = prepareBySlots(multiSendTx(batch), 0, 1);
        vm.expectRevert(IRotationGuard.InvalidEscape.selector);
        execRaw(multiSendTx(batch), sigs, executor);
        assertFalse(safe.isOwner(attacker));
        assertEq(_readAddress(GUARD_STORAGE_SLOT), address(guard));
    }

    /// @dev The same re-arm that only adds an owner (keeps the hooks) is rejected too: an escape must remove the guard.
    function test_finding1_reArmWithoutRemovingGuardIsRejected() public {
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(guard), 0, _fakeCheckTransaction()),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1)))
        );
        (bytes memory sigs, address executor) = prepareBySlots(multiSendTx(batch), 0, 1);
        vm.expectRevert(IRotationGuard.InvalidEscape.selector);
        execRaw(multiSendTx(batch), sigs, executor);
    }

    /// @dev Re-arming to a non-escape state needs `threshold` signatures from current owners over this transaction's
    ///      hash. The real signatures cannot be embedded (the hash covers the payload that would carry them), and
    ///      the real signers were just rotated out by the inner after-hook, so any such signature fails
    ///      `SignerNotOwner`. The inner batch reverts, which also rolls back the inner after-hook's state reset, so
    ///      the Safe's real after-hook runs with the original signers and every check.
    function test_finding1_reArmWithStaleSignaturesFails() public {
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        bytes memory staleSigs = signatures(call(recipient, 1, ""), _one(signer), executor, false);
        bytes memory reArm = abi.encodeCall(
            guard.checkTransaction,
            (recipient, 1, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), staleSigs, executor)
        );
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(guard), 0, reArm),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1)))
        );
        assertFalse(exec(multiSendTx(batch), signer, executor), "the inner batch fails");
        assertFalse(safe.isOwner(attacker));
        assertFalse(safe.isOwner(signer), "signers still rotate");
        assertFalse(safe.isOwner(executor));
        assertEq(_readAddress(GUARD_STORAGE_SLOT), address(guard));
    }

    /// @dev The genuine escape hatch still works, including from an uninitialized or otherwise broken configuration.
    function test_finding1_genuineEscapeStillWorks() public {
        for (uint256 i = 0; i < 5; ++i) assertTrue(execBySlots(call(recipient, 1, ""), 0, 1));
        address signer = currentOwner(0);
        address executor = currentOwner(2);
        SafeTx memory t = call(address(safe), 0, abi.encodeCall(safe.setGuard, (address(0))));
        t.safeTxGas = 0;
        assertTrue(exec(t, signer, executor));
        assertEq(_readAddress(GUARD_STORAGE_SLOT), address(0));
        assertTrue(safe.isOwner(signer), "escape does not rotate");
        assertTrue(safe.isModuleEnabled(address(guard)), "escape leaves the module for the owners to remove");
    }

    /*//////////////////////////////////////////////////////////////
        Finding 2: safeTxGas == 0 && gasPrice == 0 let a failing inner
        call revert the whole transaction, undoing the rotation
    //////////////////////////////////////////////////////////////*/

    /// @dev Before the fix this reverted with the inner reason (GS013 path) and left both signers as owners with
    ///      their signatures public. Now the guard rejects the transaction up front, before anything is exposed to a
    ///      simulating client.
    function test_finding2_zeroSafeTxGasIsRejected() public {
        SafeTx memory t = call(recipient, 1, "");
        t.safeTxGas = 0;
        (bytes memory sigs, address executor) = prepareBySlots(t, 0, 1);
        vm.expectRevert(IRotationGuard.SafeTxGasRequired.selector);
        execRaw(t, sigs, executor);
    }

    /// @dev A non-zero gasPrice also stops Safe from reverting on inner failure, so the guard accepts it.
    function test_finding2_nonZeroGasPriceIsAccepted() public {
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        SafeTx memory t = call(recipient, 1, "");
        bytes32 hash = safe.getTransactionHash(t.to, t.value, t.data, t.operation, 0, 0, 1, address(0), payable(address(0)), safe.nonce());
        address[] memory signers = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        signers[0] = signer;
        signers[1] = executor;
        sigs[0] = ecdsaSignature(signer, hash, false);
        sigs[1] = preValidatedSignature(executor);
        vm.prank(executor);
        assertTrue(safe.execTransaction(t.to, t.value, t.data, t.operation, 0, 0, 1, address(0), payable(address(0)), packSignatures(signers, sigs)));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
    }

    /// @dev With safeTxGas set, a failing inner call burns the nonce and rotates every signer, as documented.
    function test_finding2_innerFailureStillRotates() public {
        Reverter reverter = new Reverter();
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        uint256 nonceBefore = safe.nonce();
        assertFalse(exec(call(address(reverter), 0, abi.encodeCall(Reverter.boom, ())), signer, executor));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
        assertEq(safe.nonce(), nonceBefore + 1);
    }

    /// @dev Front-running the staging inside a guarded batch now only fails the batch; the signers still rotate.
    function test_finding2_frontRunStageNoLongerBlocksRotation() public {
        assertTrue(execBySlots(call(recipient, 1, ""), 0, 1));
        assertEq(guard.getSlot(address(safe), 0).nextStageIndex, 6);

        address signer = currentOwner(0);
        address executor = currentOwner(2);
        bytes memory batch = bytes.concat(
            packCall(recipient, 1, ""),
            packCall(address(guard), 0, abi.encodeCall(guard.stage, (address(safe), 0, entries(0, 6, 1))))
        );
        vm.prank(attacker);
        guard.stage(address(safe), 0, entries(0, 6, 1));

        assertFalse(exec(multiSendTx(batch), signer, executor));
        assertFalse(safe.isOwner(signer));
        assertFalse(safe.isOwner(executor));
    }

    /// @dev After a failed inner call the exposed keys are no longer owners, so they cannot be used to drain.
    function test_finding2_exposedKeysOfFailedCallCannotDrain() public {
        Reverter reverter = new Reverter();
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        assertFalse(exec(call(address(reverter), 0, abi.encodeCall(Reverter.boom, ())), signer, executor));

        SafeTx memory drain = call(attacker, address(safe).balance, "");
        bytes memory sigs = signatures(drain, _one(signer), executor, false);
        vm.prank(executor);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(drain.to, drain.value, drain.data, drain.operation, drain.safeTxGas, 0, 0, address(0), payable(address(0)), sigs);
        assertEq(attacker.balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
        Finding 3: initialize without the hooks installed
    //////////////////////////////////////////////////////////////*/

    /// @dev Before the fix a Safe could enable the module and initialize without setting the guards, ending up with
    ///      fresh owners and no rotation.
    function test_finding3_initializeRequiresHooksInstalled() public {
        address[] memory owners = new address[](2);
        owners[0] = _register(uint256(keccak256("plain-0")));
        owners[1] = _register(uint256(keccak256("plain-1")));
        bytes memory init = abi.encodeCall(Safe.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0))));
        Safe plain = Safe(payable(address(factory.createProxyWithNonce(address(singleton), init, 1))));

        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](2);
        for (uint256 s = 0; s < 2; ++s) {
            bytes32[] memory leaves = new bytes32[](2);
            for (uint256 i = 0; i < 2; ++i) leaves[i] = guard.leaf(address(plain), s, i, _plainTreeAddress(s, i));
            bytes32[] memory proof = new bytes32[](1);
            proof[0] = leaves[1];
            bytes32 root = leaves[0] < leaves[1] ? keccak256(abi.encodePacked(leaves[0], leaves[1])) : keccak256(abi.encodePacked(leaves[1], leaves[0]));
            configs[s] = IRotationGuard.SlotConfig(root, 2, 0, _plainTreeAddress(s, 0), proof, "");
        }

        vm.startPrank(address(plain));
        plain.enableModule(address(guard));
        vm.expectRevert(IRotationGuard.HooksRemoved.selector);
        guard.initialize(owners, configs);

        plain.setGuard(address(guard));
        vm.expectRevert(IRotationGuard.HooksRemoved.selector);
        guard.initialize(owners, configs);

        plain.setModuleGuard(address(guard));
        guard.initialize(owners, configs);
        vm.stopPrank();
        assertTrue(plain.isOwner(_plainTreeAddress(0, 0)));
    }

    function _plainTreeAddress(uint256 slot, uint256 index) internal returns (address) {
        return _register(uint256(keccak256(abi.encode("plain-tree", slot, index))));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _readAddress(bytes32 slot) internal view returns (address) {
        return address(uint160(uint256(bytes32(safe.getStorageAt(uint256(slot), 1)))));
    }
}
