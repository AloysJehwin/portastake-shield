# Testnet deployment

Everything below is on Portaldot V3 testnet. Each hash was checked against `eth_getTransactionReceipt` on the public RPC and returned status `0x1`. To check one yourself:

```sh
curl -s https://test-evm-rpc-v3.portaldot.dev -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<hash>"]}'
```

| | |
|---|---|
| Chain ID (EVM) | `420420777` |
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` |
| Substrate node | `wss://test-node-v3.portaldot.dev` |
| Node console | https://node-console.portaldot.dev/ |
| Explorer | https://scanner-testnet-v3.portaldot.dev |
| Deployer, relayer and bridge wallet | `0x2f1B730cCa78f039072Caa56B3E3Ee64319F510E` |
| Live app | https://portastake-shield.vercel.app |

The explorer indexes Substrate blocks and extrinsics rather than EVM hashes, so the links open the block that holds each transaction.

## Contracts

| Contract | Address | Creation transaction | Block |
|---|---|---|---|
| WPOT | `0x1d0c17a0ee1dcf15bd05a45ae789058a0586aa68` | `0x94bbf5d77c6fb05afeae877a2514b31096cecfdbcc4420d93a768fbbab94d3cb` | [295328](https://scanner-testnet-v3.portaldot.dev/#/blocks/295328) |
| InsuranceFund | `0xc38070af7dd6fb4c4ae1c72b892dd662f6184cf6` | `0x0ea1c6a8ed93ee59faf0d951c1e625d025ad7b9f48bf8dc629f80ef066509653` | [295329](https://scanner-testnet-v3.portaldot.dev/#/blocks/295329) |
| StabilizationReserve | `0x655a38cf109b933a0b9a7ac5cf9b3afd4130c2fe` | `0x9651c045fd8aa2ad0d484d9d00eb8fc7984402ffbe0ba754296c1accf042858f` | [295330](https://scanner-testnet-v3.portaldot.dev/#/blocks/295330) |
| StakingVault | `0xa644743487409df1056445c742f5cdbfe156f417` | `0xf7c6f1bea053ba939eb5946bef47c78011629c97a27d9681ab91ad97138de096` | [295331](https://scanner-testnet-v3.portaldot.dev/#/blocks/295331) |
| tUSD | `0xca97a63d609d3efcd510387af4891d765740861e` | `0xb3c750851eb2e311203591df941496cdc4f7b28f42d6bfb39adfc768943b3571` | [295336](https://scanner-testnet-v3.portaldot.dev/#/blocks/295336) |
| SwapDesk | `0xc3439de80429265793325a6b662232043ced04b6` | `0xa78feae67405c5406377be47944a69fc3582232853afafa81ebe035d309ecd33` | [295337](https://scanner-testnet-v3.portaldot.dev/#/blocks/295337) |
| OracleCommittee | `0xb71a998bbd739821ea02e4ceee75ebb5ba5b9d20` | `0xa2db1e4c6e38d0e5f427eac5db9219ee07f3451f4f7381a9a86255479813adca` | [295342](https://scanner-testnet-v3.portaldot.dev/#/blocks/295342) |
| PolicyNFT | `0xb902168a3314284ddd76bc42b8cb27b49edd2c39` | `0xd5e72beeed2b3e4c0f1d28700edae8b1e1ffcf2f4ea84ca99df9f8aaec63a03a` | [308895](https://scanner-testnet-v3.portaldot.dev/#/blocks/308895) |
| MandateManager | `0x5bea4b9df4079612582a5cdc5a8d88a9c40ef339` | `0x03ac319059d5a6b35a0d9d044915320bee9b44fdaa94c1a5ce65931123ca277e` | [308897](https://scanner-testnet-v3.portaldot.dev/#/blocks/308897) |
| xUSD | `0xdf02a2725479c7d3dae955716391ff9df633a3f0` | `0xced411e4585ffecfaa65b4133a02691187061a9c91880fafa44ff716dc2dec38` | [309312](https://scanner-testnet-v3.portaldot.dev/#/blocks/309312) |
| XusdGateway | `0x112553f779e552e4dae037fc2fd6908fa56e0758` | `0xd328ebeac7901916349fe96e6ed777a33b2c33f878947a0032b652dbdc84c3c2` | [309722](https://scanner-testnet-v3.portaldot.dev/#/blocks/309722) |

`RateEngine` is a library compiled into `StakingVault`, so it has no address of its own. Addresses are also in [`contracts/deployments/420420777.json`](../contracts/deployments/420420777.json).

## Example transactions

| Flow | Transaction | Block |
|---|---|---|
| Deposit tPOT, mint stPOT | `0x94efdbc317d334337061ddb6d5616728a127cf0d17d09a7d5159daa07834df98` | [295335](https://scanner-testnet-v3.portaldot.dev/#/blocks/295335) |
| Deposit stablecoin through SwapDesk | `0x78dec4b353ccc740b80cf2d0a975bd112b0fed5c5c9392bf3cc8055b9343cbd3` | [295372](https://scanner-testnet-v3.portaldot.dev/#/blocks/295372) |
| Mint soulbound PolicyNFT on first deposit | `0xae175337fd152357e6f92d9d93771d04cb1a45078ace94e08d701d00af1e2dc8` | [308901](https://scanner-testnet-v3.portaldot.dev/#/blocks/308901) |
| Withdraw stPOT to tUSD through SwapDesk | `0x68a23ea64795bc65cc1fe24b251949a48d6f89c1234a0acb73656cd2ef5dda62` | [323597](https://scanner-testnet-v3.portaldot.dev/#/blocks/323597) |
| Split a reported reward (RateEngine) | `0xab1b5be8bdf2592e15fac1779297ee748e57d701a569eb76c4f68964d8c4b88e` | [295610](https://scanner-testnet-v3.portaldot.dev/#/blocks/295610) |
| Finalize a test slash and pay it from InsuranceFund | `0x50c810e06eef7108c2b8752aec426c7a4ad63b99f6fe34627a94d9cd3e89e68a` | [295389](https://scanner-testnet-v3.portaldot.dev/#/blocks/295389) |
| Create a mandate | `0x6603fdce07a17006c6cf90a74a4764fe98f4317eb7a28b17094a6098174a4621` | [308907](https://scanner-testnet-v3.portaldot.dev/#/blocks/308907) |
| Execute a mandate | `0xcc2bea03414c4ffb065d8e07dc4cdc3b62c3d3c805d87bc49dbb183edaeaa6fd` | [308909](https://scanner-testnet-v3.portaldot.dev/#/blocks/308909) |
| Pause a mandate | `0x9f4f244b5de8ee89f495ac1012b77b83a28df61de1baa86936fa8a7f04856b5d` | [323580](https://scanner-testnet-v3.portaldot.dev/#/blocks/323580) |
| Settle an x402 payment (EIP-3009, xUSD) | `0x74ed5fbf9a50a431c7601b7f9edf270b23a39fdfd424564fbdab43de2df613b6` | [323163](https://scanner-testnet-v3.portaldot.dev/#/blocks/323163) |
| Deposit xUSD into savings (XusdGateway) | `0x0ce5f747e451a3ca3f189976313956650a319bba714f0137f6c8a708042e1461` | [309732](https://scanner-testnet-v3.portaldot.dev/#/blocks/309732) |
| Withdraw savings to xUSD (XusdGateway) | `0x3f09e0d98b66d53dc5e9ff8c3de45efae440064c20cfa65dd67ecd8dd594e0e9` | [309740](https://scanner-testnet-v3.portaldot.dev/#/blocks/309740) |
| Update the SwapDesk price | `0xa6bcd010c34931df2fb5ee556d1cb56400e405e8c0e047b51a84f27d13844e0e` | [309709](https://scanner-testnet-v3.portaldot.dev/#/blocks/309709) |

## What these transactions do and don't show

- **Rewards:** the reward split is one reward reported by hand to prove the 8% accounting. The staking relayer isn't running on testnet yet, so the vault's POT isn't bonded through Substrate `staking`.
- **Slashing:** testnet has 2 validators, so a real slash is unlikely. The payout above came from a signed test event, with the committee set to one attester.
- **Bridge:** the relayer wallet holds each side, so this version is custodial. Portaldot and Base Sepolia hold liquidity today; the other chains need USDC in that wallet before transfers can be paid out on them.
