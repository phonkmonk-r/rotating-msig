// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {RotationGuard} from "../src/RotationGuard.sol";

/**
 * @notice Deploys the RotationGuard singleton on mainnet or Sepolia. One deployment serves every Safe on the chain.
 * @dev forge script script/DeployGuard.s.sol --rpc-url <rpc> --account <keystore> --broadcast
 */
contract DeployGuard is Script {
    /// @notice Canonical Safe 1.5.0 MultiSendCallOnly, identical on mainnet and Sepolia.
    address internal constant MULTI_SEND_CALL_ONLY = 0xA83c336B20401Af773B6219BA5027174338D1836;
    uint256 internal constant SEPOLIA = 11_155_111;

    function run() external returns (RotationGuard guard) {
        require(block.chainid == 1 || block.chainid == SEPOLIA, "mainnet or Sepolia only");
        require(MULTI_SEND_CALL_ONLY.code.length > 0, "MultiSendCallOnly not deployed on this chain");

        vm.startBroadcast();
        guard = new RotationGuard(MULTI_SEND_CALL_ONLY);
        vm.stopBroadcast();

        console2.log("chain", block.chainid);
        console2.log("RotationGuard", address(guard));
    }
}
