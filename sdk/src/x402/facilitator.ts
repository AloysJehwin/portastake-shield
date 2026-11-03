import express, { type Express } from "express";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { DEFAULT_RPC, NETWORK, portaldotChain } from "../network.js";

export type FacilitatorOptions = {
  /** Key of the account that submits settlements and pays their gas. Keep its balance small. */
  privateKey: Hex;
  rpc?: string;
  network?: `${string}:${string}`;
  /** Called after each verify or settle, for logging. */
  onResult?: (op: "verify" | "settle", ok: boolean, detail: { transaction?: string; reason?: string }) => void;
};

/**
 * An x402 facilitator for Portaldot as an Express app, speaking the standard HTTP API:
 * `GET /supported`, `POST /verify`, `POST /settle`.
 *
 * Settlement calls the token's EIP-3009 `transferWithAuthorization` with the payer's signature.
 * The facilitator pays the gas but never holds the funds: tokens move straight from payer to
 * `payTo`, and the signature fixes amount and recipient.
 *
 * ```ts
 * createFacilitator({ privateKey: process.env.FACILITATOR_KEY }).app.listen(4020);
 * ```
 */
export function createFacilitator(opts: FacilitatorOptions): { app: Express; address: `0x${string}`; facilitator: x402Facilitator } {
  const rpc = opts.rpc ?? DEFAULT_RPC;
  const chain = portaldotChain(rpc);
  const account = privateKeyToAccount(opts.privateKey);
  const pub = createPublicClient({ chain, transport: http(rpc, { retryCount: 2 }) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 2 }) });

  // Portaldot's EVM takes legacy (type 0) transactions and folds its storage deposit into gas,
  // so every settlement is a legacy transaction with node-estimated gas.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const signer = toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (a: any) => pub.readContract(a),
      verifyTypedData: (a: any) => pub.verifyTypedData(a),
      getCode: (a: any) => pub.getCode(a),
      writeContract: (a: any) => wallet.writeContract({ ...a, type: "legacy" }),
      sendTransaction: (a: any) => wallet.sendTransaction({ ...a, type: "legacy" }),
      waitForTransactionReceipt: (a: any) => pub.waitForTransactionReceipt({ timeout: 120_000, ...a }),
    } as any,
    { confirmationTimeoutMs: 120_000 } as any,
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const facilitator = registerExactEvmScheme(new x402Facilitator(), { signer, networks: (opts.network ?? NETWORK) as never });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  for (const op of ["verify", "settle"] as const) {
    app.post(`/${op}`, async (req, res) => {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      if (!paymentPayload || !paymentRequirements) {
        res.status(400).json({ error: "paymentPayload and paymentRequirements required" });
        return;
      }
      try {
        const out = (await facilitator[op](paymentPayload, paymentRequirements)) as {
          isValid?: boolean;
          success?: boolean;
          transaction?: string;
          invalidReason?: string;
          errorReason?: string;
        };
        const ok = op === "verify" ? !!out.isValid : !!out.success;
        opts.onResult?.(op, ok, { transaction: out.transaction, reason: out.invalidReason ?? out.errorReason });
        res.json(out);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        opts.onResult?.(op, false, { reason: message });
        res.status(500).json({ error: message });
      }
    });
  }

  return { app, address: account.address, facilitator };
}
