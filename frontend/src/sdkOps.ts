// The calls each page's SDK playground offers. Every `code` shows the same call `run` makes.
import { isAddress, isHash, parseEther, parseUnits, type Address, type Hash } from "viem";
import { accountUrl, h160ToSs58, mandates, txUrl } from "@portastake/sdk/chain";
import { getOffer, payAndFetchJson } from "@portastake/sdk/x402";
import type { SdkOp } from "./components/SdkPlayground";

const API = ((import.meta.env.VITE_TOOLS_URL as string | undefined) ?? "").replace(/\/$/, "");
const origin = () => API || (typeof window !== "undefined" ? window.location.origin : "");

const header = `import { createPortaStake } from "@portastake/sdk/chain";

const ps = createPortaStake(); // public Portaldot V3 RPC`;
const writer = `import { createPortaStake } from "@portastake/sdk/chain";

// walletClient: any viem wallet client with an account, e.g. from wagmi's useWalletClient()
const ps = createPortaStake({ walletClient });`;

function addr(v: string | undefined): Address {
  if (!v || !isAddress(v)) throw new Error("enter a 0x address");
  return v as Address;
}

const usd = (v: string | undefined) => parseUnits(v || "0", 6);

const stats: SdkOp = {
  id: "stats",
  title: "ps.stats()",
  summary: "Vault TVL, stPOT supply and exchange rate, target and effective rate, liquidity and both safety funds.",
  code: () => `${header}\n\nconst s = await ps.stats();\nconsole.log(s.totalAssets, s.exchangeRate, s.targetRateBps);`,
  run: ({ ps }) => ps.stats(),
};

const desk: SdkOp = {
  id: "desk",
  title: "ps.desk()",
  summary: "The tPOT/USD price the desk swaps at, its fee and whether the price is fresh.",
  code: () => `${header}\n\nconst d = await ps.desk();\nconsole.log(d.price, d.feeBps, d.fresh);`,
  run: ({ ps }) => ps.desk(),
};

const position: SdkOp = {
  id: "position",
  title: "ps.position(address)",
  summary: "Any wallet's tPOT, stPOT and what it is worth in POT and USD, plus tUSD and xUSD.",
  params: [{ name: "address", label: "Address", placeholder: "0x…", fromWallet: true }],
  code: (p) => `${header}\n\nconst pos = await ps.position("${p.address || "0x…"}");\nconsole.log(pos.stPot, pos.usd);`,
  run: ({ ps }, p) => ps.position(addr(p.address)),
};

const quoteDeposit: SdkOp = {
  id: "quoteDeposit",
  title: "ps.quoteDeposit(usd, slippageBps)",
  summary: "How much stPOT a tUSD deposit mints right now, and the minimum after slippage.",
  params: [
    { name: "usd", label: "tUSD amount", initial: "10" },
    { name: "slippage", label: "Slippage (bps)", initial: "50" },
  ],
  code: (p) =>
    `${header}\nimport { parseUnits } from "viem";\n\nconst q = await ps.quoteDeposit(parseUnits("${p.usd || "10"}", 6), ${p.slippage || 50});\nconsole.log(q.shares, q.minShares);`,
  run: ({ ps }, p) => ps.quoteDeposit(usd(p.usd), Number(p.slippage || 50)),
};

const faucet: SdkOp = {
  id: "faucet",
  title: 'ps.faucet("tUSD", amount)',
  summary: "Mints test tUSD to your wallet so you can try deposits.",
  writes: true,
  params: [{ name: "usd", label: "tUSD amount", initial: "100" }],
  code: (p) => `${writer}\nimport { parseUnits } from "viem";\n\nconst tx = await ps.faucet("tUSD", parseUnits("${p.usd || "100"}", 6));\nconsole.log(tx.explorerUrl);`,
  run: ({ ps }, p) => ps.faucet("tUSD", usd(p.usd)),
};

const depositStable: SdkOp = {
  id: "depositStable",
  title: "ps.depositStable(usd, opts)",
  summary: "Approves if needed, swaps tUSD to POT and mints stPOT to you, in one call.",
  writes: true,
  params: [
    { name: "usd", label: "tUSD amount", initial: "5" },
    { name: "slippage", label: "Slippage (bps)", initial: "50" },
  ],
  code: (p) =>
    `${writer}\nimport { parseUnits } from "viem";\n\nconst tx = await ps.depositStable(parseUnits("${p.usd || "5"}", 6), { slippageBps: ${p.slippage || 50} });\nconsole.log(tx.status, tx.explorerUrl);`,
  run: ({ ps }, p) => ps.depositStable(usd(p.usd), { slippageBps: Number(p.slippage || 50) }),
};

