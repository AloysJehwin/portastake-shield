// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWpotBucket {
    /// @notice Sends up to `amount` WPOT to the vault. Returns what was actually sent.
    function pull(uint256 amount) external returns (uint256 sent);
}

interface ISlashableVault {
    /// @notice Records a validator slash and draws insurance to cover it. Returns the covered amount.
    function reportSlash(uint256 amount) external returns (uint256 covered);
}
