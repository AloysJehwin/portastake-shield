# @portastake/sdk

Paid on-chain tools and PortaStake tooling for [Portaldot](https://portaldot.io).

- **`@portastake/sdk/x402`**: charge per run for your tools and APIs in xUSD with [x402](https://github.com/x402-foundation/x402), and pay for them from any wallet. Payers sign; they never pay gas.
- **`@portastake/sdk/chain`**: the PortaStake Shield vault, desk and mandates, a keeper, Portaldot explorer links, and helpers for Portaldot's EVM (pallet-revive).
- **`portastake`**: a CLI over both.

```sh
npm i @portastake/sdk viem
npm i express        # only for the paywall and the facilitator
```

Defaults point at Portaldot V3 testnet (`eip155:420420777`) and its live PortaStake deployment, so nothing needs configuring to start.

## Paid tools (x402)

x402 brings back HTTP `402 Payment Required`. A paid tool answers 402 with a price. The client signs an EIP-3009 xUSD authorization and retries. A facilitator then settles it on Portaldot and pays the gas. Funds go straight from payer to payee: the signature fixes the amount and the recipient, and each authorization works once.

### Charge for a tool

```ts
import express from "express";
import { xusdPaywall, x402Cors } from "@portastake/sdk/x402/server";

const app = express();
app.use(x402Cors(["https://your-app.example"]));          // only if browsers call it
app.use(
  xusdPaywall({
    facilitatorUrl: "http://localhost:4020",
    routes: { "GET /api/report": { price: "0.01", payTo: "0xYourAddress" } },
  }),
);
app.get("/api/report", (_req, res) => res.json({ hello: "paid world" }));
app.listen(4021);
```

### Pay for a tool

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPayingFetch, getOffer, getSettlement } from "@portastake/sdk/x402";

const offer = await getOffer("http://localhost:4021/api/report"); // price, payTo, network; no payment
const pay = createPayingFetch({ payer: privateKeyToAccount(process.env.PAYER_KEY), maxPerRequest: "0.10" });
const res = await pay("http://localhost:4021/api/report");
console.log(await res.json(), getSettlement(res)?.transaction);
```

`payer` can be a viem account or a wallet client, for example a browser wallet from wagmi's `useWalletClient()`. `maxPerRequest` is a hard spend limit: the client refuses to sign anything above it. It also refuses any token other than xUSD.

### Run a facilitator

```ts
import { createFacilitator } from "@portastake/sdk/x402/facilitator";

createFacilitator({ privateKey: process.env.FACILITATOR_KEY }).app.listen(4020);
```

In a serverless function, run the facilitator in the same process instead of as a separate server:

```ts
const { client } = createFacilitator({ privateKey: process.env.FACILITATOR_KEY });
app.use(xusdPaywall({ facilitator: client, routes: { "GET /api/tools/report": { price: "0.01", payTo } } }));
```

The standalone facilitator serves the standard facilitator API (`GET /supported`, `POST /verify`, `POST /settle`), so any x402 server can use it. Give it a dedicated key with a small tPOT balance: it pays gas for each settlement, about 4 tPOT on Portaldot V3.

## On-chain tooling

```ts
import { createWalletClient, http, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPortaStake, mandates, runKeeperPass, portaldot, Direction, Trigger, WEEK } from "@portastake/sdk/chain";

const ps = createPortaStake(); // read-only, public RPC
await ps.stats();              // TVL, exchange rate, target and effective rate, safety funds
await ps.desk();               // price, fee, and whether the price is fresh
await ps.position("0x…");      // tPOT, stPOT (and its value), tUSD, xUSD

const me = createPortaStake({
  walletClient: createWalletClient({ account: privateKeyToAccount(KEY), chain: portaldot, transport: http() }),
});
await me.depositNative(parseEther("10"));                          // stake tPOT
await me.depositStable(parseUnits("5", 6), { asset: "xUSD" });     // save xUSD as stPOT
const tx = await me.withdrawToStable(parseEther("2"), { asset: "xUSD", slippageBps: 50 });
console.log(tx.explorerUrl);

await mandates(me).create({ dir: Direction.SAVE, trig: Trigger.RECURRING, amount: parseUnits("20", 6), interval: WEEK });
await runKeeperPass(me, { log: console.log });                     // run every due mandate
```

Writes handle Portaldot's EVM details: they send legacy transactions with node-estimated gas, and approve tokens when an allowance is missing. Each returns `{ hash, blockNumber, status, explorerUrl }`.

| Helper | What it does |
|---|---|
| `accountUrl(addr)`, `blockUrl(n)`, `txUrl(client, hash)` | Links into the Portaldot explorer. A transaction links to the block it landed in, because the explorer indexes Substrate blocks. |
| `h160ToSs58(addr)` | The Substrate account pallet-revive gives an EVM address (`h160 ++ 0xEE×12`), in SS58. |
| `estimateDeployCost(bytes)`, `initcodeLength(artifact)` | Approximate tPOT to deploy a contract: about 0.0589 tPOT per byte of init code, plus 20%. |
| `upfrontCost(client, call)`, `balanceReport(client, addr)` | Portaldot charges the quoted gas limit × gas price up front, so check that an account can afford a call before sending it. |
| `getAddresses(chainId, overrides)` | PortaStake addresses. Pass overrides for your own deployment. |
| ABIs | `StakingVaultAbi`, `SwapDeskAbi`, `MandateManagerAbi`, `X402DollarAbi`, `XusdGatewayAbi`, and others. |

## CLI

```sh
npx portastake stats
npx portastake price
npx portastake position 0x2f1B…510E
portastake explorer 0x2f1B…510E                  # explorer link + SS58
portastake deploy-cost out/MyContract.sol/MyContract.json
portastake offer https://api.example/report      # what an x402 tool charges

PRIVATE_KEY=0x… portastake save 5 --asset xUSD
PRIVATE_KEY=0x… portastake keeper --loop 60
FACILITATOR_KEY=0x… portastake facilitator
PAY_TO=0x… portastake paywall-demo               # sample paid tool at :4021
PAYER_KEY=0x… portastake pay http://localhost:4021/api/vault-stats --max 0.05
```

Keys are only read from environment variables. Add `--json` to any command for machine-readable output, and `--rpc <url>` to use another endpoint.

## Network

| | Portaldot V3 testnet |
|---|---|
| Chain id | 420420777 (`eip155:420420777`) |
| RPC | https://test-evm-rpc-v3.portaldot.dev |
| Explorer | https://scanner-testnet-v3.portaldot.dev |
| xUSD | `0xdf02a2725479c7d3dae955716391ff9df633a3f0` |
| StakingVault (stPOT) | `0xa644743487409df1056445c742f5cdbfe156f417` |
| SwapDesk | `0xc3439de80429265793325a6b662232043ced04b6` |
| MandateManager | `0x5bea4b9df4079612582a5cdc5a8d88a9c40ef339` |
| XusdGateway | `0x112553f779e552e4dae037fc2fd6908fa56e0758` |

Test xUSD and tUSD come from each token's `faucet` (`portastake faucet 10 --asset xUSD`).

## License

MIT
