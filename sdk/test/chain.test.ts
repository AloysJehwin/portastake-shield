import { describe, expect, it } from "vitest";
import { h160ToSs58, accountUrl, blockUrl, estimateDeployCost, initcodeLength, getAddresses, isDeployed, CHAIN_ID, NETWORK, createPortaStake } from "../src/chain/index.js";

const DEPLOYER = "0x2f1B730cCa78f039072Caa56B3E3Ee64319F510E";

describe("explorer", () => {
  it("maps an EVM address to its pallet-revive SS58 account", () => {
    // Known pair: the deployer's Substrate account, as the Portaldot explorer shows it.
    expect(h160ToSs58(DEPLOYER)).toBe("5D8UG9MXCKDLEehE4N6APmRm1FYXF9sMF6rcf2HsxpZkqpYc");
  });
  it("builds block and account links", () => {
    expect(blockUrl(123n)).toBe("https://scanner-testnet-v3.portaldot.dev/#/blocks/123");
    expect(accountUrl(DEPLOYER, "https://x")).toBe("https://x/#/accounts/5D8UG9MXCKDLEehE4N6APmRm1FYXF9sMF6rcf2HsxpZkqpYc");
  });
});

describe("network", () => {
  it("knows the Portaldot V3 deployment", () => {
    const a = getAddresses();
    expect(CHAIN_ID).toBe(420420777);
    expect(NETWORK).toBe("eip155:420420777");
    for (const k of ["StakingVault", "SwapDesk", "MandateManager", "xUSD", "XusdGateway"] as const) expect(isDeployed(a[k])).toBe(true);
  });
  it("needs overrides for unknown chains", () => {
    expect(() => getAddresses(31337)).toThrow();
    expect(getAddresses(31337, { StakingVault: DEPLOYER }).StakingVault).toBe(DEPLOYER);
  });
});

describe("deploy cost", () => {
  it("matches what Portaldot V3 charged", () => {
    // PolicyNFT: 1,936 bytes; stage 4 MandateManager: 5,451 bytes; together ~545 tPOT on chain.
    const stage4 = estimateDeployCost(1936) + estimateDeployCost(5451);
    expect(stage4).toBeGreaterThan(545 * 0.9);
    expect(stage4).toBeLessThan(545 * 1.1);
  });
  it("reads init code length from hex or a Foundry artifact", () => {
    expect(initcodeLength("0x6001")).toBe(2);
    expect(initcodeLength({ bytecode: { object: "0x600160" } })).toBe(3);
  });
});

describe.runIf(process.env.LIVE === "1")("live Portaldot reads", () => {
  it("reads vault stats and the desk", async () => {
    const ps = createPortaStake();
    const s = await ps.stats();
    expect(s.totalAssets).toBeGreaterThan(0n);
    const d = await ps.desk();
    expect(d.price).toBeGreaterThan(0n);
  }, 30_000);
});
