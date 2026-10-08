// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Builds commutative keccak Merkle trees compatible with OpenZeppelin's `MerkleProof`.
library MerkleBuilder {
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _next(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        bytes32[] memory path = new bytes32[](64);
        uint256 depth;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) path[depth++] = level[sibling];
            level = _next(level);
            index >>= 1;
        }
        assembly ("memory-safe") {
            mstore(path, depth)
        }
        return path;
    }

    function _next(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < next.length; ++i) {
            uint256 left = 2 * i;
            next[i] = left + 1 < level.length ? _hashPair(level[left], level[left + 1]) : level[left];
        }
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
