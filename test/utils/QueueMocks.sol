// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token for the signer's queue tests; anyone can mint.
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Pulls tokens with `transferFrom`, so a deposit only works after an approval, like most DeFi vaults.
contract MockVault {
    ERC20 public immutable token;
    mapping(address => uint256) public deposits;

    constructor(ERC20 token_) {
        token = token_;
    }

    function deposit(uint256 amount) external {
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
    }
}
