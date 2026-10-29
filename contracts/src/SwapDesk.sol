// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title SwapDesk (Router)
/// @notice One-call stablecoin on-ramp/off-ramp for the vault: tUSD -> POT -> stPOT and back.
/// @dev v1 is an inventory desk priced by a relayer-fed POT/USD feed (read from the native
///      tPOT/pUSD assetConversion pool). Replace with a real DEX once one is reachable from the revive EVM.
///
///      Savings automation runs in the relayer. Its only on-chain power is `depositFor`: it can move a
///      user's tUSD into that same user's savings, up to a budget the user sets here.
contract SwapDesk is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant FEEDER_ROLE = keccak256("FEEDER_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 300;

    IERC20 public immutable stable;
    IERC20 public immutable wpot;
    IERC4626 public immutable vault;
    uint256 public immutable stableScale; // 10 ** (18 - stable decimals)

    uint256 public feeBps = 30;

    /// @notice USD per 1 POT, 18-decimal fixed point.
    uint256 public price;
    uint64 public updatedAt;
    uint64 public maxAge;

    /// @notice tUSD the keeper may still auto-save on each user's behalf.
    mapping(address => uint256) public autoSaveBudget;

    event StableDeposited(
        address indexed payer, address indexed receiver, uint256 usdIn, uint256 potIn, uint256 shares
    );
    event StableRedeemed(
        address indexed owner, address indexed receiver, uint256 shares, uint256 potOut, uint256 usdOut
    );
    event PriceUpdated(uint256 price, uint64 updatedAt);
    event MaxAgeUpdated(uint64 maxAge);
    event AutoSaveBudgetSet(address indexed owner, uint256 budget);
    event FeeUpdated(uint256 feeBps);
    event LiquidityRemoved(address indexed token, address indexed to, uint256 amount);

    error InsufficientInventory(address token, uint256 needed, uint256 available);
    error Slippage(uint256 got, uint256 min);
    error FeeTooHigh(uint256 feeBps);
    error ZeroAmount();
    error StalePrice(uint64 updatedAt);
    error InvalidPrice();
    error OverBudget(uint256 requested, uint256 budget);

    constructor(IERC20 stable_, IERC4626 vault_, address admin, uint64 maxAge_) {
        stable = stable_;
        vault = vault_;
        wpot = IERC20(vault_.asset());
        stableScale = 10 ** (18 - IERC20Metadata(address(stable_)).decimals());
        maxAge = maxAge_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEEDER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Price feed
    // ---------------------------------------------------------------------

    /// @notice Current POT/USD price. Reverts if unset or older than `maxAge`.
    function getPrice() public view returns (uint256) {
        if (price == 0) revert InvalidPrice();
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(updatedAt);
        return price;
    }

    function setPrice(uint256 newPrice) external onlyRole(FEEDER_ROLE) {
        if (newPrice == 0) revert InvalidPrice();
        price = newPrice;
        updatedAt = uint64(block.timestamp);
        emit PriceUpdated(newPrice, updatedAt);
    }

    // ---------------------------------------------------------------------
    // Quotes
    // ---------------------------------------------------------------------

    function quotePotForUsd(uint256 usdAmount) public view returns (uint256 potOut) {
        uint256 gross = Math.mulDiv(usdAmount * stableScale, 1e18, getPrice());
        potOut = Math.mulDiv(gross, BPS - feeBps, BPS);
    }

    function quoteUsdForPot(uint256 potAmount) public view returns (uint256 usdOut) {
        uint256 gross = Math.mulDiv(potAmount, getPrice(), 1e18 * stableScale);
        usdOut = Math.mulDiv(gross, BPS - feeBps, BPS);
    }

    // ---------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------

    /// @notice Pay `usdAmount` tUSD, receive stPOT in `receiver`'s name.
    function depositWithStable(uint256 usdAmount, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares)
    {
        shares = _depositWithStable(msg.sender, usdAmount, minShares, receiver);
    }

    /// @notice Keeper-run auto-save: moves `owner`'s tUSD into `owner`'s own savings, within their budget.
    function depositFor(address owner, uint256 usdAmount, uint256 minShares)
        external
        nonReentrant
        onlyRole(KEEPER_ROLE)
        returns (uint256 shares)
    {
        uint256 budget = autoSaveBudget[owner];
        if (usdAmount > budget) revert OverBudget(usdAmount, budget);
        autoSaveBudget[owner] = budget - usdAmount;
        shares = _depositWithStable(owner, usdAmount, minShares, owner);
    }

    /// @notice Cap how much tUSD the keeper may auto-save for you in total. Set 0 to stop automation.
    function setAutoSaveBudget(uint256 budget) external {
        autoSaveBudget[msg.sender] = budget;
        emit AutoSaveBudgetSet(msg.sender, budget);
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

    function _depositWithStable(address payer, uint256 usdAmount, uint256 minShares, address receiver)
        internal
        returns (uint256 shares)
    {
        if (usdAmount == 0) revert ZeroAmount();
        uint256 potIn = quotePotForUsd(usdAmount);
        uint256 inventory = wpot.balanceOf(address(this));
        if (potIn > inventory) revert InsufficientInventory(address(wpot), potIn, inventory);

        stable.safeTransferFrom(payer, address(this), usdAmount);
        wpot.forceApprove(address(vault), potIn);
        shares = vault.deposit(potIn, receiver);
        if (shares < minShares) revert Slippage(shares, minShares);
        emit StableDeposited(payer, receiver, usdAmount, potIn, shares);
    }

    // ---------------------------------------------------------------------
    // Admin. Liquidity is added with plain ERC-20 transfers.
    // ---------------------------------------------------------------------

    function setMaxAge(uint64 maxAge_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAge = maxAge_;
        emit MaxAgeUpdated(maxAge_);
    }

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
