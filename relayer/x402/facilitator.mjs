// x402 facilitator for Portaldot V3, built on @portastake/sdk: verifies signed xUSD payments and
// settles them on-chain.
//
//   cd relayer && FACILITATOR_KEY=0x... node x402/facilitator.mjs
//
// Speaks the standard facilitator HTTP API (GET /supported, POST /verify, POST /settle). Settlement
// calls xUSD.transferWithAuthorization with the payer's signature; the facilitator pays the gas and
// never holds the funds.
import { createFacilitator } from '@portastake/sdk/x402/facilitator';
import { NETWORK, RPC, FACILITATOR_PORT, requireKey } from './config.mjs';

const { app, address } = createFacilitator({
  privateKey: requireKey('FACILITATOR_KEY'),
  rpc: RPC,
  onResult: (op, ok, d) =>
    console.log(`${op} ${ok ? 'ok' : 'rejected'}${d.transaction ? ` tx ${d.transaction}` : ''}${ok ? '' : ` (${d.reason ?? 'unknown'})`}`),
});

app.listen(FACILITATOR_PORT, () => {
  console.log(`x402 facilitator ${address} on ${NETWORK} → http://localhost:${FACILITATOR_PORT}`);
});
