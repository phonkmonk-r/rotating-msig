// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {Safe} from "@safe/Safe.sol";

import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {MerkleBuilder} from "./utils/MerkleBuilder.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";
import {Reverter} from "./utils/Actors.sol";

/// @dev Burns every unit of gas it is given once armed, so it behaves while a client simulates and not on-chain.
contract Burner {
    bool public armed;

    function arm() external {
        armed = true;
    }

    function poke() external view {
        if (armed) while (true) {}
    }
}

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

    /// @dev Before the first fix this batch was accepted: the inner `checkAfterExecution` reset the state, the inner
    ///      `checkTransaction` with escape-shaped arguments set TX_ESCAPE, and the Safe's real after-hook returned
    ///      without checking anything. The attacker ended up as sole owner with threshold 1 and no guard. Now the
    ///      replayed `checkTransaction` sees the nonce the genuine call already used and reverts, so the batch fails as
    ///      a whole and the real after-hook rotates the signers and checks everything.
    function test_finding1_reArmToEscapeIsRejected() public {
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(guard), 0, _fakeCheckTransaction()),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1))),
            packCall(address(safe), 0, abi.encodeCall(safe.setGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.disableModule, (SENTINEL, address(guard))))
        );
        _assertReArmFails(batch);
    }

    /// @dev The same re-arm that only adds an owner (keeps the hooks) fails the same way.
    function test_finding1_reArmWithoutRemovingGuardIsRejected() public {
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(guard), 0, _fakeCheckTransaction()),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1)))
        );
        _assertReArmFails(batch);
    }

    /// @dev Found by the second review (2026-10-09): changing the owners before the replayed escape `checkTransaction`
    ///      got past the owner-set snapshot the first fix took there. The nonce lock rejects the replay itself.
    function test_finding1_ownersChangedBeforeReplayAreRejected() public {
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.checkAfterExecution, (bytes32(0), true))),
            packCall(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (attacker, 1))),
            packCall(address(guard), 0, _fakeCheckTransaction()),
            packCall(address(safe), 0, abi.encodeCall(safe.setGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(0)))),
            packCall(address(safe), 0, abi.encodeCall(safe.disableModule, (SENTINEL, address(guard))))
        );
        _assertReArmFails(batch);
    }

    /// @dev The replayed hook reverts with NestedExecution, so the whole batch fails; the signers still rotate.
    function _assertReArmFails(bytes memory batch) internal {
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        assertFalse(exec(multiSendTx(batch), signer, executor), "the batch fails");
        assertFalse(safe.isOwner(attacker));
        assertEq(safe.getThreshold(), THRESHOLD);
        assertEq(_readAddress(GUARD_STORAGE_SLOT), address(guard));
        assertFalse(safe.isOwner(signer), "signers still rotate");
        assertFalse(safe.isOwner(executor));
    }

    /// @dev Re-arming to a non-escape state with signatures copied from elsewhere fails like any replay: the second
    ///      `checkTransaction` for the same Safe nonce reverts. The inner batch reverts, which also rolls back the inner
    ///      after-hook's state reset, so the Safe's real after-hook runs with the original signers and every check.
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

    /// @dev A non-zero gasPrice alone is not enough since the second review: Safe would hand the inner call
    ///      `safeTxGas` = 0 gas, so both must be set.
    function test_finding2_zeroSafeTxGasWithGasPriceIsRejected() public {
        Params memory p = Params(recipient, "", 0, 1, address(0), address(0));
        (bool ok, bytes memory ret) = _send(p, currentOwner(0), currentOwner(1), 2_000_000);
        assertFalse(ok);
        assertEq(bytes4(ret), IRotationGuard.SafeTxGasRequired.selector);
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
        Second review (2026-10-09), finding 1: with gasPrice zero Safe
        hands the inner call 63/64 of the gas, so a gas-burning callee
        starves the rotation and the whole transaction reverts
    //////////////////////////////////////////////////////////////*/

    /// @dev Before the fix (gasPrice 0 accepted): a callee that behaved while simulated and burned all gas on-chain made
    ///      a transaction sent with 1.5x the simulated gas revert as a whole, leaving both signers as owners with
    ///      their signatures public. Now gasPrice 0 is rejected before anything runs.
    function test_review1_zeroGasPriceIsRejected() public {
        Params memory p = Params(recipient, "", 1_000_000, 0, address(0), address(0));
        (bool ok, bytes memory ret) = _send(p, currentOwner(0), currentOwner(1), 2_000_000);
        assertFalse(ok);
        assertEq(bytes4(ret), IRotationGuard.SafeTxGasRequired.selector);
    }

    /// @dev With gasPrice set, Safe caps the inner call at safeTxGas: a gas limit covering the simulated cost plus the
    ///      whole safeTxGas (what the app sends) leaves the rotation its gas even when the callee burns everything.
    function test_review1_gasBurnerCannotStarveTheRotation() public {
        Burner burner = new Burner();
        address signer = currentOwner(0);
        address executor = currentOwner(1);
        Params memory p = Params(address(burner), abi.encodeCall(Burner.poke, ()), 200_000, 1, address(0), address(0));

        uint256 snapshot = vm.snapshotState();
        uint256 before = gasleft();
        (bool ok, ) = _send(p, signer, executor, 5_000_000);
        uint256 simulated = before - gasleft();
        assertTrue(ok);
        vm.revertToState(snapshot);

        burner.arm();
        bool success;
        (ok, success) = _sendDecoded(p, signer, executor, simulated + p.safeTxGas);
        assertTrue(ok, "the transaction lands");
        assertFalse(success, "only the inner call fails");
        assertFalse(safe.isOwner(signer), "signers rotate");
        assertFalse(safe.isOwner(executor));
    }

    /*//////////////////////////////////////////////////////////////
        Second review, finding 3: a refund that can fail reverts the
        whole transaction and skips the rotation
    //////////////////////////////////////////////////////////////*/

    /// @dev Before the fix: a refund receiver without `receive` made Safe revert with GS011 after the signatures were
    ///      public, and nobody rotated. Refunds now go only in ETH to the executor.
    function test_review3_refundReceiverIsRejected() public {
        Params memory p = Params(recipient, "", 100_000, 1, address(0), address(new Reverter()));
        (bool ok, bytes memory ret) = _send(p, currentOwner(0), currentOwner(1), 2_000_000);
        assertFalse(ok);
        assertEq(bytes4(ret), IRotationGuard.RefundNotAllowed.selector);
    }

    function test_review3_gasTokenIsRejected() public {
        Params memory p = Params(recipient, "", 100_000, 1, makeAddr("token"), address(0));
        (bool ok, bytes memory ret) = _send(p, currentOwner(0), currentOwner(1), 2_000_000);
        assertFalse(ok);
        assertEq(bytes4(ret), IRotationGuard.RefundNotAllowed.selector);
    }

    /// @dev The executor is refunded in ETH, at most the signed gasPrice per gas unit.
    function test_review3_executorIsRefunded() public {
        address executor = currentOwner(1);
        uint256 balanceBefore = executor.balance;
        vm.txGasPrice(1);
        (bool ok, bool success) = _sendDecoded(Params(recipient, "", 100_000, 1, address(0), address(0)), currentOwner(0), executor, 2_000_000);
        assertTrue(ok && success);
        assertGt(executor.balance, balanceBefore);
    }

    /*//////////////////////////////////////////////////////////////
        Second review, finding 4: another slot rotates into an address
        a slot has already staged, blocking that slot's rotation
    //////////////////////////////////////////////////////////////*/

    /// @dev Before the fix: slot 2 got a key list (approved by slots 1 and 2) whose first key was slot 0's next staged
    ///      address and rotated into it; slot 0's next rotation then tried to add an existing owner and every
    ///      transaction slot 0 signed reverted. Now the rotation skips the taken entry.
    function test_review4_stolenStagedAddressIsSkipped() public {
        address victimNext = treeAddress(0, 1);
        assertEq(guard.getSlot(address(safe), 0).staged[0], victimNext);

        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = guard.leaf(address(safe), 2, 0, victimNext);
        leaves[1] = guard.leaf(address(safe), 2, 1, makeAddr("filler"));
        IRotationGuard.StageEntry[] memory stolen = new IRotationGuard.StageEntry[](1);
        stolen[0] = IRotationGuard.StageEntry(0, victimNext, MerkleBuilder.proof(leaves, 0));
        bytes memory batch = bytes.concat(
            packCall(address(guard), 0, abi.encodeCall(guard.setRoot, (2, MerkleBuilder.root(leaves), 2, 0, "cid"))),
            packCall(address(guard), 0, abi.encodeCall(guard.stage, (address(safe), 2, stolen)))
        );
        assertTrue(execBySlots(multiSendTx(batch), 2, 1));
        assertEq(currentOwner(2), victimNext, "slot 2 rotated into slot 0's next address");

        address victim = currentOwner(0);
        assertTrue(execBySlots(call(recipient, 1, ""), 0, 1));
        assertFalse(safe.isOwner(victim), "slot 0 still rotates");
        assertEq(currentOwner(0), treeAddress(0, 2), "past the taken address");
        assertEq(guard.getSlot(address(safe), 0).nextIndex, 3);
        assertEq(currentOwner(2), victimNext, "slot 2 keeps it");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A transaction with explicit gas and refund parameters.
    struct Params {
        address to;
        bytes data;
        uint256 safeTxGas;
        uint256 gasPrice;
        address gasToken;
        address refundReceiver;
    }

    /// @dev Calls execTransaction as `executor` with a gas limit; `ok` is false when the whole transaction reverted.
    function _send(Params memory p, address signer, address executor, uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        bytes32 hash = safe.getTransactionHash(p.to, 0, p.data, Enum.Operation.Call, p.safeTxGas, 0, p.gasPrice, p.gasToken, payable(p.refundReceiver), safe.nonce());
        address[] memory signers = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        signers[0] = signer;
        signers[1] = executor;
        sigs[0] = ecdsaSignature(signer, hash, false);
        sigs[1] = preValidatedSignature(executor);
        bytes memory payload = abi.encodeCall(
            Safe.execTransaction,
            (p.to, 0, p.data, Enum.Operation.Call, p.safeTxGas, 0, p.gasPrice, p.gasToken, payable(p.refundReceiver), packSignatures(signers, sigs))
        );
        vm.prank(executor, executor);
        (ok, ret) = address(safe).call{gas: gasLimit}(payload);
    }

    function _sendDecoded(Params memory p, address signer, address executor, uint256 gasLimit) internal returns (bool ok, bool success) {
        bytes memory ret;
        (ok, ret) = _send(p, signer, executor, gasLimit);
        if (ok) success = abi.decode(ret, (bool));
    }

    function _one(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _readAddress(bytes32 slot) internal view returns (address) {
        return address(uint160(uint256(bytes32(safe.getStorageAt(uint256(slot), 1)))));
    }
}
