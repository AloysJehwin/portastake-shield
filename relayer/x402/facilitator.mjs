// x402 facilitator for Portaldot V3: verifies signed xUSD payments and settles them on-chain.
//
//   cd relayer && FACILITATOR_KEY=0x... node x402/facilitator.mjs
//
// Speaks the standard facilitator HTTP API (GET /supported, POST /verify, POST /settle), so any
// x402 resource server can point at it. Settlement calls xUSD.transferWithAuthorization with the
// payer's signature; the facilitator pays the gas and never holds the funds — the token moves
// straight from payer to `payTo`, and the signature fixes the amount and recipient.
import express from 'express';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { portaldot, RPC, NETWORK, FACILITATOR_PORT, requireKey } from './config.mjs';

const account = privateKeyToAccount(requireKey('FACILITATOR_KEY'));
const pub = createPublicClient({ chain: portaldot, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: portaldot, transport: http(RPC) });

// Portaldot's revive EVM takes legacy (type 0) transactions, and folds its storage deposit into
// gas, so let the node estimate gas for every settlement.
const signer = toFacilitatorEvmSigner({
  address: account.address,
  readContract: (a) => pub.readContract(a),
  verifyTypedData: (a) => pub.verifyTypedData(a),
  getCode: (a) => pub.getCode(a),
  writeContract: (a) => wallet.writeContract({ ...a, type: 'legacy' }),
  sendTransaction: (a) => wallet.sendTransaction({ ...a, type: 'legacy' }),
  waitForTransactionReceipt: (a) => pub.waitForTransactionReceipt({ timeout: 120_000, ...a }),
}, { confirmationTimeoutMs: 120_000 });

const facilitator = registerExactEvmScheme(new x402Facilitator(), { signer, networks: NETWORK });

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));

for (const op of ['verify', 'settle']) {
  app.post(`/${op}`, async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) return res.status(400).json({ error: 'paymentPayload and paymentRequirements required' });
    try {
      const out = await facilitator[op](paymentPayload, paymentRequirements);
      const ok = op === 'verify' ? out.isValid : out.success;
      console.log(`${op} ${ok ? 'ok' : 'rejected'}${out.transaction ? ` tx ${out.transaction}` : ''}${ok ? '' : ` (${out.invalidReason ?? out.errorReason ?? 'unknown'})`}`);
      res.json(out);
    } catch (e) {
      console.error(`${op} error:`, e?.message ?? e);
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
}

app.listen(FACILITATOR_PORT, () => {
  console.log(`x402 facilitator ${account.address} on ${NETWORK} → http://localhost:${FACILITATOR_PORT}`);
});