const quoteWithdraw: SdkOp = {
  id: "quoteWithdraw",
  title: "ps.quoteWithdraw(shares, slippageBps)",
  summary: "What redeeming stPOT pays out in POT and tUSD right now.",
  params: [
    { name: "shares", label: "stPOT amount", initial: "1" },
    { name: "slippage", label: "Slippage (bps)", initial: "50" },
  ],
  code: (p) =>
    `${header}\nimport { parseEther } from "viem";\n\nconst q = await ps.quoteWithdraw(parseEther("${p.shares || "1"}"), ${p.slippage || 50});\nconsole.log(q.usd, q.minUsd);`,
  run: ({ ps }, p) => ps.quoteWithdraw(parseEther(p.shares || "0"), Number(p.slippage || 50)),
};

const withdrawToStable: SdkOp = {
  id: "withdrawToStable",
  title: "ps.withdrawToStable(shares, opts)",
  summary: "Burns stPOT and pays you tUSD from the hot reserve.",
  writes: true,
  params: [{ name: "shares", label: "stPOT amount", initial: "0.5" }],
  code: (p) =>
    `${writer}\nimport { parseEther } from "viem";\n\nconst tx = await ps.withdrawToStable(parseEther("${p.shares || "0.5"}"));\nconsole.log(tx.explorerUrl);`,
  run: ({ ps }, p) => ps.withdrawToStable(parseEther(p.shares || "0")),
};

const mandateCount: SdkOp = {
  id: "mandateCount",
  title: "mandates(ps).count()",
  summary: "How many save and pay rules exist.",
  code: () => `${header}\nimport { mandates } from "@portastake/sdk/chain";\n\nconsole.log(await mandates(ps).count());`,
  run: async ({ ps }) => ({ count: await mandates(ps).count() }),
};

const mandateDue: SdkOp = {
  id: "mandateDue",
  title: "mandates(ps).due()",
  summary: "Which rules are due to run now. This is what the keeper executes.",
  code: () => `${header}\nimport { mandates } from "@portastake/sdk/chain";\n\nconst due = await mandates(ps).due();\nfor (const d of due) console.log(d.id, d.amount);`,
  run: ({ ps }) => mandates(ps).due(),
};

const mandateMine: SdkOp = {
  id: "mandateMine",
  title: "mandates(ps).listByOwner(address)",
  summary: "Every rule one wallet owns, with its schedule, caps and run count.",
  params: [{ name: "address", label: "Owner", placeholder: "0x…", fromWallet: true }],
  code: (p) =>
    `${header}\nimport { mandates } from "@portastake/sdk/chain";\n\nconst mine = await mandates(ps).listByOwner("${p.address || "0x…"}");`,
  run: ({ ps }, p) => mandates(ps).listByOwner(addr(p.address)),
};

const mandateCreate: SdkOp = {
  id: "mandateCreate",
  title: "mandates(ps).create(params)",
  summary: "Creates a weekly save rule. The SDK approves tUSD for you first if it needs to, so it is one call.",
  writes: true,
  params: [{ name: "usd", label: "tUSD per run", initial: "5" }],
  code: (p) =>
    `${writer}\nimport { mandates, Direction, Trigger, WEEK } from "@portastake/sdk/chain";\nimport { parseUnits, zeroAddress } from "viem";\n\nawait mandates(ps).create({\n  dir: Direction.SAVE, trig: Trigger.RECURRING, payee: zeroAddress,\n  amount: parseUnits("${p.usd || "5"}", 6), bound: 0n, start: 0n, interval: BigInt(WEEK),\n  maxRuns: 0n, expiry: 0n, maxSlippageBps: 50,\n});`,
  run: async ({ ps }, p) => {
    const { Direction, Trigger, WEEK } = await import("@portastake/sdk/chain");
    return mandates(ps).create({
      dir: Direction.SAVE,
      trig: Trigger.RECURRING,
      payee: "0x0000000000000000000000000000000000000000",
      amount: usd(p.usd),
      bound: 0n,
      start: 0n,
      interval: BigInt(WEEK),
      maxRuns: 0n,
      expiry: 0n,
      maxSlippageBps: 50,
    } as never);
  },
};

const offer: SdkOp = {
  id: "offer",
  title: "getOffer(url)",
  summary: "What a paid x402 endpoint charges, in which token and to whom, without paying.",
  params: [{ name: "path", label: "Endpoint", initial: "/api/tools/vault" }],
  code: (p) => `import { getOffer } from "@portastake/sdk/x402";\n\nconst offer = await getOffer("${origin()}${p.path || "/api/tools/vault"}");\nconsole.log(offer?.amount, offer?.payTo);`,
  run: async (_ctx, p) => (await getOffer(`${API}${p.path || "/api/tools/vault"}`)) ?? { free: true },
};

