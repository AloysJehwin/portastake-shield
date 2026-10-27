// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPriceOracle, ISwapDesk} from "./interfaces/Interfaces.sol";

/// @title SwapDesk (Router)
/// @notice One-call stablecoin on-ramp/off-ramp for the vault: tUSD -> POT -> stPOT and back.
/// @dev v1 is an inventory desk priced by PriceOracle (fed from the native tPOT/pUSD
///      assetConversion pool). Replace with a real DEX once one is reachable from the revive EVM.
contract SwapDesk is ISwapDesk, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 300;

    IERC20 public immutable stable;
    IERC20 public immutable wpot;
    IERC4626 public immutable vault;
    IPriceOracle public immutable oracle;
    uint256 public immutable stableScale; // 10 ** (18 - stable decimals)

    uint256 public feeBps = 30;

    event StableDeposited(
        address indexed payer, address indexed receiver, uint256 usdIn, uint256 potIn, uint256 shares
    );
    event StableRedeemed(
        address indexed owner, address indexed receiver, uint256 shares, uint256 potOut, uint256 usdOut
    );
    event FeeUpdated(uint256 feeBps);
    event LiquidityRemoved(address indexed token, address indexed to, uint256 amount);

    error InsufficientInventory(address token, uint256 needed, uint256 available);
    error Slippage(uint256 got, uint256 min);
    error FeeTooHigh(uint256 feeBps);
    error ZeroAmount();

    constructor(IERC20 stable_, IERC4626 vault_, IPriceOracle oracle_, address admin) {
        stable = stable_;
        vault = vault_;
        wpot = IERC20(vault_.asset());
        oracle = oracle_;
        stableScale = 10 ** (18 - IERC20Metadata(address(stable_)).decimals());
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Quotes
    // ---------------------------------------------------------------------

    function quotePotForUsd(uint256 usdAmount) public view returns (uint256 potOut) {
        uint256 gross = Math.mulDiv(usdAmount * stableScale, 1e18, oracle.getPrice());
        potOut = Math.mulDiv(gross, BPS - feeBps, BPS);
    }

    function quoteUsdForPot(uint256 potAmount) public view returns (uint256 usdOut) {
        uint256 gross = Math.mulDiv(potAmount, oracle.getPrice(), 1e18 * stableScale);
        usdOut = Math.mulDiv(gross, BPS - feeBps, BPS);
    }

    /// @notice stPOT shares to redeem so that the desk pays out at least `usdAmount`.
    function quoteSharesForUsd(uint256 usdAmount) public view returns (uint256 shares) {
        uint256 potNeeded =
            Math.mulDiv(usdAmount * stableScale, 1e18 * BPS, oracle.getPrice() * (BPS - feeBps), Math.Rounding.Ceil);
        shares = vault.previewWithdraw(potNeeded);
    }

    // ---------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------

    /// @notice Pay `usdAmount` tUSD, receive stPOT in `receiver`'s name (and a PolicyNFT on first deposit).
    function depositWithStable(uint256 usdAmount, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (usdAmount == 0) revert ZeroAmount();
        uint256 potIn = quotePotForUsd(usdAmount);
        uint256 inventory = wpot.balanceOf(address(this));
        if (potIn > inventory) revert InsufficientInventory(address(wpot), potIn, inventory);

        stable.safeTransferFrom(msg.sender, address(this), usdAmount);
        wpot.forceApprove(address(vault), potIn);
        shares = vault.deposit(potIn, receiver);
        if (shares < minShares) revert Slippage(shares, minShares);
        emit StableDeposited(msg.sender, receiver, usdAmount, potIn, shares);
    }

    /// @notice Redeem the caller's stPOT for tUSD sent to `receiver`. Only the hot reserve is instant.
    function redeemToStable(uint256 shares, uint256 minUsdOut, address receiver)
        external
        nonReentrant
        returns (uint256 usdOut)
    {
        if (shares == 0) revert ZeroAmount();
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        uint256 potOut = vault.redeem(shares, address(this), address(this));
        usdOut = quoteUsdForPot(potOut);
        if (usdOut < minUsdOut) revert Slippage(usdOut, minUsdOut);
        uint256 inventory = stable.balanceOf(address(this));
        if (usdOut > inventory) revert InsufficientInventory(address(stable), usdOut, inventory);
        stable.safeTransfer(receiver, usdOut);
        emit StableRedeemed(msg.sender, receiver, shares, potOut, usdOut);
    }

    // ---------------------------------------------------------------------
    // Admin. Liquidity is added with plain ERC-20 transfers.
    // ---------------------------------------------------------------------

    function setFee(uint256 feeBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function removeLiquidity(IERC20 token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        token.safeTransfer(to, amount);
        emit LiquidityRemoved(address(token), to, amount);
    }
}
