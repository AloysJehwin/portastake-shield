// x402 client, built on @portastake/sdk: calls the paid API, signs the xUSD payment when it answers
// 402, and retries.
//
//   cd relayer && PAYER_KEY=0x... node x402/client.mjs [url]
//
// The payer only signs an EIP-3009 authorization: it needs xUSD but no tPOT for gas.
import { privateKeyToAccount } from 'viem/accounts';
import { createPortaStake } from '@portastake/sdk/chain';
import { createPayingFetch, getOffer, getSettlement, formatXusd } from '@portastake/sdk/x402';
import { RPC, API_URL, requireKey } from './config.mjs';

const url = process.argv[2] ?? `${API_URL}/api/vault-stats`;
const payer = privateKeyToAccount(requireKey('PAYER_KEY'));
const ps = createPortaStake({ rpc: RPC });

const before = (await ps.position(payer.address)).xUSD;
if (before === 0n) {
  console.error(`payer ${payer.address} holds no xUSD. Fund it first, e.g. \`portastake faucet 10 --asset xUSD\` from a funded key, then transfer.`);
  process.exit(1);
}

// 1) what the API asks for
const offer = await getOffer(url);
console.log(offer ? `plain GET → 402: ${formatXusd(offer.amount)} xUSD to ${offer.payTo}` : 'plain GET → free');

// 2) pay and fetch. Spend controls: only xUSD on Portaldot, at most MAX_PAY (default 1 xUSD) per request.
const pay = createPayingFetch({ payer, maxPerRequest: process.env.MAX_PAY ?? '1' });
const res = await pay(url);
console.log(`paid GET  → ${res.status}`);
console.log(await res.json());
const s = getSettlement(res);
if (s) console.log('settlement:', s);

const after = (await ps.position(payer.address)).xUSD;
console.log(`payer xUSD ${formatXusd(before)} → ${formatXusd(after)}`);
