// On-chain tools: small paid endpoints that read PortaStake on Portaldot and charge per run in xUSD
// with x402. Served by Vercel functions in production (api/tools/[name].ts) and by
// scripts/tools-dev.ts locally. The facilitator runs in the same process and settles each payment.
import express, { type Express, type RequestHandler } from "express";
import { formatEther, formatUnits, isAddress, type Address, type Hex } from "viem";
import { createPortaStake, mandates, h160ToSs58, accountUrl, CHAIN_ID } from "@portastake/sdk/chain";
import { xusdPaywall } from "@portastake/sdk/x402/server";
import { createFacilitator } from "@portastake/sdk/x402/facilitator";
import deployments from "../../src/deployments/420420777.json" with { type: "json" };

export type ToolParam = { name: string; label: string; placeholder?: string; fromWallet?: boolean };
export type Tool = { id: string; name: string; summary: string; price: string; params?: ToolParam[] };

export const TOOLS: Tool[] = [
  {
    id: "vault",
    name: "Vault health",
    summary: "TVL, stPOT exchange rate, target and effective rate, liquidity, and both safety funds.",
    price: "0.01",
  },
  {
    id: "desk",
    name: "Desk price check",
    summary: "The tPOT/USD price, fee and freshness, with a $10 deposit quote.",
    price: "0.01",
  },
  {
    id: "wallet",
    name: "Wallet report",
    summary: "Any address's tPOT, stPOT and its value, tUSD and xUSD, with its Portaldot account.",
    price: "0.01",
    params: [{ name: "address", label: "Address", placeholder: "0x…", fromWallet: true }],
  },
  {
    id: "mandates",
    name: "Mandate scan",
    summary: "How many automation mandates exist and which are due to run now.",
    price: "0.01",
  },
];

const pot = (v: bigint) => Number(formatEther(v));
const usd = (v: bigint) => Number(formatUnits(v, 6));
const pct = (bps: bigint) => Number(bps) / 100;

export function createToolsApp(env: Record<string, string | undefined> = process.env): Express {
  const ps = createPortaStake({ rpc: env.RPC });
  const payTo = (env.PAY_TO ?? deployments.deployer) as Address;
  const key = env.FACILITATOR_KEY;

  const app = express();
  app.disable("x-powered-by");

  // Free: the catalog, and whether paid runs can settle right now.
  app.get("/api/tools/catalog", (_req, res) => {
    res.json({ tools: TOOLS, payTo, chainId: CHAIN_ID, live: !!key });
  });

  // Free: the current price only. The paid desk tool adds the fee and a deposit quote.
  app.get("/api/tools/price", async (_req, res) => {
    try {
      const d = await ps.desk();
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
      res.json({
        pair: "tPOT/USD",
        usdPerPot: pot(d.price),
        fresh: d.fresh,
        updatedAt: new Date(Number(d.updatedAt) * 1000).toISOString(),
        maxAgeHours: Number(d.maxAge) / 3600,
        desk: ps.addresses.SwapDesk,
        at: new Date().toISOString(),
      });
    } catch {
      res.status(502).json({ error: "Portaldot didn't answer; try again shortly" });
    }
  });

  if (!key) {
    app.use("/api/tools", (_req, res) => {
      res.status(503).json({ error: "Tools are not configured on this deployment (FACILITATOR_KEY missing)" });
    });
    return app;
  }

  // Check inputs before asking for payment, so nobody pays for a request that can only fail.
  const needAddress: RequestHandler = (req, res, next) => {
    const a = String(req.query.address ?? "");
    if (!isAddress(a)) {
      res.status(400).json({ error: "address must be a 0x address" });
      return;
    }
    next();
  };
  app.get("/api/tools/wallet", needAddress);

  const { client } = createFacilitator({ privateKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex, rpc: env.RPC });
  app.use(
    xusdPaywall({
      facilitator: client,
      routes: Object.fromEntries(
        TOOLS.map((t) => [`GET /api/tools/${t.id}`, { price: t.price, payTo, description: `${t.name}: ${t.summary}` }]),
      ),
    }),
  );

  app.get("/api/tools/vault", async (_req, res) => {
    const s = await ps.stats();
    res.json({
      tool: "vault",
      vault: ps.addresses.StakingVault,
      tvlPot: pot(s.totalAssets),
      stPotSupply: pot(s.totalSupply),
      potPerStPot: pot(s.exchangeRate),
      targetRatePct: pct(s.targetRateBps),
      effectiveRatePct: pct(s.effectiveRateBps),
      liquidityPot: pot(s.availableLiquidity),
      insuranceFundPot: pot(s.insuranceBalance),
      stabilizationReservePot: pot(s.reserveBalance),
      at: new Date().toISOString(),
    });
  });

  app.get("/api/tools/desk", async (_req, res) => {
    const d = await ps.desk();
    let quote: { usd: number; pot: number; stPot: number } | { error: string };
    try {
      const q = await ps.quoteDeposit(10_000_000n);
      quote = { usd: 10, pot: pot(q.pot), stPot: pot(q.shares) };
    } catch {
      quote = { error: "no quote while the price is stale" };
    }
    res.json({
      tool: "desk",
      desk: ps.addresses.SwapDesk,
      usdPerPot: pot(d.price),
      feePct: pct(d.feeBps),
      fresh: d.fresh,
      updatedAt: new Date(Number(d.updatedAt) * 1000).toISOString(),
      maxAgeHours: Number(d.maxAge) / 3600,
      quote10Usd: quote,
      at: new Date().toISOString(),
    });
  });

  app.get("/api/tools/wallet", async (req, res) => {
    const a = String(req.query.address) as Address;
    const p = await ps.position(a);
    res.json({
      tool: "wallet",
      address: a,
      portaldotAccount: h160ToSs58(a),
      explorer: accountUrl(a),
      tPot: pot(p.native),
      stPot: pot(p.stPot),
      stPotValuePot: pot(p.pot),
      stPotValueUsd: usd(p.usd),
      tUSD: usd(p.tUSD),
      xUSD: usd(p.xUSD),
      at: new Date().toISOString(),
    });
  });

  app.get("/api/tools/mandates", async (_req, res) => {
    const m = mandates(ps);
    const [count, due] = await Promise.all([m.count(), m.due()]);
    res.json({
      tool: "mandates",
      manager: ps.addresses.MandateManager,
      total: Number(count),
      due: due.map((d) => ({ id: Number(d.id), amount: d.amount.toString() })),
      at: new Date().toISOString(),
    });
  });

  app.use("/api/tools", (_req, res) => {
    res.status(404).json({ error: "unknown tool" });
  });
  return app;
}
