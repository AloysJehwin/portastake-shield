// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";

/// @notice Shared config + JSON merge for the staged deploy scripts.
///
/// Each stage reads the deployments/<chainId>.json left behind by earlier stages, deploys its
/// slice, and rewrites the file including every known address. Keys for contracts that have not
/// been deployed yet are serialized as the zero address, so a frontend can simply check `!= 0`.
abstract contract Shared is Script {
    string internal constant K = "deployment";

    struct Config {
        uint256 pk;
        address deployer;
        address relayer;
        address stakingAccount;
        address treasury;
        address attester;
        uint256 potPrice;
        uint256 seedPot;
        uint256 deskPot;
        uint256 deskUsd;
    }

    struct Addrs {
        address wpot;
        address tusd;
        address insurance;
        address reserve;
        address vault;
        address desk;
        address policy;
        address mandates;
        address committee;
    }

    function _config() internal view returns (Config memory c) {
        c.pk = vm.envUint("PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.relayer = vm.envOr("RELAYER", c.deployer);
        c.stakingAccount = vm.envOr("STAKING_ACCOUNT", c.relayer);
        c.treasury = vm.envOr("TREASURY", c.deployer);
        c.attester = vm.envOr("ATTESTER", c.deployer);
        c.potPrice = vm.envOr("POT_PRICE", uint256(0.5e18));
        c.seedPot = vm.envOr("SEED_POT", uint256(1 ether));
        c.deskPot = vm.envOr("DESK_POT", uint256(50 ether));
        c.deskUsd = vm.envOr("DESK_USD", uint256(100_000e6));
    }

    function _path() internal view returns (string memory) {
        return string.concat("./deployments/", vm.toString(block.chainid), ".json");
    }

    function _load() internal returns (Addrs memory a) {
        string memory json;
        try vm.readFile(_path()) returns (string memory j) {
            json = j;
        } catch {
            return a;
        }
        a.wpot = _tryAddr(json, ".WPOT");
        a.tusd = _tryAddr(json, ".tUSD");
        a.insurance = _tryAddr(json, ".InsuranceFund");
        a.reserve = _tryAddr(json, ".StabilizationReserve");
        a.vault = _tryAddr(json, ".StakingVault");
        a.desk = _tryAddr(json, ".SwapDesk");
        a.policy = _tryAddr(json, ".PolicyNFT");
        a.mandates = _tryAddr(json, ".MandateManager");
        a.committee = _tryAddr(json, ".OracleCommittee");
    }

    function _tryAddr(string memory json, string memory key) internal view returns (address) {
        try vm.parseJsonAddress(json, key) returns (address r) {
            return r;
        } catch {
            return address(0);
        }
    }

    function _write(Config memory c, Addrs memory a) internal {
        vm.serializeUint(K, "chainId", block.chainid);
        vm.serializeAddress(K, "deployer", c.deployer);
        vm.serializeAddress(K, "relayer", c.relayer);
        vm.serializeAddress(K, "stakingAccount", c.stakingAccount);
        vm.serializeAddress(K, "WPOT", a.wpot);
        vm.serializeAddress(K, "tUSD", a.tusd);
        vm.serializeAddress(K, "InsuranceFund", a.insurance);
        vm.serializeAddress(K, "StabilizationReserve", a.reserve);
        vm.serializeAddress(K, "StakingVault", a.vault);
        vm.serializeAddress(K, "SwapDesk", a.desk);
        vm.serializeAddress(K, "PolicyNFT", a.policy);
        vm.serializeAddress(K, "MandateManager", a.mandates);
        // The LAST serialize call returns the full accumulated JSON.
        string memory json = vm.serializeAddress(K, "OracleCommittee", a.committee);
        vm.createDir("./deployments", true);
        vm.writeJson(json, _path());
    }
}
