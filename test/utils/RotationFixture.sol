// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Safe} from "@safe/Safe.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {Enum} from "@safe/libraries/Enum.sol";

import {RotationGuard} from "../../src/RotationGuard.sol";
import {IRotationGuard} from "../../src/interfaces/IRotationGuard.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";

/// @notice Deploys a 2-of-3 Safe 1.5.0 with RotationGuard installed and three signer trees staged.
abstract contract RotationFixture is Test {
    uint256 internal constant SLOTS = 3;
    uint256 internal constant THRESHOLD = 2;
    uint32 internal constant TREE_SIZE = 16;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev The guard rejects `safeTxGas == 0 && gasPrice == 0`; Safe passes exactly this much gas to the inner call.
    uint256 internal constant SAFE_TX_GAS = 5_000_000;

    Safe internal singleton;
    SafeProxyFactory internal factory;
    MultiSendCallOnly internal multiSend;
    RotationGuard internal guard;
    Safe internal safe;

    address[] internal legacyOwners;
    mapping(uint256 slot => bytes32[]) internal leavesOf;
    mapping(uint256 slot => bytes32) internal rootOf;
    mapping(address account => uint256) internal keyOf;

    address internal recipient = makeAddr("recipient");

    function setUp() public virtual {
        _deployInfrastructure();
        guard = new RotationGuard(address(multiSend));

        for (uint256 i = 0; i < SLOTS; ++i) {
            legacyOwners.push(_register(uint256(keccak256(abi.encode("legacy", i)))));
        }
        bytes memory initializer = abi.encodeCall(
            Safe.setup, (legacyOwners, THRESHOLD, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = Safe(payable(address(factory.createProxyWithNonce(address(singleton), initializer, 0))));
        vm.deal(address(safe), 100 ether);

        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            for (uint256 index = 0; index < TREE_SIZE; ++index) {
                leavesOf[slot].push(guard.leaf(address(safe), slot, index, treeAddress(slot, index)));
            }
            rootOf[slot] = MerkleBuilder.root(leavesOf[slot]);
        }

        _installGuard();
    }

    /// @dev Deploys local Safe contracts. Fork tests override this to use the canonical mainnet deployments.
    function _deployInfrastructure() internal virtual {
        singleton = new Safe();
        factory = new SafeProxyFactory();
        multiSend = new MultiSendCallOnly();
    }

    /*//////////////////////////////////////////////////////////////
                               KEYS
    //////////////////////////////////////////////////////////////*/

    function treeKey(uint256 slot, uint256 index) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encode("tree", slot, index))) % (SECP256K1_N - 1)) + 1;
    }

    function treeAddress(uint256 slot, uint256 index) internal pure returns (address) {
        return vm.addr(treeKey(slot, index));
    }

    function _register(uint256 seed) internal returns (address account) {
        uint256 key = (seed % (SECP256K1_N - 1)) + 1;
        account = vm.addr(key);
        keyOf[account] = key;
    }

    function currentOwner(uint256 slot) internal view returns (address) {
        return guard.getSlot(address(safe), slot).owner;
    }

    /*//////////////////////////////////////////////////////////////
                              STAGING
    //////////////////////////////////////////////////////////////*/

    function proofOf(uint256 slot, uint256 index) internal view returns (bytes32[] memory) {
        return MerkleBuilder.proof(leavesOf[slot], index);
    }

    function entries(uint256 slot, uint32 fromIndex, uint256 count) internal view returns (IRotationGuard.StageEntry[] memory list) {
        list = new IRotationGuard.StageEntry[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint32 index = fromIndex + uint32(i);
            list[i] = IRotationGuard.StageEntry(index, treeAddress(slot, index), proofOf(slot, index));
        }
    }

    function refill(uint256 slot) internal {
        IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slot);
        uint256 missing = guard.BUFFER_SIZE() - view_.staged.length;
        if (view_.nextStageIndex + missing > TREE_SIZE) missing = TREE_SIZE - view_.nextStageIndex;
        if (missing == 0) return;
        guard.stage(address(safe), slot, entries(slot, view_.nextStageIndex, missing));
    }

    function refillAll() internal {
        for (uint256 slot = 0; slot < SLOTS; ++slot) refill(slot);
    }

    /*//////////////////////////////////////////////////////////////
                             EXECUTION
    //////////////////////////////////////////////////////////////*/

    struct SafeTx {
        address to;
        uint256 value;
        bytes data;
        Enum.Operation operation;
        uint256 safeTxGas;
    }

    function call(address to, uint256 value, bytes memory data) internal pure returns (SafeTx memory) {
        return SafeTx(to, value, data, Enum.Operation.Call, SAFE_TX_GAS);
    }

    function txHash(SafeTx memory t) internal view returns (bytes32) {
        return safe.getTransactionHash(t.to, t.value, t.data, t.operation, t.safeTxGas, 0, 0, address(0), payable(address(0)), safe.nonce());
    }

    function ecdsaSignature(address signer, bytes32 hash, bool ethSign) internal view returns (bytes memory) {
        bytes32 digest = ethSign ? keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)) : hash;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[signer], digest);
        return abi.encodePacked(r, s, ethSign ? v + 4 : v);
    }

    function preValidatedSignature(address signer) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(signer))), bytes32(0), uint8(1));
    }

    /// @dev Concatenates signatures sorted by signer address, as Safe requires.
    function packSignatures(address[] memory signers, bytes[] memory sigs) internal pure returns (bytes memory packed) {
        for (uint256 i = 1; i < signers.length; ++i) {
            for (uint256 j = i; j > 0 && signers[j - 1] > signers[j]; --j) {
                (signers[j - 1], signers[j]) = (signers[j], signers[j - 1]);
                (sigs[j - 1], sigs[j]) = (sigs[j], sigs[j - 1]);
            }
        }
        for (uint256 i = 0; i < sigs.length; ++i) packed = bytes.concat(packed, sigs[i]);
    }

    /// @dev Signs with `ecdsaSigners` and executes as `executor` through a pre-validated signature.
    function signatures(SafeTx memory t, address[] memory ecdsaSigners, address executor, bool ethSign)
        internal
        view
        returns (bytes memory)
    {
        bytes32 hash = txHash(t);
        address[] memory signers = new address[](ecdsaSigners.length + 1);
        bytes[] memory sigs = new bytes[](ecdsaSigners.length + 1);
        for (uint256 i = 0; i < ecdsaSigners.length; ++i) {
            signers[i] = ecdsaSigners[i];
            sigs[i] = ecdsaSignature(ecdsaSigners[i], hash, ethSign);
        }
        signers[ecdsaSigners.length] = executor;
        sigs[ecdsaSigners.length] = preValidatedSignature(executor);
        return packSignatures(signers, sigs);
    }

    function execRaw(SafeTx memory t, bytes memory sigs, address executor) internal returns (bool) {
        vm.prank(executor);
        return safe.execTransaction(t.to, t.value, t.data, t.operation, t.safeTxGas, 0, 0, address(0), payable(address(0)), sigs);
    }

    function exec(SafeTx memory t, address signer, address executor) internal returns (bool) {
        address[] memory ecdsaSigners = new address[](1);
        ecdsaSigners[0] = signer;
        return execRaw(t, signatures(t, ecdsaSigners, executor, false), executor);
    }

    /// @dev Prepares signatures for slot owners: `signerSlot` signs off-chain, `executorSlot` executes.
    function prepareBySlots(SafeTx memory t, uint256 signerSlot, uint256 executorSlot)
        internal
        view
        returns (bytes memory sigs, address executor)
    {
        executor = currentOwner(executorSlot);
        address[] memory ecdsaSigners = new address[](1);
        ecdsaSigners[0] = currentOwner(signerSlot);
        sigs = signatures(t, ecdsaSigners, executor, false);
    }

    /// @dev Executes as slot owners: `signerSlot` signs off-chain, `executorSlot` executes.
    function execBySlots(SafeTx memory t, uint256 signerSlot, uint256 executorSlot) internal returns (bool) {
        return exec(t, currentOwner(signerSlot), currentOwner(executorSlot));
    }

    /// @dev Asserts a guarded transaction's inner call reverts with `reason`. Safe does not surface inner reverts once
    ///      `safeTxGas` is set (the transaction succeeds with `success == false` and rotates), so the reason is checked
    ///      by replaying the call as the Safe, and the guarded run is checked to report failure and still rotate.
    function execExpectInnerRevert(SafeTx memory t, bytes memory reason, uint256 signerSlot, uint256 executorSlot) internal {
        require(t.operation == Enum.Operation.Call, "replay supports plain calls only");
        vm.prank(address(safe));
        vm.expectRevert(reason);
        (bool ok, ) = t.to.call{value: t.value}(t.data);
        ok;
        address signer = currentOwner(signerSlot);
        address executor = currentOwner(executorSlot);
        assertFalse(execBySlots(t, signerSlot, executorSlot), "inner call should fail");
        assertFalse(safe.isOwner(signer), "signer rotates despite the failure");
        assertFalse(safe.isOwner(executor), "executor rotates despite the failure");
    }

    function multiSendTx(bytes memory packedCalls) internal view returns (SafeTx memory) {
        return SafeTx(address(multiSend), 0, abi.encodeCall(MultiSendCallOnly.multiSend, (packedCalls)), Enum.Operation.DelegateCall, SAFE_TX_GAS);
    }

    function packCall(address to, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, value, data.length, data);
    }

    /*//////////////////////////////////////////////////////////////
                               SETUP
    //////////////////////////////////////////////////////////////*/

    function slotConfig(uint256 slot, uint32 index) internal view returns (IRotationGuard.SlotConfig memory) {
        return IRotationGuard.SlotConfig(rootOf[slot], TREE_SIZE, index, treeAddress(slot, index), proofOf(slot, index), "cid");
    }

    function _installGuard() internal {
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) configs[slot] = slotConfig(slot, 0);

        bytes memory batch = bytes.concat(
            packCall(address(safe), 0, abi.encodeCall(safe.enableModule, (address(guard)))),
            packCall(address(safe), 0, abi.encodeCall(safe.setGuard, (address(guard)))),
            packCall(address(safe), 0, abi.encodeCall(safe.setModuleGuard, (address(guard)))),
            packCall(address(guard), 0, abi.encodeCall(guard.initialize, (legacyOwners, configs)))
        );
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            batch = bytes.concat(batch, packCall(address(guard), 0, abi.encodeCall(guard.stage, (address(safe), slot, entries(slot, 1, 5)))));
        }

        assertTrue(exec(multiSendTx(batch), legacyOwners[0], legacyOwners[1]));

        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            for (uint256 index = 0; index < TREE_SIZE; ++index) {
                keyOf[treeAddress(slot, index)] = treeKey(slot, index);
            }
        }
    }
}
