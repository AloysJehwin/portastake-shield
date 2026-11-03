// x402 client: calls the paid API, signs the xUSD payment when it answers 402, and retries.
//
//   cd relayer && PAYER_KEY=0x... node x402/client.mjs [url]
//
// The payer only signs an EIP-3009 authorization: it needs xUSD but no tPOT for gas.
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { portaldot, RPC, NETWORK, XUSD, xusdAbi, API_URL } from './config.mjs';

const url = process.argv[2] ?? `${API_URL}/api/vault-stats`;
const account = privateKeyToAccount((await import('./config.mjs')).requireKey('PAYER_KEY'));
const pub = createPublicClient({ chain: portaldot, transport: http(RPC) });

const bal = await pub.readContract({ address: XUSD, abi: xusdAbi, functionName: 'balanceOf', args: [account.address] });
if (bal === 0n) {
  console.error(`payer ${account.address} holds no xUSD. Fund it first, e.g. from a funded key:`);
  console.error(`  cast send ${XUSD} 'faucet(uint256)' 10000000 …  then  cast send ${XUSD} 'transfer(address,uint256)' ${account.address} 10000000 …`);
  process.exit(1);
}
const before = await pub.readContract({ address: XUSD, abi: xusdAbi, functionName: 'balanceOf', args: [account.address] });

// 1) show the raw 402 a plain fetch gets
const raw = await fetch(url);
console.log(`plain GET → ${raw.status} ${raw.statusText}`);

// 2) pay and fetch
// Spend controls: only xUSD on Portaldot is allowed, at most MAX_PAY (default 1 xUSD) per request.
const MAX_PAY = process.env.MAX_PAY ?? '1000000';
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: XUSD, maxAmountPerPayment: MAX_PAY }] },
});
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch(url);
console.log(`paid GET  → ${res.status}`);
console.log(await res.json());

const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE');
if (header) console.log('settlement:', decodePaymentResponseHeader(header));

const after = await pub.readContract({ address: XUSD, abi: xusdAbi, functionName: 'balanceOf', args: [account.address] });
console.log(`payer xUSD ${Number(before) / 1e6} → ${Number(after) / 1e6}`);
