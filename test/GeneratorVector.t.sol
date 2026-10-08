// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Safe} from "@safe/Safe.sol";
import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {RotationGuard} from "../src/RotationGuard.sol";
import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";

/**
 * @notice Cross-checks the TypeScript generator against the contract using `test/vectors/tree-vector.json`
 *         (regenerate with `npm run vectors` in `generator/`). Leaves, proofs and key derivation are each checked
 *         independently, then the generated tree is used end to end to rotate a real Safe.
 */
contract GeneratorVectorTest is Test {
    string internal json;
    RotationGuard internal guard;
    Safe internal safe;
    string internal mnemonic;
    uint256 internal base;
    uint256 internal slotId;
    bytes32 internal root;

    function setUp() public {
        json = vm.readFile("test/vectors/tree-vector.json");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        mnemonic = vm.parseJsonString(json, ".mnemonic");
        base = vm.parseJsonUint(json, ".base");
        slotId = vm.parseJsonUint(json, ".slotId");
        root = vm.parseJsonBytes32(json, ".root");

        Safe singleton = new Safe();
        guard = new RotationGuard(address(new MultiSendCallOnly()));
        safe = _safeAt(vm.parseJsonAddress(json, ".safe"), singleton);
    }

    function test_samplesMatchContractLeafAndProof() public view {
        for (uint256 i = 0; i < 3; ++i) {
            string memory key = string.concat(".samples[", vm.toString(i), "]");
            uint256 index = vm.parseJsonUint(json, string.concat(key, ".index"));
            address owner = vm.parseJsonAddress(json, string.concat(key, ".owner"));
            bytes32 leaf = vm.parseJsonBytes32(json, string.concat(key, ".leaf"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(key, ".proof"));

            assertEq(guard.leaf(address(safe), slotId, index, owner), leaf, "leaf encoding differs");
            assertTrue(MerkleProof.verify(proof, root, leaf), "proof does not verify");
        }
    }

    function test_addressesMatchFoundryDerivation() public view {
        for (uint256 i = 0; i < 3; ++i) {
            string memory key = string.concat(".samples[", vm.toString(i), "]");
            uint256 index = vm.parseJsonUint(json, string.concat(key, ".index"));
            assertEq(vm.parseJsonAddress(json, string.concat(key, ".owner")), _derive(index), "derivation differs");
        }
        for (uint256 i = 0; i < 5; ++i) {
            IRotationGuard.StageEntry memory entry = _stageEntry(i);
            assertEq(entry.owner, _derive(entry.index), "derivation differs");
        }
    }

    function test_generatedTreeRotatesSafe() public {
        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](1);
        configs[0] = IRotationGuard.SlotConfig(
            vm.parseJsonBytes32(json, ".config.root"),
            uint32(vm.parseJsonUint(json, ".config.size")),
            uint32(vm.parseJsonUint(json, ".config.startIndex")),
            vm.parseJsonAddress(json, ".config.owner"),
            vm.parseJsonBytes32Array(json, ".config.proof"),
            vm.parseJsonString(json, ".config.cid")
        );
        address[] memory oldOwners = safe.getOwners();

        // Setup runs unguarded; stand in for the Safe rather than signing it.
        vm.startPrank(address(safe));
        safe.enableModule(address(guard));
        safe.setGuard(address(guard));
        safe.setModuleGuard(address(guard));
        guard.initialize(oldOwners, configs);
        vm.stopPrank();

        IRotationGuard.StageEntry[] memory entries = new IRotationGuard.StageEntry[](5);
        for (uint256 i = 0; i < 5; ++i) entries[i] = _stageEntry(i);
        guard.stage(address(safe), slotId, entries);

        for (uint256 i = 0; i < 5; ++i) {
            address executor = safe.getOwners()[0];
            assertEq(executor, i == 0 ? configs[0].owner : entries[i - 1].owner);
            vm.prank(executor);
            safe.execTransaction(
                makeAddr("recipient"), 1, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)),
                abi.encodePacked(bytes32(uint256(uint160(executor))), bytes32(0), uint8(1))
            );
            assertFalse(safe.isOwner(executor));
            assertEq(safe.getOwners()[0], entries[i].owner);
        }
    }

    function _stageEntry(uint256 i) internal view returns (IRotationGuard.StageEntry memory) {
        string memory key = string.concat(".stage[", vm.toString(i), "]");
        return IRotationGuard.StageEntry(
            uint32(vm.parseJsonUint(json, string.concat(key, ".index"))),
            vm.parseJsonAddress(json, string.concat(key, ".owner")),
            vm.parseJsonBytes32Array(json, string.concat(key, ".proof"))
        );
    }

    function _derive(uint256 index) internal view returns (address) {
        string memory path = string.concat("m/44'/60'/", vm.toString(base + index), "'/0/");
        return vm.addr(vm.deriveKey(mnemonic, path, 0));
    }

    /// @dev Places a 1-of-1 Safe proxy at `target`, the address the vector's leaves are bound to.
    function _safeAt(address target, Safe singleton) internal returns (Safe placed) {
        SafeProxyFactory factory = new SafeProxyFactory();
        address template = address(factory.createProxyWithNonce(address(singleton), "", 0));
        vm.etch(target, template.code);
        vm.store(target, bytes32(0), bytes32(uint256(uint160(address(singleton)))));
        placed = Safe(payable(target));
        address[] memory owners = new address[](1);
        owners[0] = makeAddr("legacy");
        placed.setup(owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
        vm.deal(target, 1 ether);
    }
}
