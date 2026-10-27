// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {WPOT} from "../src/WPOT.sol";
import {InsuranceFund} from "../src/WpotBuckets.sol";

contract VaultHandler is Test {
    StakingVault vault;
    WPOT wpot;
    InsuranceFund insurance;
    address relayer;
    address committee;
    address[3] users = [address(0xA1), address(0xA2), address(0xA3)];

    uint256 public lastPrice = 1e18;
    bool public priceDropped;

    constructor(StakingVault vault_, WPOT wpot_, InsuranceFund insurance_, address relayer_, address committee_) {
        (vault, wpot, insurance, relayer, committee) = (vault_, wpot_, insurance_, relayer_, committee_);
        for (uint256 i; i < 3; ++i) {
            vm.deal(users[i], 1e30);
        }
        vm.deal(relayer, 1e30);
    }

    modifier checkPrice() {
        _;
        uint256 p = vault.convertToAssets(1e18);
        if (p + 1 < lastPrice) priceDropped = true;
        if (p > lastPrice) lastPrice = p;
    }

    function deposit(uint256 who, uint256 amount) external checkPrice {
        amount = bound(amount, 1e4, 1e24);
        address u = users[who % 3];
        vm.prank(u);
        vault.depositNative{value: amount}(u);
    }

    function redeem(uint256 who, uint256 shares) external checkPrice {
        address u = users[who % 3];
        uint256 max = vault.maxRedeem(u);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(u);
        vault.redeem(shares, u, u);
    }

    function sweep(uint256 amount) external checkPrice {
        uint256 liquid = vault.availableLiquidity();
        uint256 floor = vault.totalAssets() * vault.targetHotBps() / 10_000;
        if (liquid <= floor + 1e4) return;
        amount = bound(amount, 1e4, liquid - floor);
        amount -= amount % 1e4;
        vm.prank(relayer);
        vault.sweepToStake(amount);
    }

    function reward(uint256 grossBps, uint256 dt) external checkPrice {
        dt = bound(dt, 1, 2 days);
        vm.warp(block.timestamp + dt);
        grossBps = bound(grossBps, 0, 4_000);
        uint256 r = vault.bondedPrincipal() * grossBps * dt / (10_000 * 365 days);
        r -= r % 1e4;
        vm.prank(relayer);
        vault.notifyReward{value: r}();
    }

    /// @dev Only slashes the insurance fund can fully cover, so share price must hold.
    function slash(uint256 amount) external checkPrice {
        uint256 cap = insurance.balance();
        if (vault.bondedPrincipal() < cap) cap = vault.bondedPrincipal();
        if (cap == 0) return;
        amount = bound(amount, 1, cap);
        vm.prank(committee);
        vault.reportSlash(amount);
    }

    function warp(uint256 dt) external checkPrice {
        vm.warp(block.timestamp + bound(dt, 1, 1 days));
    }
}

contract VaultInvariantTest is Base {
    VaultHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, wpot, insurance, relayer, address(committee));
        targetContract(address(handler));
    }

    /// Yield is streamed and slashes are insured: the share price only goes up.
    function invariant_sharePriceNeverDrops() public view {
        assertFalse(handler.priceDropped());
    }

    /// Unvested yield is always physically held by the vault.
    function invariant_unvestedIsBacked() public view {
        assertGe(wpot.balanceOf(address(vault)), vault.unvestedRewards());
    }

    /// The vault never owes more than it holds.
    function invariant_solvent() public view {
        assertGe(vault.totalAssets(), vault.convertToAssets(vault.totalSupply()));
        assertGe(vault.bondedPrincipal(), vault.pendingUnstakeAssets());
    }
}
