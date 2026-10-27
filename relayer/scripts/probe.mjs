// Read-only probe of the PortaldotV3 testnet. Prints the facts the contract design depends on:
// pallets, staking timings, live staking yield, revive EVM settings, and test stablecoins.
//
//   cd relayer && npm install && npm run probe
import { ApiPromise, WsProvider } from '@polkadot/api';

const WS = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';

const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const decimals = api.registry.chainDecimals[0];
const unit = 10 ** decimals;

console.log('chain     ', (await api.rpc.system.chain()).toString(),
  { symbol: api.registry.chainTokens[0], decimals, ss58: api.registry.chainSS58 });
console.log('pallets   ', Object.keys(api.tx).sort().join(', '));

const s = api.consts.staking;
const epoch = api.consts.babe.epochDuration.toNumber();
const blockMs = api.consts.babe.expectedBlockTime.toNumber();
const eraSecs = s.sessionsPerEra.toNumber() * epoch * blockMs / 1000;
console.log('era       ', `${eraSecs / 3600}h`,
  '| bonding', `${s.bondingDuration.toNumber()} eras (${(s.bondingDuration.toNumber() * eraSecs / 86400).toFixed(0)} days)`,
  '| slash defer', `${s.slashDeferDuration.toNumber()} eras`);

const era = (await api.query.staking.activeEra()).unwrap().index.toNumber();
const erasPerYear = 365 * 86400 / eraSecs;
for (let e = era - 3; e < era; e++) {
  const reward = (await api.query.staking.erasValidatorReward(e)).unwrapOr(0n).toString();
  const stake = (await api.query.staking.erasTotalStake(e)).toString();
  const apy = Number(reward) / Number(stake) * erasPerYear * 100;
  console.log(`era ${e}    gross staking APY ≈ ${apy.toFixed(2)}%`);
}
console.log('validators', (await api.query.session.validators()).length,
  '| nominators', (await api.query.staking.counterForNominators()).toString(),
  '| pool minJoinBond', Number((await api.query.nominationPools.minJoinBond()).toString()) / unit);

const r = api.consts.revive;
console.log('revive    ', {
  chainId: r.chainId.toString(),
  allowEVMBytecode: r.allowEVMBytecode.toString(),
  autoMap: r.autoMap.toString(),
  nativeToEthRatio: r.nativeToEthRatio.toString(),
  depositPerByte: Number(r.depositPerByte.toString()) / unit,
  depositPerItem: Number(r.depositPerItem.toString()) / unit,
});

const assets = await api.query.assets.metadata.entries();
const stables = assets
  .map(([k, v]) => ({ id: k.args[0].toString(), symbol: v.symbol.toHuman(), decimals: v.decimals.toNumber() }))
  .filter((a) => /usd/i.test(a.symbol));
console.log('stables   ', stables);
const pools = await api.query.assetConversion.pools.entries();
console.log('dex pools ', pools.map(([k]) => JSON.stringify(k.toHuman()[0])).join(' '));

await api.disconnect();
