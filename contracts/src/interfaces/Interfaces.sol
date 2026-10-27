// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPriceOracle {
    /// @notice USD per 1 POT, 18-decimal fixed point. Reverts if stale or unset.
    function getPrice() external view returns (uint256);
}

interface IWpotBucket {
    /// @notice Sends up to `amount` WPOT to the vault. Returns what was actually sent.
    function pull(uint256 amount) external returns (uint256 sent);
}

interface IPolicyNFT {
    function mintFor(address holder, uint256 targetRateBps, uint256 insuranceShareBps) external returns (uint256 id);
}

interface ISlashableVault {
    /// @notice Records a validator slash and draws insurance to cover it. Returns the covered amount.
    function reportSlash(uint256 amount) external returns (uint256 covered);
}

interface ISwapDesk {
    function quotePotForUsd(uint256 usdAmount) external view returns (uint256 potOut);
    function quoteSharesForUsd(uint256 usdAmount) external view returns (uint256 shares);
    function depositWithStable(uint256 usdAmount, uint256 minShares, address receiver) external returns (uint256 shares);
    function redeemToStable(uint256 shares, uint256 minUsdOut, address receiver) external returns (uint256 usdOut);
}
