// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeL2} from "@safe/SafeL2.sol";
import {MultiSendCallOnly} from "@safe/libraries/MultiSendCallOnly.sol";
import {SafeProxyFactory} from "@safe/proxies/SafeProxyFactory.sol";

import {RotationGuardTest} from "./RotationGuard.t.sol";

/// @notice Runs the full unit suite against SafeL2 1.5.0, the variant Safe{Wallet} deploys on many chains.
contract RotationGuardL2Test is RotationGuardTest {
    function _deployInfrastructure() internal override {
        singleton = new SafeL2();
        factory = new SafeProxyFactory();
        multiSend = new MultiSendCallOnly();
    }
}
