// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Safe} from "@safe/Safe.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {RotationGuardTest} from "./RotationGuard.t.sol";

/// @notice Runs the full unit suite against the canonical Safe 1.5.0 mainnet deployments at a pinned block.
contract RotationGuardForkTest is RotationGuardTest {
    address internal constant SAFE_SINGLETON = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address internal constant SAFE_PROXY_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant MULTI_SEND_CALL_ONLY = 0xA83c336B20401Af773B6219BA5027174338D1836;
    uint256 internal constant FORK_BLOCK = 26_146_400;

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        super.setUp();
    }

    function _deployInfrastructure() internal override {
        singleton = Safe(payable(SAFE_SINGLETON));
        factory = SafeProxyFactory(SAFE_PROXY_FACTORY);
        multiSend = MultiSendCallOnly(MULTI_SEND_CALL_ONLY);
    }

    function test_fork_usesCanonicalDeployments() public view {
        assertEq(keccak256(bytes(Safe(payable(address(safe))).VERSION())), keccak256("1.5.0"));
        assertEq(guard.MULTI_SEND_CALL_ONLY(), MULTI_SEND_CALL_ONLY);
        bytes32 singletonSlot = vm.load(address(safe), bytes32(0));
        assertEq(address(uint160(uint256(singletonSlot))), SAFE_SINGLETON);
    }
}
