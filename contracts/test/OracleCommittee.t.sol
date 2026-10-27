// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {OracleCommittee} from "../src/OracleCommittee.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract OracleCommitteeTest is Base {
    uint256[3] keys;
    address[3] signers; // sorted ascending
    bytes32 constant VALIDATOR = bytes32(uint256(0xBEEF));

    function setUp() public override {
        super.setUp();
        uint256[3] memory k = [uint256(0xA11CE), uint256(0xB0B), uint256(0xCA7)];
        // sort by address
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (vm.addr(k[j]) < vm.addr(k[i])) (k[i], k[j]) = (k[j], k[i]);
            }
        }
        vm.startPrank(admin);
        for (uint256 i; i < 3; ++i) {
            keys[i] = k[i];
            signers[i] = vm.addr(k[i]);
            committee.addAttester(signers[i]);
        }
        committee.setThreshold(2);
        vm.stopPrank();

        _depositNative(maria, 1_000 ether);
        vm.prank(relayer);
        vault.sweepToStake(900 ether);
        vm.warp(block.timestamp + ERA);
        _reward(60 ether); // funds insurance
    }

    function _sig(uint256 key, uint32 era, uint256 amount) internal view returns (bytes memory) {
        bytes32 d = MessageHashUtils.toEthSignedMessageHash(committee.slashDigest(VALIDATOR, era, amount));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }

    function test_twoOfThreeFinalizesAndInsuranceCovers() public {
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        sigs[1] = _sig(keys[2], 61, 5 ether);

        uint256 priceBefore = vault.convertToAssets(1 ether);
        uint256 insBefore = insurance.balance();
        vm.prank(keeper); // permissionless submission
        uint256 covered = committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);

        assertEq(covered, 5 ether);
        assertEq(insBefore - insurance.balance(), 5 ether);
        assertEq(vault.convertToAssets(1 ether), priceBefore);
    }

    function test_replayRejected() public {
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        sigs[1] = _sig(keys[1], 61, 5 ether);
        committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);
        vm.expectRevert(
            abi.encodeWithSelector(OracleCommittee.AlreadyProcessed.selector, committee.slashId(VALIDATOR, 61))
        );
        committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);
    }

    function test_belowThresholdRejected() public {
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleCommittee.BelowThreshold.selector, 1, 2));
        committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);
    }

    function test_duplicateSignerRejected() public {
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        sigs[1] = _sig(keys[0], 61, 5 ether);
        vm.expectRevert(OracleCommittee.SignersNotSorted.selector);
        committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);
    }

    function test_outsiderRejected() public {
        uint256 outsider = 0xDEAD;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        sigs[1] = _sig(outsider, 61, 5 ether);
        if (vm.addr(outsider) < signers[0]) (sigs[0], sigs[1]) = (sigs[1], sigs[0]);
        vm.expectRevert(abi.encodeWithSelector(OracleCommittee.NotAttester.selector, vm.addr(outsider)));
        committee.submitSlash(VALIDATOR, 61, 5 ether, sigs);
    }

    function test_tamperedAmountRejected() public {
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(keys[0], 61, 5 ether);
        sigs[1] = _sig(keys[1], 61, 5 ether);
        vm.expectRevert(); // recovers to unknown signers
        committee.submitSlash(VALIDATOR, 61, 500 ether, sigs);
    }
}
