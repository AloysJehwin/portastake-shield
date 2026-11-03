// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Base} from "./Base.t.sol";
import {MockStable} from "../src/MockStable.sol";
import {TokenBridge} from "../src/TokenBridge.sol";
import {ISwapDesk} from "../src/interfaces/Interfaces.sol";

contract TokenBridgeTest is Base {
    uint256 constant SPOKE = 84532;
    uint256 constant OTHER_SPOKE = 421614;
    uint256 constant HUB = 420420777;
    address constant SPOKE_BRIDGE = address(0xB0B);
    uint256 constant INVENTORY = 500_000e6;

    TokenBridge hub;
    TokenBridge spoke;
    MockStable spokeUsd;

    uint256 signerKey = 0xA11CE;
    uint256 signer2Key = 0xB0B0;
    address signer;
    address signer2;

    function setUp() public override {
        super.setUp();
        vm.chainId(HUB);
        signer = vm.addr(signerKey);
        signer2 = vm.addr(signer2Key);

        hub = new TokenBridge(usd, ISwapDesk(address(desk)), admin);
        spokeUsd = new MockStable(admin);
        spoke = new TokenBridge(spokeUsd, ISwapDesk(address(0)), admin);

        vm.startPrank(admin);
        hub.setRemote(SPOKE, SPOKE_BRIDGE);
        hub.setSigner(signer, true);
        hub.setConfig(100_000e6, 1, false);
        usd.mint(address(hub), INVENTORY);
        spoke.setRemote(HUB, address(hub));
        spoke.setSigner(signer, true);
        spoke.setConfig(1_000e6, 1, false);
        spokeUsd.mint(maria, 10_000e6);
        vm.stopPrank();

        vm.prank(maria);
        spokeUsd.approve(address(spoke), type(uint256).max);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 signed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, signed);
        return abi.encodePacked(r, s, v);
    }

    function _release(uint64 n, address to, uint256 amount, uint256 minShares) internal returns (uint256) {
        bytes32 digest = hub.releaseDigest(SPOKE, n, to, amount, minShares);
        return hub.release(SPOKE, n, to, amount, minShares, _sign(signerKey, digest));
    }

    // --- bridge() ---

    function test_bridge_locksAndEmits() public {
        vm.expectEmit(address(spoke));
        emit TokenBridge.Locked(0, HUB, maria, bob, 50e6, 7);
        vm.prank(maria);
        spoke.bridge(HUB, bob, 50e6, 7);

        assertEq(spokeUsd.balanceOf(address(spoke)), 50e6);
        assertEq(spokeUsd.balanceOf(maria), 9_950e6);
        assertEq(spoke.nonce(), 1);
    }

    function test_bridge_rejectsBadInput() public {
        vm.startPrank(maria);
        vm.expectRevert(TokenBridge.UnknownRoute.selector);
        spoke.bridge(OTHER_SPOKE, bob, 1e6, 0);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        spoke.bridge(HUB, address(0), 1e6, 0);
        vm.expectRevert(TokenBridge.BadAmount.selector);
        spoke.bridge(HUB, bob, 0, 0);
        vm.expectRevert(TokenBridge.BadAmount.selector);
        spoke.bridge(HUB, bob, 1_000e6 + 1, 0);
        vm.stopPrank();
    }

    function test_paused_blocksBothDirections() public {
        vm.prank(admin);
        spoke.setConfig(1_000e6, 1, true);
        vm.prank(maria);
        vm.expectRevert(TokenBridge.IsPaused.selector);
        spoke.bridge(HUB, bob, 1e6, 0);

        bytes32 digest = hub.releaseDigest(SPOKE, 0, bob, 1e6, 0);
        bytes memory sig = _sign(signerKey, digest);
        vm.prank(admin);
        hub.setConfig(100_000e6, 1, true);
        vm.expectRevert(TokenBridge.IsPaused.selector);
        hub.release(SPOKE, 0, bob, 1e6, 0, sig);
    }

    // --- release(): plain transfer ---

    function test_release_paysReceiver_anyoneCanSubmit() public {
        vm.prank(bob);
        uint256 shares = _release(0, maria, 25e6, 0);
        assertEq(shares, 0);
        assertEq(usd.balanceOf(maria), 25e6);
        assertEq(usd.balanceOf(address(hub)), INVENTORY - 25e6);
        assertTrue(hub.processed(hub.releaseId(SPOKE, 0)));
    }

    function test_release_cannotReplay() public {
        bytes32 digest = hub.releaseDigest(SPOKE, 0, maria, 25e6, 0);
        bytes memory sig = _sign(signerKey, digest);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
        vm.expectRevert(TokenBridge.AlreadyProcessed.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
        assertEq(usd.balanceOf(maria), 25e6);
    }

    function test_release_rejectsAlteredMessage() public {
        bytes memory sig = _sign(signerKey, hub.releaseDigest(SPOKE, 0, maria, 25e6, 0));
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 26e6, 0, sig);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, bob, 25e6, 0, sig);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 1, maria, 25e6, 0, sig);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 1, sig);
    }

    function test_release_rejectsUnknownSigner() public {
        bytes memory sig = _sign(0xBAD, hub.releaseDigest(SPOKE, 0, maria, 25e6, 0));
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
    }

    function test_release_rejectsSignatureFromAnotherChain() public {
        bytes memory sig = _sign(signerKey, hub.releaseDigest(SPOKE, 0, maria, 25e6, 0));
        vm.chainId(OTHER_SPOKE);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
    }

    function test_release_rejectsSignatureForAnotherSourceBridge() public {
        bytes memory sig = _sign(signerKey, hub.releaseDigest(SPOKE, 0, maria, 25e6, 0));
        vm.prank(admin);
        hub.setRemote(SPOKE, address(0xBEEF));
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
    }

    function test_release_rejectsUnknownRoute() public {
        vm.expectRevert(TokenBridge.UnknownRoute.selector);
        hub.release(OTHER_SPOKE, 0, maria, 25e6, 0, "");
    }

    function test_release_retryableWhenInventoryShort() public {
        bytes32 digest = hub.releaseDigest(SPOKE, 0, maria, INVENTORY + 1, 0);
        bytes memory sig = _sign(signerKey, digest);
        vm.expectRevert();
        hub.release(SPOKE, 0, maria, INVENTORY + 1, 0, sig);
        assertFalse(hub.processed(hub.releaseId(SPOKE, 0)));

        vm.prank(admin);
        usd.mint(address(hub), 1);
        hub.release(SPOKE, 0, maria, INVENTORY + 1, 0, sig);
        assertEq(usd.balanceOf(maria), INVENTORY + 1);
    }

    // --- threshold ---

    function _twoOfTwo() internal {
        vm.startPrank(admin);
        hub.setSigner(signer2, true);
        hub.setConfig(100_000e6, 2, false);
        vm.stopPrank();
    }

    function _sorted(bytes32 digest) internal view returns (bytes memory low, bytes memory high) {
        (uint256 a, uint256 b) = signer < signer2 ? (signerKey, signer2Key) : (signer2Key, signerKey);
        low = _sign(a, digest);
        high = _sign(b, digest);
    }

    function test_threshold_acceptsSortedSigners() public {
        _twoOfTwo();
        bytes32 digest = hub.releaseDigest(SPOKE, 0, maria, 25e6, 0);
        (bytes memory low, bytes memory high) = _sorted(digest);
        hub.release(SPOKE, 0, maria, 25e6, 0, bytes.concat(low, high));
        assertEq(usd.balanceOf(maria), 25e6);
    }

    function test_threshold_rejectsTooFewDuplicatesAndWrongOrder() public {
        _twoOfTwo();
        bytes32 digest = hub.releaseDigest(SPOKE, 0, maria, 25e6, 0);
        (bytes memory low, bytes memory high) = _sorted(digest);

        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, low);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, bytes.concat(low, low));
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, bytes.concat(high, low));
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, bytes.concat(low, high, hex"00"));
    }

    function test_threshold_zeroClosesRelease() public {
        bytes memory sig = _sign(signerKey, hub.releaseDigest(SPOKE, 0, maria, 25e6, 0));
        vm.prank(admin);
        hub.setConfig(100_000e6, 0, false);
        vm.expectRevert(TokenBridge.BadSignatures.selector);
        hub.release(SPOKE, 0, maria, 25e6, 0, sig);
    }

    // --- the one-flow path: bridge in and save ---

    function test_save_receiverGetsStPot() public {
        uint256 expected = vault.previewDeposit(desk.quotePotForUsd(25e6));
        uint256 shares = _release(0, maria, 25e6, 1);

        assertEq(shares, expected);
        assertEq(vault.balanceOf(maria), expected);
        assertEq(usd.balanceOf(maria), 0);
        assertEq(usd.allowance(address(hub), address(desk)), 0);
        assertEq(usd.balanceOf(address(hub)), INVENTORY - 25e6);
    }

    function _assertFellBackToTusd(uint256 minShares) internal {
        uint256 shares = _release(0, maria, 25e6, minShares);
        assertEq(shares, 0);
        assertEq(usd.balanceOf(maria), 25e6);
        assertEq(vault.balanceOf(maria), 0);
        assertEq(usd.allowance(address(hub), address(desk)), 0);
        assertTrue(hub.processed(hub.releaseId(SPOKE, 0)));
    }

    function test_save_fallsBackOnStalePrice() public {
        vm.warp(vm.getBlockTimestamp() + 2 days);
        _assertFellBackToTusd(1);
    }

    function test_save_fallsBackOnSlippage() public {
        _assertFellBackToTusd(type(uint256).max);
    }

    function test_save_fallsBackWhenDeskIsOutOfPot() public {
        vm.startPrank(admin);
        desk.removeLiquidity(IERC20(address(wpot)), admin, wpot.balanceOf(address(desk)));
        vm.stopPrank();
        _assertFellBackToTusd(1);
    }

    function test_save_ignoredOnChainsWithoutDesk() public {
        vm.chainId(SPOKE);
        vm.prank(admin);
        spokeUsd.mint(address(spoke), 100e6);
        bytes32 digest = spoke.releaseDigest(HUB, 0, bob, 25e6, 1);
        uint256 shares = spoke.release(HUB, 0, bob, 25e6, 1, _sign(signerKey, digest));
        assertEq(shares, 0);
        assertEq(spokeUsd.balanceOf(bob), 25e6);
    }

    // --- admin ---

    function test_admin_onlyOwner() public {
        vm.startPrank(bob);
        vm.expectRevert(TokenBridge.NotOwner.selector);
        hub.setConfig(1, 1, false);
        vm.expectRevert(TokenBridge.NotOwner.selector);
        hub.setRemote(SPOKE, bob);
        vm.expectRevert(TokenBridge.NotOwner.selector);
        hub.setSigner(bob, true);
        vm.stopPrank();
    }

    // --- fuzz ---

    function testFuzz_release_conservesInventory(uint256 amount, uint64 n, bool save) public {
        amount = bound(amount, 1, INVENTORY);
        uint256 before = usd.balanceOf(address(hub));
        // Large saves exhaust the desk's POT and fall back to tUSD, which is the case worth covering.
        uint256 shares = _release(n, maria, amount, save ? 1 : 0);

        assertEq(usd.balanceOf(address(hub)), before - amount);
        assertEq(usd.allowance(address(hub), address(desk)), 0);
        if (shares == 0) assertEq(usd.balanceOf(maria), amount);
        else assertEq(vault.balanceOf(maria), shares);
    }
}
