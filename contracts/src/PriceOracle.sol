// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPriceOracle} from "./interfaces/Interfaces.sol";

/// @title POT/USD price feed
/// @notice Pushed by the relayer, which reads the native assetConversion pool (tPOT / pUSD, asset 7777).
contract PriceOracle is IPriceOracle, AccessControl {
    bytes32 public constant FEEDER_ROLE = keccak256("FEEDER_ROLE");

    uint256 public price;
    uint64 public updatedAt;
    uint64 public maxAge;

    event PriceUpdated(uint256 price, uint64 updatedAt);
    event MaxAgeUpdated(uint64 maxAge);

    error StalePrice(uint64 updatedAt);
    error InvalidPrice();

    constructor(address admin, uint64 maxAge_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEEDER_ROLE, admin);
        maxAge = maxAge_;
    }

    function setPrice(uint256 newPrice) external onlyRole(FEEDER_ROLE) {
        if (newPrice == 0) revert InvalidPrice();
        price = newPrice;
        updatedAt = uint64(block.timestamp);
        emit PriceUpdated(newPrice, updatedAt);
    }

    function setMaxAge(uint64 maxAge_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAge = maxAge_;
        emit MaxAgeUpdated(maxAge_);
    }

    function getPrice() external view returns (uint256) {
        if (price == 0) revert InvalidPrice();
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(updatedAt);
        return price;
    }
}
