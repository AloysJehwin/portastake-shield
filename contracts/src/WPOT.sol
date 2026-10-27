// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Wrapped tPOT
/// @notice WETH9-style wrapper so the vault can be a standard ERC-4626 over an ERC-20 asset.
/// @dev pallet-revive maps 14-decimal native POT to 18-decimal EVM wei with nativeToEthRatio = 1e4,
///      so only multiples of 1e4 wei are transferable as native value. Unwraps must respect that.
contract WPOT is ERC20 {
    uint256 public constant NATIVE_UNIT = 1e4;

    event Wrapped(address indexed account, uint256 amount);
    event Unwrapped(address indexed account, uint256 amount);

    error NotNativeUnit(uint256 amount);
    error NativeTransferFailed();

    constructor() ERC20("Wrapped tPOT", "WPOT") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Wrapped(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (amount % NATIVE_UNIT != 0) revert NotNativeUnit(amount);
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Unwrapped(msg.sender, amount);
    }
}
