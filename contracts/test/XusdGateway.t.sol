// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {X402Dollar} from "../src/X402Dollar.sol";
import {XusdGateway} from "../src/XusdGateway.sol";

contract XusdGatewayTest is Base {
    X402Dollar xusd;
    XusdGateway gw;

    function setUp() public override {
        super.setUp();
        xusd = new X402Dollar();
        gw = new XusdGateway(address(xusd), address(usd), address(vault), desk);
        // Stock the gateway: tUSD for deposits, xUSD for withdrawals.
        vm.prank(admin);
        usd.mint(address(gw), 1_000e6);
        vm.prank(admin);
        xusd.faucet(1_000e6);
        vm.prank(admin);
        xusd.transfer(address(gw), 1_000e6);

        vm.startPrank(maria);
        xusd.faucet(100e6);
        xusd.approve(address(gw), type(uint256).max);
        vault.approve(address(gw), type(uint256).max);
        vm.stopPrank();
    }

    function test_depositXusdCreditsStPotToReceiver() public {
        vm.prank(maria);
        uint256 shares = gw.depositXusd(20e6, 1, maria);
        assertGt(shares, 0);
        assertEq(vault.balanceOf(maria), shares);
        assertEq(xusd.balanceOf(maria), 80e6);
        assertEq(xusd.balanceOf(address(gw)), 1_020e6); // xUSD stays in the gateway's stock
        assertEq(usd.balanceOf(address(gw)), 980e6); // tUSD went to the desk
        assertEq(usd.allowance(address(gw), address(desk)), 0);
    }

    function test_withdrawToXusdPaysAnyReceiver() public {
        vm.prank(maria);
        uint256 shares = gw.depositXusd(20e6, 1, maria);
        vm.prank(maria);
        uint256 out = gw.withdrawToXusd(shares / 2, 1, bob);
        assertGt(out, 0);
        assertEq(xusd.balanceOf(bob), out);
        assertEq(vault.balanceOf(maria), shares - shares / 2);
        assertEq(usd.balanceOf(address(gw)), 980e6 + out); // desk's tUSD refills the stock
        assertEq(vault.allowance(address(gw), address(desk)), 0);
    }

    function test_slippageFloorEnforced() public {
        vm.prank(maria);
        vm.expectRevert();
        gw.depositXusd(20e6, type(uint256).max, maria);
    }

    function test_revertsWhenStockShort() public {
        vm.prank(maria);
        xusd.faucet(1_000e6);
        vm.prank(maria);
        vm.expectRevert(); // gateway holds 1,000 tUSD, not 1,100
        gw.depositXusd(1_100e6, 1, maria);
    }

    function test_cannotSpendOthersFunds() public {
        vm.prank(bob);
        vm.expectRevert(); // bob has no xUSD allowance to the gateway from maria's balance
        gw.depositXusd(10e6, 1, bob);
    }
}
