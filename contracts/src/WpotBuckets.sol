// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWpotBucket} from "./interfaces/Interfaces.sol";

/// @notice A pot of WPOT that only the vault can draw from. Anyone may top it up with a plain transfer.
abstract contract WpotBucket is IWpotBucket {
    using SafeERC20 for IERC20;

    IERC20 public immutable wpot;
    address public immutable deployer;
    address public vault;

    event VaultSet(address vault);
    event Pulled(address indexed vault, uint256 requested, uint256 sent);

    error OnlyVault();
    error VaultAlreadySet();
    error OnlyDeployer();

    constructor(IERC20 wpot_) {
        wpot = wpot_;
        deployer = msg.sender;
    }

    /// @dev One-shot wiring; breaks the vault <-> bucket constructor cycle.
    function setVault(address vault_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    function pull(uint256 amount) external returns (uint256 sent) {
        if (msg.sender != vault) revert OnlyVault();
        uint256 bal = wpot.balanceOf(address(this));
        sent = amount < bal ? amount : bal;
        if (sent > 0) wpot.safeTransfer(vault, sent);
        emit Pulled(vault, amount, sent);
    }

    function balance() external view returns (uint256) {
        return wpot.balanceOf(address(this));
    }
}

/// @title InsuranceFund
/// @notice Funded by a share of staking surplus. Pays the vault back when a validator is slashed.
contract InsuranceFund is WpotBucket {
    constructor(IERC20 wpot_) WpotBucket(wpot_) {}
}

/// @title StabilizationReserve
/// @notice Funded by staking surplus up to a cap. Tops up user yield when an era pays less than the 8% target.
contract StabilizationReserve is WpotBucket {
    constructor(IERC20 wpot_) WpotBucket(wpot_) {}
}
