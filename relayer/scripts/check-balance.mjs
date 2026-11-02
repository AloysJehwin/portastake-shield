// Print the deployer wallet's tPOT balance on Portaldot V3.
//   cd relayer && node scripts/check-balance.mjs
import { ApiPromise, WsProvider } from '@polkadot/api';

const WS = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const SS58 = process.env.DEPLOYER_SS58 ?? '5D8UG9MXCKDLEehE4N6APmRm1FYXF9sMF6rcf2HsxpZkqpYc';

const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const decimals = api.registry.chainDecimals[0];
const unit = 10 ** decimals;
const { data } = await api.query.system.account(SS58);
const free = Number(BigInt(data.free.toString())) / unit;
const reserved = Number(BigInt(data.reserved.toString())) / unit;
const frozen = Number(BigInt((data.frozen ?? data.feeFrozen ?? 0).toString())) / unit;
const chain = (await api.rpc.system.chain()).toString();

console.log(`chain       ${chain}`);
console.log(`account     ${SS58}`);
console.log(`free        ${free.toFixed(4)} tPOT`);
console.log(`reserved    ${reserved.toFixed(4)} tPOT`);
console.log(`frozen      ${frozen.toFixed(4)} tPOT`);
console.log(`spendable   ${(free - frozen).toFixed(4)} tPOT`);
await api.disconnect();
