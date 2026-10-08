// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {Safe} from "@safe/Safe.sol";
import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {RotationGuard} from "../src/RotationGuard.sol";
import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";
import {MerkleBuilder} from "./utils/MerkleBuilder.sol";

/// @notice Measures the guard's per-transaction overhead against an unguarded Safe across owner set sizes.
contract RotationGuardGasTest is Test {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant TREE_SIZE = 4;
    uint256 internal constant MAX_TOTAL_GAS = 3_000_000;

    Safe internal singleton;
    SafeProxyFactory internal factory;
    MultiSendCallOnly internal multiSend;
    RotationGuard internal guard;
    address internal recipient = makeAddr("recipient");
    uint256 internal saltNonce;
    mapping(address safe => uint256) internal idOf;

    function setUp() public {
        singleton = new Safe();
        factory = new SafeProxyFactory();
        multiSend = new MultiSendCallOnly();
        guard = new RotationGuard(address(multiSend));
    }

    function test_gas_2of3() public {
        _measure(3, 2, 50_000);
    }

    function test_gas_3of5() public {
        _measure(5, 3, 55_000);
    }

    function test_gas_7of10() public {
        _measure(10, 7, 62_000);
    }

    function test_gas_20of20() public {
        _measure(20, 20, 75_000);
    }

    /// @dev `maxOverheadPerSigner` is a regression budget a little above the measured cost for each size.
    function _measure(uint256 owners, uint256 threshold, uint256 maxOverheadPerSigner) internal {
        Safe plain = _deploySafe(owners, threshold, false);
        Safe guarded = _deploySafe(owners, threshold, true);

        uint256 plainGas = _transfer(plain, threshold);
        uint256 guardedGas = _transfer(guarded, threshold);
        uint256 overhead = guardedGas - plainGas;

        console2.log("owners / threshold", owners, threshold);
        console2.log("  unguarded gas", plainGas);
        console2.log("  guarded gas  ", guardedGas);
        console2.log("  overhead per signer", overhead / threshold);

        assertLt(guardedGas, MAX_TOTAL_GAS);
        assertLt(overhead / threshold, maxOverheadPerSigner);
        for (uint256 i = 0; i < threshold; ++i) assertFalse(guarded.isOwner(_addr(idOf[address(guarded)], i, 0)));
    }

    function _transfer(Safe safe, uint256 threshold) internal returns (uint256 gasUsed) {
        address[] memory owners = safe.getOwners();
        address[] memory signers = new address[](threshold);
        for (uint256 i = 0; i < threshold; ++i) signers[i] = owners[i];
        bytes32 hash = safe.getTransactionHash(recipient, 1, "", Enum.Operation.Call, 0, 0, 0, address(0), address(0), safe.nonce());

        bytes[] memory sigs = new bytes[](threshold);
        sigs[0] = abi.encodePacked(bytes32(uint256(uint160(signers[0]))), bytes32(0), uint8(1));
        for (uint256 i = 1; i < threshold; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyOf(safe, signers[i]), hash);
            sigs[i] = abi.encodePacked(r, s, v);
        }
        address executor = signers[0];
        bytes memory packed = _pack(signers, sigs);

        vm.prank(executor);
        uint256 before = gasleft();
        safe.execTransaction(recipient, 1, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), packed);
        gasUsed = before - gasleft();
    }

    /// @dev Owners are each slot's index-0 address; a guarded Safe also stages index 1 for every slot.
    function _deploySafe(uint256 owners, uint256 threshold, bool guarded) internal returns (Safe safe) {
        uint256 id = ++saltNonce;
        address[] memory initial = new address[](owners);
        for (uint256 i = 0; i < owners; ++i) initial[i] = _addr(id, i, 0);
        bytes memory initializer =
            abi.encodeCall(Safe.setup, (initial, threshold, address(0), "", address(0), address(0), 0, payable(address(0))));
        safe = Safe(payable(address(factory.createProxyWithNonce(address(singleton), initializer, id))));
        idOf[address(safe)] = id;
        vm.deal(address(safe), 1 ether);
        if (!guarded) return safe;

        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](owners);
        address[] memory oldOwners = new address[](owners);
        for (uint256 i = 0; i < owners; ++i) {
            bytes32[] memory leaves = _leaves(safe, i);
            oldOwners[i] = initial[i];
            configs[i] = IRotationGuard.SlotConfig(MerkleBuilder.root(leaves), uint32(TREE_SIZE), 0, initial[i], MerkleBuilder.proof(leaves, 0), "");
        }

        // Setup is a single unguarded transaction; stand in for the Safe directly rather than signing it.
        vm.startPrank(address(safe));
        safe.enableModule(address(guard));
        safe.setGuard(address(guard));
        safe.setModuleGuard(address(guard));
        _swapToFresh(safe, oldOwners, configs);
        vm.stopPrank();

        for (uint256 i = 0; i < owners; ++i) {
            bytes32[] memory leaves = _leaves(safe, i);
            IRotationGuard.StageEntry[] memory list = new IRotationGuard.StageEntry[](1);
            list[0] = IRotationGuard.StageEntry(1, _addr(id, i, 1), MerkleBuilder.proof(leaves, 1));
            guard.stage(address(safe), i, list);
        }
    }

    /// @dev initialize() swaps each old owner for the config owner; here they are identical, so swap via a temp first.
    function _swapToFresh(Safe safe, address[] memory oldOwners, IRotationGuard.SlotConfig[] memory configs) internal {
        address[] memory temps = new address[](oldOwners.length);
        for (uint256 i = 0; i < oldOwners.length; ++i) {
            temps[i] = address(uint160(0x1000 + i));
            safe.swapOwner(_prev(safe, oldOwners[i]), oldOwners[i], temps[i]);
        }
        guard.initialize(temps, configs);
    }

    function _prev(Safe safe, address owner) internal view returns (address) {
        address[] memory owners = safe.getOwners();
        for (uint256 i = 1; i < owners.length; ++i) if (owners[i] == owner) return owners[i - 1];
        return address(0x1);
    }

    function _leaves(Safe safe, uint256 slot) internal view returns (bytes32[] memory leaves) {
        uint256 id = idOf[address(safe)];
        leaves = new bytes32[](TREE_SIZE);
        for (uint256 index = 0; index < TREE_SIZE; ++index) {
            leaves[index] = guard.leaf(address(safe), slot, index, _addr(id, slot, index));
        }
    }

    function _key(uint256 id, uint256 slot, uint256 index) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encode("gas", id, slot, index))) % (SECP256K1_N - 1)) + 1;
    }

    function _addr(uint256 id, uint256 slot, uint256 index) internal pure returns (address) {
        return vm.addr(_key(id, slot, index));
    }

    function _keyOf(Safe safe, address owner) internal view returns (uint256) {
        uint256 id = idOf[address(safe)];
        uint256 slots = safe.getOwners().length;
        for (uint256 slot = 0; slot < slots; ++slot) {
            for (uint256 index = 0; index < TREE_SIZE; ++index) {
                if (_addr(id, slot, index) == owner) return _key(id, slot, index);
            }
        }
        revert("unknown owner");
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
}
