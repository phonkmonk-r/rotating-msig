// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISafe} from "@safe/interfaces/ISafe.sol";
import {Enum} from "@safe/libraries/Enum.sol";

contract Reverter {
    function boom() external pure {
        revert("boom");
    }
}

contract RogueModule {
    function drain(ISafe safe, address to) external returns (bool) {
        return safe.execTransactionFromModule(to, address(safe).balance, "", Enum.Operation.Call);
    }

    function call(ISafe safe, bytes calldata data) external returns (bool) {
        return safe.execTransactionFromModule(address(safe), 0, data, Enum.Operation.Call);
    }
}

contract Reentrant {
    function reenter(address safe, bytes calldata payload) external {
        (bool ok, bytes memory ret) = safe.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
