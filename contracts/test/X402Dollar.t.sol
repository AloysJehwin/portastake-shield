// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {X402Dollar} from "../src/X402Dollar.sol";

contract X402DollarTest is Test {
    X402Dollar token;
    uint256 payerKey = 0xA11CE;
    address payer;
    address merchant = address(0xBEEF);
    address facilitator = address(0xFAC1);

    function setUp() public {
        token = new X402Dollar();
        payer = vm.addr(payerKey);
        vm.prank(payer);
        token.faucet(100e6);
        vm.warp(1_000_000);
    }

    function _sign(uint256 key, address from, address to, uint256 value, uint256 after_, uint256 before, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, after_, before, nonce));
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_typehashAndDomain() public view {
        assertEq(
            token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("x402 Test USD"),
                keccak256("1"),
                block.chainid,
                address(token)
            )
        );
        assertEq(token.DOMAIN_SEPARATOR(), expected);
        assertEq(token.version(), "1");
        assertEq(token.decimals(), 6);
    }

    function test_facilitatorSettlesSignedPayment() public {
        bytes32 nonce = keccak256("n1");
        uint256 before = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, payer, merchant, 1e5, 0, before, nonce);
        vm.prank(facilitator);
        token.transferWithAuthorization(payer, merchant, 1e5, 0, before, nonce, v, r, s);
        assertEq(token.balanceOf(merchant), 1e5);
        assertEq(token.balanceOf(payer), 100e6 - 1e5);
        assertTrue(token.authorizationState(payer, nonce));
    }

    function test_replayRejected() public {
        bytes32 nonce = keccak256("n1");
        uint256 before = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, payer, merchant, 1e5, 0, before, nonce);
        token.transferWithAuthorization(payer, merchant, 1e5, 0, before, nonce, v, r, s);
        vm.expectRevert(X402Dollar.AuthorizationUsedAlready.selector);
        token.transferWithAuthorization(payer, merchant, 1e5, 0, before, nonce, v, r, s);
    }

    function test_windowEnforced() public {
        bytes32 nonce = keccak256("n2");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, payer, merchant, 1e5, 0, block.timestamp, nonce);
        vm.expectRevert(X402Dollar.AuthorizationExpired.selector);
        token.transferWithAuthorization(payer, merchant, 1e5, 0, block.timestamp, nonce, v, r, s);

        uint256 after_ = block.timestamp + 10;
        (v, r, s) = _sign(payerKey, payer, merchant, 1e5, after_, after_ + 600, nonce);
        vm.expectRevert(X402Dollar.AuthorizationNotYetValid.selector);
        token.transferWithAuthorization(payer, merchant, 1e5, after_, after_ + 600, nonce, v, r, s);
    }

    function test_tamperedFieldsOrWrongSignerRejected() public {
        bytes32 nonce = keccak256("n3");
        uint256 before = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, payer, merchant, 1e5, 0, before, nonce);
        // facilitator tries to redirect or inflate the payment
        vm.expectRevert(X402Dollar.InvalidSignature.selector);
        token.transferWithAuthorization(payer, facilitator, 1e5, 0, before, nonce, v, r, s);
        vm.expectRevert(X402Dollar.InvalidSignature.selector);
        token.transferWithAuthorization(payer, merchant, 2e5, 0, before, nonce, v, r, s);
        // someone else's key
        (v, r, s) = _sign(0xB0B, payer, merchant, 1e5, 0, before, nonce);
        vm.expectRevert(X402Dollar.InvalidSignature.selector);
        token.transferWithAuthorization(payer, merchant, 1e5, 0, before, nonce, v, r, s);
    }

    function test_faucetCapped() public {
        vm.expectRevert(abi.encodeWithSelector(X402Dollar.FaucetLimit.selector, 1_001e6));
        token.faucet(1_001e6);
    }
}