const payAndFetch: SdkOp = {
  id: "payAndFetch",
  title: "payAndFetchJson(url, { payer })",
  summary: "Calls a paid endpoint and pays it in xUSD within a spend limit. You sign; you pay no gas.",
  writes: true,
  params: [{ name: "path", label: "Endpoint", initial: "/api/tools/desk" }],
  code: (p) =>
    `import { payAndFetchJson } from "@portastake/sdk/x402";\n\nconst { data, settlement } = await payAndFetchJson("${origin()}${p.path || "/api/tools/desk"}", {\n  payer: walletClient, // or privateKeyToAccount(key)\n  maxPerRequest: "1",\n});`,
  run: ({ walletClient }, p) => {
    if (!walletClient) throw new Error("connect a wallet");
    return payAndFetchJson(`${API}${p.path || "/api/tools/desk"}`, { payer: walletClient, maxPerRequest: "1" });
  },
};

const ss58: SdkOp = {
  id: "ss58",
  title: "h160ToSs58(address)",
  summary: "The Portaldot (Substrate) account behind any 0x address, and its explorer page.",
  params: [{ name: "address", label: "Address", placeholder: "0x…", fromWallet: true }],
  code: (p) =>
    `import { h160ToSs58, accountUrl } from "@portastake/sdk/chain";\n\nconsole.log(h160ToSs58("${p.address || "0x…"}"));\nconsole.log(accountUrl("${p.address || "0x…"}"));`,
  run: async (_ctx, p) => ({ ss58: h160ToSs58(addr(p.address)), explorer: accountUrl(addr(p.address)) }),
};

const tx: SdkOp = {
  id: "txUrl",
  title: "txUrl(client, hash)",
  summary: "An explorer link for any Portaldot EVM transaction.",
  params: [{ name: "hash", label: "Transaction hash", placeholder: "0x…" }],
  code: (p) => `import { txUrl } from "@portastake/sdk/chain";\n\nconsole.log(await txUrl(ps.publicClient, "${p.hash || "0x…"}"));`,
  run: async ({ publicClient }, p) => {
    if (!p.hash || !isHash(p.hash)) throw new Error("enter a 0x transaction hash");
    return { url: await txUrl(publicClient, p.hash as Hash) };
  },
};

const httpGet = (id: string, title: string, summary: string, path: string): SdkOp => ({
  id,
  kind: "http",
  title,
  summary,
  code: () => `const res = await fetch("${origin()}${path}");\nconsole.log(await res.json());`,
  run: async () => {
    const r = await fetch(`${API}${path}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
});

const bridgeClaim: SdkOp = {
  id: "bridgeClaim",
  kind: "http",
  writes: false,
  title: "POST /api/bridge/claim",
  summary: "Checks a bridge transfer and delivers it if it hasn't been. Safe to call any number of times.",
  params: [
    { name: "chain", label: "Source chain id", initial: "84532" },
    { name: "hash", label: "Transfer tx hash", placeholder: "0x…" },
  ],
  code: (p) =>
    `const res = await fetch("${origin()}/api/bridge/claim", {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify({ srcChainId: ${p.chain || 84532}, txHash: "${p.hash || "0x…"}" }),\n});\nconsole.log(await res.json());`,
  run: async (_ctx, p) => {
    const r = await fetch(`${API}/api/bridge/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ srcChainId: Number(p.chain), txHash: p.hash }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};

const gatewayInspect: SdkOp = {
  id: "gatewayInspect",
  kind: "http",
  title: "GET /api/gateway/inspect?id=",
  summary: "What a gateway endpoint forwards to, its price and who it pays. Free.",
  params: [{ name: "id", label: "Endpoint id", placeholder: "eyJ2Ijox…" }],
  code: (p) => `const res = await fetch("${origin()}/api/gateway/inspect?id=${p.id || "<id>"}");\nconsole.log(await res.json());`,
  run: async (_ctx, p) => {
    const r = await fetch(`${API}/api/gateway/inspect?id=${encodeURIComponent(p.id ?? "")}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};

export const SDK_OPS = {
  home: [stats, desk, position],
  deposit: [quoteDeposit, faucet, depositStable],
  withdraw: [position, quoteWithdraw, withdrawToStable],
  automate: [mandateCount, mandateDue, mandateMine, mandateCreate],
  tools: [offer, payAndFetch, gatewayInspect, httpGet("catalog", "GET /api/tools/catalog", "The paid tools this app serves.", "/api/tools/catalog")],
  activity: [ss58, tx, position],
  bridge: [httpGet("bridgeStatus", "GET /api/bridge/status", "Every chain on the bridge, its token and how much it can pay out now.", "/api/bridge/status"), bridgeClaim],
} satisfies Record<string, SdkOp[]>;
