// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ISwapDesk} from "./interfaces/Interfaces.sol";

/// @title XusdGateway
/// @notice Lets xUSD (the x402 payments token) move in and out of PortaStake savings.
///         SwapDesk prices tUSD, so the gateway swaps xUSD and tUSD 1:1 against inventory it
///         holds and calls the desk on the user's behalf. Both tokens are 6-decimal test dollars.
///
///   deposit:  user xUSD -> gateway; gateway tUSD -> SwapDesk -> stPOT to `receiver`
///   withdraw: user stPOT -> gateway -> SwapDesk -> tUSD to gateway; gateway xUSD -> `receiver`
///
/// Slippage floors are the caller's, enforced by the desk. Inventory runs out rather than
/// minting: a swap the gateway can't cover reverts.
contract XusdGateway {
    using SafeTransferLib for address;

    address public immutable xusd;
    address public immutable tusd;
    address public immutable shares; // stPOT (the vault)
    ISwapDesk public immutable desk;

    event DepositedXusd(address indexed payer, address indexed receiver, uint256 amount, uint256 shares);
    event WithdrewToXusd(address indexed owner, address indexed receiver, uint256 shares, uint256 amount);

    constructor(address xusd_, address tusd_, address shares_, ISwapDesk desk_) {
        xusd = xusd_;
        tusd = tusd_;
        shares = shares_;
        desk = desk_;
    }

    /// @notice Save `amount` xUSD: credits stPOT to `receiver`. Needs an xUSD allowance.
    function depositXusd(uint256 amount, uint256 minShares, address receiver) external returns (uint256 out) {
        xusd.safeTransferFrom(msg.sender, address(this), amount);
        tusd.safeApprove(address(desk), amount);
        out = desk.depositWithStable(amount, minShares, receiver);
        emit DepositedXusd(msg.sender, receiver, amount, out);
    }

    /// @notice Withdraw `shareAmount` stPOT as xUSD to `receiver`. Needs an stPOT allowance.
    function withdrawToXusd(uint256 shareAmount, uint256 minOut, address receiver) external returns (uint256 out) {
        shares.safeTransferFrom(msg.sender, address(this), shareAmount);
        shares.safeApprove(address(desk), shareAmount);
        out = desk.redeemToStable(shareAmount, minOut, address(this));
        xusd.safeTransfer(receiver, out);
        emit WithdrewToXusd(msg.sender, receiver, shareAmount, out);
    }
}
