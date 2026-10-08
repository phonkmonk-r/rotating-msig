// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

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
        try safe.execTransaction(t.to, t.value, t.data, t.operation, 0, 0, 0, address(0), payable(address(0)), packed) {
            assertFalse(safe.isOwner(executor));
            uint256 stillOwners;
            for (uint256 i = 0; i < before.length; ++i) if (safe.isOwner(before[i])) ++stillOwners;
            assertEq(stillOwners, SLOTS - 2);
        } catch {
            for (uint256 i = 0; i < before.length; ++i) assertTrue(safe.isOwner(before[i]));
        }
    }
}
