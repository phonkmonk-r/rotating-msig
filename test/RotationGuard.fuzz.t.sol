// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";

contract RotationGuardFuzzTest is RotationFixture {
    /// @dev For any threshold, executor and signer subset, exactly the signers are rotated, using either signature type.
    function testFuzz_rotatesExactlyTheSigners(uint8 thresholdSeed, uint8 executorSeed, uint8 subsetSeed, uint8 ethSignMask)
        public
    {
        uint256 threshold = bound(thresholdSeed, 1, SLOTS);
        if (threshold != THRESHOLD) {
            assertTrue(execBySlots(call(address(safe), 0, abi.encodeCall(safe.changeThreshold, (threshold))), 0, 1));
            refillAll();
        }

        uint256 executorSlot = bound(executorSeed, 0, SLOTS - 1);
        bool[] memory signs = new bool[](SLOTS);
        signs[executorSlot] = true;
        uint256 chosen = 1;
        for (uint256 i = 0; chosen < threshold; ++i) {
            uint256 slot = (uint256(subsetSeed) + i) % SLOTS;
            if (!signs[slot]) {
                signs[slot] = true;
                ++chosen;
            }
        }

        address[] memory before = new address[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) before[slot] = currentOwner(slot);

        SafeTx memory t = call(recipient, 1, "");
        bytes32 hash = txHash(t);
        address[] memory signers = new address[](threshold);
        bytes[] memory sigs = new bytes[](threshold);
        uint256 n;
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            if (!signs[slot]) continue;
            signers[n] = before[slot];
            sigs[n] = slot == executorSlot
                ? preValidatedSignature(before[slot])
                : ecdsaSignature(before[slot], hash, (ethSignMask >> slot) & 1 == 1);
            ++n;
        }
        assertTrue(execRaw(t, packSignatures(signers, sigs), before[executorSlot]));

        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            assertEq(safe.isOwner(before[slot]), !signs[slot]);
            assertEq(currentOwner(slot) != before[slot], signs[slot]);
        }
        assertEq(safe.getOwners().length, SLOTS);
    }

    /// @dev Random bytes in the signature slots never get past both Safe and the guard without rotating the signers.
    function testFuzz_garbageSignaturesNeverSkipRotation(bytes32 r, bytes32 s, uint8 v, uint8 executorSeed) public {
        address executor = currentOwner(bound(executorSeed, 0, SLOTS - 1));
        SafeTx memory t = call(recipient, 1, "");
        address[] memory signers = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        signers[0] = executor;
        sigs[0] = preValidatedSignature(executor);
        signers[1] = address(uint160(uint256(r)));
        sigs[1] = abi.encodePacked(r, s, v);
        bytes memory packed = packSignatures(signers, sigs);

        address[] memory before = safe.getOwners();
        vm.prank(executor);
        try safe.execTransaction(t.to, t.value, t.data, t.operation, SAFE_TX_GAS, 0, 1, address(0), payable(address(0)), packed) {
            assertFalse(safe.isOwner(executor));
            uint256 stillOwners;
            for (uint256 i = 0; i < before.length; ++i) if (safe.isOwner(before[i])) ++stillOwners;
            assertEq(stillOwners, SLOTS - 2);
        } catch {
            for (uint256 i = 0; i < before.length; ++i) assertTrue(safe.isOwner(before[i]));
        }
    }

    struct Case {
        uint256 threshold;
        bool relayerExecutes;
        bool appendExtra;
        address executor;
        address[] signers;
        bytes[] sigs;
        bool modelAccepts;
    }

    /**
     * @dev Differential test against a reference model of the executor rule. Each of the `threshold` signers uses
     *      ECDSA, eth_sign or a pre-validated signature (backed by `approveHash` when not the executor); the executor
     *      may be a non-owner relayer; an extra valid signature may be appended. Safe accepts every case; the guard
     *      must accept exactly when the model does, and then rotate exactly the signers.
     */
    function testFuzz_signatureEncodingsMatchModel(
        uint8 thresholdSeed,
        uint256 orderSeed,
        uint8 encodingSeed,
        bool relayerExecutes,
        bool appendExtra
    ) public {
        Case memory c;
        c.threshold = bound(thresholdSeed, 1, SLOTS);
        if (c.threshold != THRESHOLD) {
            assertTrue(execBySlots(call(address(safe), 0, abi.encodeCall(safe.changeThreshold, (c.threshold))), 0, 1));
            refillAll();
        }
        c.relayerExecutes = relayerExecutes;
        c.appendExtra = appendExtra && c.threshold < SLOTS;

        address[] memory owners = safe.getOwners();
        uint256 count = c.threshold + (c.appendExtra ? 1 : 0);
        c.signers = new address[](count);
        c.sigs = new bytes[](count);
        for (uint256 i = 0; i < count; ++i) c.signers[i] = owners[(orderSeed % SLOTS + i) % SLOTS];
        c.executor = relayerExecutes ? makeAddr("relayer") : c.signers[0];

        SafeTx memory t = call(recipient, 1, "");
        bytes32 hash = txHash(t);
        bool executorPreValidated;
        bool foreignPreValidated;
        for (uint256 i = 0; i < count; ++i) {
            uint256 encoding = (uint256(encodingSeed) >> (2 * i)) % 3;
            if (i == 0 && !relayerExecutes) encoding = 2;
            if (encoding == 2) {
                if (c.signers[i] == c.executor) {
                    executorPreValidated = true;
                } else {
                    vm.prank(c.signers[i]);
                    safe.approveHash(hash);
                    if (i < c.threshold) foreignPreValidated = true;
                }
                c.sigs[i] = preValidatedSignature(c.signers[i]);
            } else {
                c.sigs[i] = ecdsaSignature(c.signers[i], hash, encoding == 1);
            }
        }
        c.modelAccepts = !c.appendExtra && !foreignPreValidated && executorPreValidated;

        address[] memory before = new address[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) before[slot] = currentOwner(slot);
        address[] memory signed = new address[](c.threshold);
        for (uint256 i = 0; i < c.threshold; ++i) signed[i] = c.signers[i];

        bytes memory packed = _packFirst(c.signers, c.sigs, c.threshold);
        vm.prank(c.executor);
        try safe.execTransaction(t.to, t.value, t.data, t.operation, SAFE_TX_GAS, 0, 1, address(0), payable(address(0)), packed) {
            assertTrue(c.modelAccepts, "guard accepted a case the model rejects");
            for (uint256 slot = 0; slot < SLOTS; ++slot) {
                bool didSign;
                for (uint256 i = 0; i < signed.length; ++i) if (signed[i] == before[slot]) didSign = true;
                assertEq(safe.isOwner(before[slot]), !didSign);
            }
        } catch {
            assertFalse(c.modelAccepts, "guard rejected a case the model accepts");
            for (uint256 slot = 0; slot < SLOTS; ++slot) assertTrue(safe.isOwner(before[slot]));
        }
    }

    /// @dev Sorts the first `threshold` signatures (Safe reads only those) and appends any extras after them.
    function _packFirst(address[] memory signers, bytes[] memory sigs, uint256 threshold) internal pure returns (bytes memory) {
        address[] memory headSigners = new address[](threshold);
        bytes[] memory headSigs = new bytes[](threshold);
        for (uint256 i = 0; i < threshold; ++i) {
            headSigners[i] = signers[i];
            headSigs[i] = sigs[i];
        }
        bytes memory packed = packSignatures(headSigners, headSigs);
        for (uint256 i = threshold; i < sigs.length; ++i) packed = bytes.concat(packed, sigs[i]);
        return packed;
    }

    /// @dev Proofs are bound to the chain: the correct next entry built for this chain fails on any other.
    function testFuzz_proofsBoundToChain(uint64 chainId) public {
        vm.assume(chainId != block.chainid && chainId != 0);
        execBySlots(call(recipient, 1, ""), 0, 1);
        IRotationGuard.StageEntry[] memory list = entries(0, 6, 1);
        vm.chainId(chainId);
        vm.expectRevert(IRotationGuard.InvalidProof.selector);
        guard.stage(address(safe), 0, list);
    }

    /// @dev Tampering with any proof element, the index or the address makes staging fail.
    function testFuzz_tamperedProofRejected(uint256 element, bytes32 replacement, uint32 indexDelta, address other) public {
        execBySlots(call(recipient, 1, ""), 0, 1);
        IRotationGuard.StageEntry[] memory list = entries(0, 6, 1);
        uint256 mode = element % 3;
        if (mode == 0) {
            uint256 at = (element >> 8) % list[0].proof.length;
            vm.assume(list[0].proof[at] != replacement);
            list[0].proof[at] = replacement;
        } else if (mode == 1) {
            vm.assume(indexDelta != 0);
            list[0].index += uint32(bound(indexDelta, 1, 9));
        } else {
            vm.assume(other != list[0].owner);
            list[0].owner = other;
        }
        vm.expectRevert();
        guard.stage(address(safe), 0, list);
    }

    /// @dev Leaves are bound to the Safe: the same signer tree yields different leaves under different Safes.
    function testFuzz_leavesBoundToSafe(address otherSafe, uint256 slotId, uint256 index, address owner) public view {
        vm.assume(otherSafe != address(safe));
        assertNotEq(guard.leaf(address(safe), slotId, index, owner), guard.leaf(otherSafe, slotId, index, owner));
    }
}
