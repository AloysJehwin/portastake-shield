import { parseUnits, formatUnits, type Account, type Address, type WalletClient } from "viem";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddresses, NETWORK, XUSD_DECIMALS, XUSD_DOMAIN, CHAIN_ID } from "../network.js";

export { NETWORK, XUSD_DOMAIN, XUSD_DECIMALS };
export { decodePaymentRequiredHeader, decodePaymentResponseHeader };

/** The xUSD token address on Portaldot V3. */
export const XUSD: Address = getAddresses(CHAIN_ID).xUSD;

/** "0.01" xUSD → 10000 base units. Numbers are taken as whole xUSD. */
export function xusd(amount: string | number): bigint {
  return parseUnits(typeof amount === "number" ? amount.toString() : amount, XUSD_DECIMALS);
}

/** 10000 base units → "0.01". */
export function formatXusd(units: bigint | string): string {
  return formatUnits(BigInt(units), XUSD_DECIMALS);
}

/** Anything that can sign EIP-712: a viem local account, or a wallet client with an account. */
export type PayerSigner =
  | Account
  | WalletClient
  | { address: Address; signTypedData: (msg: never) => Promise<`0x${string}`> };

function toSigner(s: PayerSigner): { address: Address; signTypedData: (msg: unknown) => Promise<`0x${string}`> } {
  // A viem account (local or JSON-RPC) or a hand-made signer: it carries its own address.
  if ("address" in s && typeof (s as { signTypedData?: unknown }).signTypedData === "function") {
    const a = s as { address: Address; signTypedData: (msg: never) => Promise<`0x${string}`> };
    return { address: a.address, signTypedData: (msg) => a.signTypedData(msg as never) };
  }
  // A wallet client: sign with its account.
  const wc = s as WalletClient;
  const account = wc.account;
  if (!account || typeof wc.signTypedData !== "function") {
    throw new Error("payer must be a viem account with signTypedData, or a wallet client with an account");
  }
  return {
    address: account.address,
    signTypedData: (msg) => wc.signTypedData({ ...(msg as Parameters<WalletClient["signTypedData"]>[0]), account }),
  };
}

export type PayingFetchOptions = {
  /** Who pays. Signs EIP-3009 authorizations only; it never sends a transaction or pays gas. */
  payer: PayerSigner;
  /** Never sign more than this per request. Whole xUSD as a string ("1"), or base units as a bigint. Default 1 xUSD. */
  maxPerRequest?: string | bigint;
  /** Token to pay with. Defaults to xUSD on Portaldot V3. */
  asset?: Address;
  /** CAIP-2 network. Defaults to Portaldot V3. */
  network?: `${string}:${string}`;
  /** Base fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
};

/**
 * A `fetch` that pays for x402 APIs in xUSD. When an API answers 402, it signs a payment within
 * the spend limit and retries; every other response passes straight through.
 *
 * ```ts
 * const pay = createPayingFetch({ payer: privateKeyToAccount(key), maxPerRequest: "0.10" });
 * const res = await pay("https://api.example.com/report");
 * ```
 */
export function createPayingFetch(opts: PayingFetchOptions): typeof fetch {
  const network = opts.network ?? NETWORK;
  const asset = opts.asset ?? XUSD;
  const max = typeof opts.maxPerRequest === "bigint" ? opts.maxPerRequest : xusd(opts.maxPerRequest ?? "1");
  const client = x402Client.fromConfig({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schemes: [{ network: network as any, client: new ExactEvmScheme(toSigner(opts.payer) as any) }],
    spendControls: { allowedAssets: [{ network: network as never, asset, maxAmountPerPayment: max.toString() }] },
  });
  return wrapFetchWithPayment(opts.fetch ?? fetch, client) as typeof fetch;
}

/** What an x402 API asks to be paid, read from its 402 answer. */
export type Offer = {
  url: string;
  amount: bigint;
  asset: Address;
  payTo: Address;
  network: string;
  scheme: string;
  description?: string;
  maxTimeoutSeconds?: number;
};

/**
 * Ask an x402 API what it charges, without paying: sends a plain request and decodes the
 * PAYMENT-REQUIRED header of the 402. Returns null if the resource is free.
 */
export async function getOffer(url: string, init?: RequestInit & { network?: string; fetch?: typeof fetch }): Promise<Offer | null> {
  const f = init?.fetch ?? fetch;
  const r = await f(url, init);
  if (r.status !== 402) return null;
  const header = r.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("402 without a PAYMENT-REQUIRED header (not an x402 v2 API?)");
  const req = decodePaymentRequiredHeader(header);
  const want = init?.network ?? NETWORK;
  const a = req.accepts.find((x) => x.network === want) ?? req.accepts[0];
  if (!a) throw new Error("402 lists no accepted payments");
  return {
    url,
    amount: BigInt(a.amount),
    asset: a.asset as Address,
    payTo: a.payTo as Address,
    network: a.network,
    scheme: a.scheme,
    description: req.resource?.description,
    maxTimeoutSeconds: a.maxTimeoutSeconds,
  };
}

/** Settlement details from a paid response's PAYMENT-RESPONSE header, or null if there is none. */
export function getSettlement(res: Response): { transaction?: string; payer?: string; network?: string; success?: boolean } | null {
  const h = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  return h ? (decodePaymentResponseHeader(h) as ReturnType<typeof getSettlement>) : null;
}

/** Fetch `url`, paying if asked, and return the parsed JSON body with the settlement. */
export async function payAndFetchJson<T = unknown>(url: string, opts: PayingFetchOptions, init?: RequestInit) {
  const res = await createPayingFetch(opts)(url, init);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { data: (await res.json()) as T, settlement: getSettlement(res), status: res.status };
}
