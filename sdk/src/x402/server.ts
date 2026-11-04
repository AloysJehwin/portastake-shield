import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Address } from "viem";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { NETWORK, XUSD_DOMAIN } from "../network.js";
import { XUSD, xusd } from "./index.js";

export type PaidRoute = {
  /** Price per request in whole xUSD ("0.01"), or base units as a bigint. */
  price: string | number | bigint;
  /** Who gets paid. */
  payTo: Address;
  description?: string;
  mimeType?: string;
  /** How long a signed payment stays valid. Default 120 s. */
  maxTimeoutSeconds?: number;
};

export type PaywallOptions = {
  /** URL of an x402 facilitator that verifies and settles payments, e.g. one started with `createFacilitator`. */
  facilitatorUrl?: string;
  /**
   * A facilitator to call directly instead of over HTTP: `createFacilitator(...).client`. Useful in
   * serverless functions, where the paid route and the facilitator run in the same process.
   */
  facilitator?: FacilitatorClient;
  /** Keys are "METHOD /path", as in x402: { "GET /api/report": { price: "0.01", payTo } }. */
  routes: Record<string, PaidRoute>;
  /** Token to charge in. Defaults to xUSD on Portaldot V3. */
  asset?: Address;
  /** EIP-712 domain of `asset`. Defaults to xUSD's. */
  assetDomain?: { name: string; version: string };
  network?: `${string}:${string}`;
  /** Fetch the facilitator's supported schemes when the server starts. Default true. */
  syncOnStart?: boolean;
};

/**
 * Express middleware that charges xUSD per request with x402. Unpaid requests to a listed route
 * get HTTP 402 with the price in the PAYMENT-REQUIRED header. Paid requests are answered, and the
 * payment settles on Portaldot through the facilitator.
 *
 * ```ts
 * app.use(xusdPaywall({
 *   facilitatorUrl: "http://localhost:4020",
 *   routes: { "GET /api/report": { price: "0.01", payTo: "0x…" } },
 * }));
 * ```
 */
export function xusdPaywall(opts: PaywallOptions): RequestHandler {
  const network = opts.network ?? NETWORK;
  const asset = opts.asset ?? XUSD;
  const extra = opts.assetDomain ?? XUSD_DOMAIN;
  const client = opts.facilitator ?? (opts.facilitatorUrl ? new HTTPFacilitatorClient({ url: opts.facilitatorUrl }) : null);
  if (!client) throw new Error("xusdPaywall needs facilitatorUrl or facilitator");
  const server = new x402ResourceServer(client).register(
    network as never,
    new ExactEvmScheme(),
  );
  const routes = Object.fromEntries(
    Object.entries(opts.routes).map(([key, r]) => [
      key,
      {
        accepts: [
          {
            scheme: "exact",
            network,
            payTo: r.payTo,
            price: { asset, amount: (typeof r.price === "bigint" ? r.price : xusd(r.price)).toString(), extra: { ...extra } },
            maxTimeoutSeconds: r.maxTimeoutSeconds ?? 120,
          },
        ],
        description: r.description,
        mimeType: r.mimeType ?? "application/json",
      },
    ]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, server, undefined, undefined, opts.syncOnStart ?? true) as unknown as RequestHandler;
}

/**
 * CORS for browser x402 clients: allows `origins`, lets them send PAYMENT-SIGNATURE and read
 * PAYMENT-REQUIRED and PAYMENT-RESPONSE. Mount it before `xusdPaywall`. Use "*" to allow any origin.
 */
export function x402Cors(origins: string[] | "*"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && (origins === "*" || origins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origins === "*" ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT");
      res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
