// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test USD (tUSD)
/// @notice Testnet-only stablecoin. Portaldot's pUSD lives in pallet-assets and has no ERC-20
///         precompile on the revive EVM, so the EVM side uses this mock instead.
contract MockStable is ERC20, Ownable {
    uint256 public constant FAUCET_MAX = 10_000e6;

    error FaucetLimit(uint256 requested);

    constructor(address initialOwner) ERC20("Test USD", "tUSD") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        if (amount > FAUCET_MAX) revert FaucetLimit(amount);
        _mint(msg.sender, amount);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
