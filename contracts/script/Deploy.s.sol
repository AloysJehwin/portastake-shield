// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {WPOT} from "../src/WPOT.sol";
import {MockStable} from "../src/MockStable.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {InsuranceFund, StabilizationReserve} from "../src/WpotBuckets.sol";
import {PolicyNFT} from "../src/PolicyNFT.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {MandateManager} from "../src/MandateManager.sol";
import {OracleCommittee} from "../src/OracleCommittee.sol";

/// @notice Deploys and wires the full PortaStake Shield contract set.
///
/// Env:
///   PRIVATE_KEY      deployer key (required)
///   RELAYER          relayer EVM address           (default: deployer)
///   STAKING_ACCOUNT  H160 of the relayer's mapped SS58 stash, receives swept POT (default: RELAYER)
///   TREASURY         overflow yield sink           (default: deployer)
///   ATTESTER         first OracleCommittee member  (default: deployer; threshold 1)
///   POT_PRICE        USD per POT, 1e18             (default: 0.5e18)
///   SEED_POT         dead-shares seed deposit      (default: 1 tPOT)
///   DESK_POT         SwapDesk POT inventory        (default: 50 tPOT)
///   DESK_USD         SwapDesk tUSD inventory       (default: 100,000 tUSD)
///
/// forge script script/Deploy.s.sol --rpc-url portaldot --broadcast --legacy --slow
contract Deploy is Script {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

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

    struct Deployed {
        WPOT wpot;
        MockStable usd;
        PriceOracle oracle;
        InsuranceFund insurance;
        StabilizationReserve reserve;
        PolicyNFT policy;
        StakingVault vault;
        SwapDesk desk;
        MandateManager mandates;
        OracleCommittee committee;
    }

    function run() external returns (Deployed memory d) {
        Config memory c = _config();
        vm.startBroadcast(c.pk);
        d = _deploy(c);
        _wire(c, d);
        _seed(c, d);
        vm.stopBroadcast();
        _write(c, d);
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

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d.wpot = new WPOT();
        d.usd = new MockStable(c.deployer);
        d.oracle = new PriceOracle(c.deployer, 1 days);
        d.insurance = new InsuranceFund(d.wpot);
        d.reserve = new StabilizationReserve(d.wpot);
        d.policy = new PolicyNFT(c.deployer);
        d.vault = new StakingVault(d.wpot, d.insurance, d.reserve, d.policy, c.deployer, c.treasury, c.stakingAccount);
        d.desk = new SwapDesk(d.usd, IERC4626(address(d.vault)), d.oracle, c.deployer);
        d.mandates = new MandateManager(d.usd, IERC4626(address(d.vault)), d.desk, c.deployer);
        d.committee = new OracleCommittee(d.vault, c.deployer);
    }

    function _wire(Config memory c, Deployed memory d) internal {
        d.insurance.setVault(address(d.vault));
        d.reserve.setVault(address(d.vault));
        d.policy.grantRole(d.policy.MINTER_ROLE(), address(d.vault));
        d.vault.grantRole(d.vault.RELAYER_ROLE(), c.relayer);
        d.vault.grantRole(d.vault.SLASHER_ROLE(), address(d.committee));
        d.oracle.grantRole(d.oracle.FEEDER_ROLE(), c.relayer);
        d.oracle.setPrice(c.potPrice);
        d.committee.addAttester(c.attester);
        d.committee.setThreshold(1);
    }

    function _seed(Config memory c, Deployed memory d) internal {
        // Dead shares blunt the ERC-4626 first-depositor inflation attack.
        d.vault.depositNative{value: c.seedPot}(DEAD);
        d.usd.mint(address(d.desk), c.deskUsd);
        d.wpot.deposit{value: c.deskPot}();
        d.wpot.transfer(address(d.desk), c.deskPot);
    }

    function _write(Config memory c, Deployed memory d) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", c.deployer);
        vm.serializeAddress(k, "relayer", c.relayer);
        vm.serializeAddress(k, "stakingAccount", c.stakingAccount);
        vm.serializeAddress(k, "WPOT", address(d.wpot));
        vm.serializeAddress(k, "tUSD", address(d.usd));
        vm.serializeAddress(k, "PriceOracle", address(d.oracle));
        vm.serializeAddress(k, "InsuranceFund", address(d.insurance));
        vm.serializeAddress(k, "StabilizationReserve", address(d.reserve));
        vm.serializeAddress(k, "PolicyNFT", address(d.policy));
        vm.serializeAddress(k, "StakingVault", address(d.vault));
        vm.serializeAddress(k, "SwapDesk", address(d.desk));
        vm.serializeAddress(k, "MandateManager", address(d.mandates));
        string memory json = vm.serializeAddress(k, "OracleCommittee", address(d.committee));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("StakingVault  ", address(d.vault));
        console2.log("SwapDesk      ", address(d.desk));
        console2.log("MandateManager", address(d.mandates));
    }
}
