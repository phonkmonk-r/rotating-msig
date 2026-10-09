// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {Safe} from "@safe/Safe.sol";
import {Enum} from "@safe/libraries/Enum.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {RotationGuard} from "../src/RotationGuard.sol";
import {IRotationGuard} from "../src/interfaces/IRotationGuard.sol";

/**
 * @notice Local demo of RotationGuard on an Anvil fork of mainnet, driven by `demo/run.sh`. Uses the canonical Safe
 *         1.5.0 deployments and the public test mnemonic. Never point this at a real network.
 * @dev Entry points, run in order: `deploySafe()`, `install()`, `rotate(uint256)`, `status()`.
 */
contract Demo is Script {
    uint256 internal constant SAFE_TX_GAS = 2_000_000;
    address internal constant SAFE_SINGLETON = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address internal constant SAFE_PROXY_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant MULTI_SEND_CALL_ONLY = 0xA83c336B20401Af773B6219BA5027174338D1836;
    string internal constant TEST_MNEMONIC = "test test test test test test test test test test test junk";
    string internal constant OUT = "demo/out";
    uint256 internal constant SLOTS = 3;

    /// @notice Creates a 2-of-3 Safe owned by Anvil accounts 0-2 and deploys the guard.
    function deploySafe() external {
        address[] memory owners = new address[](SLOTS);
        for (uint256 i = 0; i < SLOTS; ++i) owners[i] = vm.addr(_anvilKey(i));
        bytes memory initializer =
            abi.encodeCall(Safe.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0))));

        vm.startBroadcast(_anvilKey(9));
        Safe safe = Safe(payable(address(SafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, initializer, block.timestamp))));
        RotationGuard guard = new RotationGuard(MULTI_SEND_CALL_ONLY);
        (bool funded, ) = address(safe).call{value: 10 ether}("");
        require(funded, "funding failed");
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "safe", address(safe));
        vm.writeJson(vm.serializeAddress(obj, "guard", address(guard)), string.concat(OUT, "/deployment.json"));

        console2.log("Safe 1.5.0 proxy ", address(safe));
        console2.log("RotationGuard    ", address(guard));
        _printOwners(safe, "Legacy owners (keys exposed by everyday use)");
    }

    /// @notice One 2-of-3 transaction from the legacy owners: enable module, set both guards, initialize, stage.
    function install() external {
        (Safe safe, RotationGuard guard) = _deployment();
        address[] memory oldOwners = safe.getOwners();

        IRotationGuard.SlotConfig[] memory configs = new IRotationGuard.SlotConfig[](SLOTS);
        for (uint256 slot = 0; slot < SLOTS; ++slot) configs[slot] = _config(slot);

        bytes memory batch = bytes.concat(
            _packCall(address(safe), abi.encodeCall(safe.enableModule, (address(guard)))),
            _packCall(address(safe), abi.encodeCall(safe.setGuard, (address(guard)))),
            _packCall(address(safe), abi.encodeCall(safe.setModuleGuard, (address(guard)))),
            _packCall(address(guard), abi.encodeCall(guard.initialize, (oldOwners, configs)))
        );
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            batch = bytes.concat(batch, _packCall(address(guard), abi.encodeCall(guard.stage, (address(safe), slot, _entries(slot, 1, 5)))));
        }

        uint256 executorKey = _keyOfOwner(oldOwners[0]);
        uint256 signerKey = _keyOfOwner(oldOwners[1]);
        _execute(safe, MULTI_SEND_CALL_ONLY, 0, abi.encodeCall(MultiSendCallOnly.multiSend, (batch)), Enum.Operation.DelegateCall, executorKey, signerKey);

        console2.log("Installed: legacy owners swapped for each slot's tree index 0, five addresses staged per slot.");
        _printOwners(safe, "Owners after setup");
    }

    /// @notice Runs `rounds` transfers, each signed by a different pair of owners, with the keeper refilling and funding.
    function rotate(uint256 rounds) external {
        (Safe safe, RotationGuard guard) = _deployment();
        address recipient = vm.addr(_anvilKey(7));

        for (uint256 round = 0; round < rounds; ++round) {
            uint256 executorSlot = round % SLOTS;
            uint256 signerSlot = (round + 1) % SLOTS;
            address executor = guard.getSlot(address(safe), executorSlot).owner;
            address signer = guard.getSlot(address(safe), signerSlot).owner;

            _keeper(safe, guard, executor);

            console2.log("");
            console2.log("Round", round + 1);
            console2.log("  executor (slot, index)", executorSlot, guard.getSlot(address(safe), executorSlot).nextIndex - 1);
            console2.log("  signer   (slot, index)", signerSlot, guard.getSlot(address(safe), signerSlot).nextIndex - 1);

            _execute(safe, recipient, 0.1 ether, "", Enum.Operation.Call, _keyOf(executorSlot, executor), _keyOf(signerSlot, signer));

            console2.log("  sent 0.1 ETH; signers rotated out:", !safe.isOwner(executor) && !safe.isOwner(signer));
            _printOwners(safe, "  owners now");
        }
    }

    /// @notice Prints the owner set and each slot's state.
    function status() external view {
        (Safe safe, RotationGuard guard) = _deployment();
        _printOwners(safe, "Owners");
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slot);
            console2.log("slot", slot);
            console2.log("  owner       ", view_.owner);
            console2.log("  tree index  ", view_.nextIndex - 1);
            console2.log("  staged      ", view_.staged.length);
        }
        console2.log("Safe balance (wei)", address(safe).balance);
    }

    /*//////////////////////////////////////////////////////////////
                              INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Plays the keeper (Anvil account 8): refill low buffers and give the next executor gas money.
    function _keeper(Safe safe, RotationGuard guard, address executor) internal {
        vm.startBroadcast(_anvilKey(8));
        for (uint256 slot = 0; slot < SLOTS; ++slot) {
            IRotationGuard.SlotView memory view_ = guard.getSlot(address(safe), slot);
            uint256 room = guard.BUFFER_SIZE() - view_.staged.length;
            uint256 available = _entryCount(slot) + 1 - view_.nextStageIndex;
            uint256 count = room < available ? room : available;
            if (view_.staged.length < 2 && count > 0) {
                guard.stage(address(safe), slot, _entries(slot, view_.nextStageIndex, count));
                console2.log("  keeper staged addresses for slot", slot, count);
            }
        }
        if (executor.balance < 0.01 ether) {
            (bool ok, ) = executor.call{value: 0.02 ether}("");
            require(ok, "gas top-up failed");
        }
        vm.stopBroadcast();
    }

    /// @dev `signerKey` signs the safeTxHash off-chain; `executorKey` sends the transaction with a pre-validated signature.
    function _execute(
        Safe safe,
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 executorKey,
        uint256 signerKey
    ) internal {
        address executor = vm.addr(executorKey);
        address signer = vm.addr(signerKey);
        bytes32 hash = safe.getTransactionHash(to, value, data, operation, SAFE_TX_GAS, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, hash);
        bytes memory ecdsa = abi.encodePacked(r, s, v);
        bytes memory preValidated = abi.encodePacked(bytes32(uint256(uint160(executor))), bytes32(0), uint8(1));
        bytes memory signatures = executor < signer ? bytes.concat(preValidated, ecdsa) : bytes.concat(ecdsa, preValidated);

        vm.startBroadcast(executorKey);
        safe.execTransaction(to, value, data, operation, SAFE_TX_GAS, 0, 0, address(0), payable(address(0)), signatures);
        vm.stopBroadcast();
    }

    function _deployment() internal view returns (Safe safe, RotationGuard guard) {
        string memory json = vm.readFile(string.concat(OUT, "/deployment.json"));
        safe = Safe(payable(vm.parseJsonAddress(json, ".safe")));
        guard = RotationGuard(vm.parseJsonAddress(json, ".guard"));
    }

    function _config(uint256 slot) internal view returns (IRotationGuard.SlotConfig memory) {
        string memory json = vm.readFile(string.concat(OUT, "/slot", vm.toString(slot), "-config.json"));
        return IRotationGuard.SlotConfig(
            vm.parseJsonBytes32(json, ".root"),
            uint32(vm.parseJsonUint(json, ".size")),
            uint32(vm.parseJsonUint(json, ".startIndex")),
            vm.parseJsonAddress(json, ".owner"),
            vm.parseJsonBytes32Array(json, ".proof"),
            vm.parseJsonString(json, ".cid")
        );
    }

    /// @dev `slotN-entries.json` holds the generator's entries for indexes 1..size-1 under `.entries`.
    function _entries(uint256 slot, uint256 fromIndex, uint256 count) internal view returns (IRotationGuard.StageEntry[] memory list) {
        string memory json = vm.readFile(string.concat(OUT, "/slot", vm.toString(slot), "-entries.json"));
        list = new IRotationGuard.StageEntry[](count);
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".entries[", vm.toString(fromIndex + i - 1), "]");
            list[i] = IRotationGuard.StageEntry(
                uint32(vm.parseJsonUint(json, string.concat(key, ".index"))),
                vm.parseJsonAddress(json, string.concat(key, ".owner")),
                vm.parseJsonBytes32Array(json, string.concat(key, ".proof"))
            );
        }
    }

    function _entryCount(uint256 slot) internal view returns (uint256) {
        string memory json = vm.readFile(string.concat(OUT, "/slot", vm.toString(slot), "-entries.json"));
        return vm.parseJsonUint(json, ".count");
    }

    /// @dev Tree owners are derived exactly as the generator does: m/44'/60'/{base + index}'/0/0.
    function _keyOf(uint256 slot, address owner) internal view returns (uint256 key) {
        uint256 base = vm.envUint(string.concat("DEMO_BASE_", vm.toString(slot)));
        uint256 index = 0;
        while (true) {
            key = vm.deriveKey(TEST_MNEMONIC, string.concat("m/44'/60'/", vm.toString(base + index), "'/0/"), 0);
            if (vm.addr(key) == owner) return key;
            require(++index < 10_000, "owner not in tree");
        }
    }

    function _keyOfOwner(address owner) internal pure returns (uint256) {
        for (uint256 i = 0; i < 10; ++i) if (vm.addr(_anvilKey(i)) == owner) return _anvilKey(i);
        revert("not an Anvil account");
    }

    function _anvilKey(uint256 index) internal pure returns (uint256) {
        return vm.deriveKey(TEST_MNEMONIC, uint32(index));
    }

    function _packCall(address to, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }

    function _printOwners(Safe safe, string memory label) internal view {
        address[] memory owners = safe.getOwners();
        console2.log(label);
        for (uint256 i = 0; i < owners.length; ++i) console2.log("   ", owners[i]);
    }
}
