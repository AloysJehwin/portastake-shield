import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import express from "express";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, isAddress, parseEther, parseUnits, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPortaStake,
  runKeeperPass,
  mandates,
  accountUrl,
  txUrl,
  h160ToSs58,
  estimateDeployCost,
  initcodeLength,
  balanceReport,
  portaldotChain,
  DEFAULT_RPC,
  NETWORK,
  type Stable,
} from "./chain/index.js";
import { createPayingFetch, getOffer, getSettlement, formatXusd } from "./x402/index.js";
import { xusdPaywall, x402Cors } from "./x402/server.js";
import { createFacilitator } from "./x402/facilitator.js";
import portaldotV3 from "./deployments/420420777.json";

const HELP = `portastake: paid on-chain tools (x402) and PortaStake tooling for Portaldot

Reads (no key needed)
  stats                         vault totals, rates and safety funds
  price                         desk price, fee and freshness
  position <address>            balances and savings value of an address
  balance <address>             native tPOT and whether it can pay for a transaction
  mandates [owner]              save and pay rules (all, or one owner's), and which are due
  explorer <address|txhash>     explorer link (and SS58 account for an address)
  deploy-cost <bytes|artifact>  estimated tPOT to deploy, from a byte count or a Foundry JSON
  offer <url>                   what an x402 API charges, without paying

Writes (key from PRIVATE_KEY)
  deposit <tpot>                stake native tPOT for stPOT
  save <usd> [--asset xUSD]     save tUSD or xUSD as stPOT
  withdraw <stpot> [--asset xUSD]  withdraw stPOT as tUSD or xUSD
  faucet <usd> [--asset xUSD]   mint test tUSD or xUSD
  keeper [--loop <secs>]        run every due mandate (once, or every <secs>)

x402
  pay <url> [--max 1]           call an x402 API, paying in xUSD (key from PAYER_KEY or PRIVATE_KEY)
  facilitator [--port 4020]     run an x402 facilitator (key from FACILITATOR_KEY or PRIVATE_KEY)
  paywall-demo [--port 4021]    run a sample paid tool: live vault stats for 0.01 xUSD
                                (PAY_TO, FACILITATOR_URL, CORS_ORIGINS from the environment)

Options
  --rpc <url>                   RPC endpoint (default ${DEFAULT_RPC}, or RPC env var)
  --json                        print JSON instead of text
  --slippage <bps>              slippage limit for save and withdraw (default 50)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" },
    json: { type: "boolean" },
    asset: { type: "string" },
    slippage: { type: "string" },
    loop: { type: "string" },
    max: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
const rpc = flags.rpc ?? process.env.RPC ?? DEFAULT_RPC;
const chain = portaldotChain(rpc);
const publicClient = createPublicClient({ chain, transport: http(rpc, { retryCount: 2 }) }) as PublicClient;

function out(text: string, data: unknown) {
  if (flags.json) console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else console.log(text);
}

function key(...names: string[]): Hex {
  for (const n of names) {
    const k = process.env[n];
    if (k) return (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  }
  throw new Error(`set ${names.join(" or ")} in the environment`);
}

function need(arg: string | undefined, what: string): string {
  if (!arg) throw new Error(`missing ${what}; see portastake --help`);
  return arg;
}

function writer(...keys: string[]) {
  const account = privateKeyToAccount(key(...keys));
  const walletClient = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 2 }) });
  return createPortaStake({ publicClient, walletClient });
}

const asset = (): Stable => (flags.asset?.toLowerCase() === "xusd" ? "xUSD" : "tUSD");
const slippage = () => Number(flags.slippage ?? 50);
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`;
const pot = (v: bigint) => `${Number(formatEther(v)).toFixed(4)}`;

async function main() {
  if (!cmd || flags.help) {
    console.log(HELP);
    return;
  }
  const ps = createPortaStake({ publicClient });

  switch (cmd) {
    case "stats": {
      const s = await ps.stats();
      out(
        [
          `TVL              ${pot(s.totalAssets)} tPOT`,
          `stPOT supply     ${pot(s.totalSupply)}`,
          `tPOT per stPOT   ${Number(formatEther(s.exchangeRate)).toFixed(6)}`,
          `target rate      ${pct(s.targetRateBps)}`,
          `effective rate   ${pct(s.effectiveRateBps)}`,
          `liquid now       ${pot(s.availableLiquidity)} tPOT`,
          `insurance fund   ${pot(s.insuranceBalance)} tPOT`,
          `reserve          ${pot(s.reserveBalance)} tPOT`,
        ].join("\n"),
        s,
      );
      break;
    }
    case "price": {
      const d = await ps.desk();
      const age = Math.floor(Date.now() / 1000) - Number(d.updatedAt);
      out(
        `price ${Number(formatEther(d.price)).toFixed(4)} USD/tPOT · fee ${pct(d.feeBps)} · updated ${Math.round(age / 60)} min ago · ${d.fresh ? "fresh" : "STALE: stable deposits and withdrawals are paused until it is re-fed"}`,
        d,
      );
      break;
    }
    case "position": {
      const user = need(args[0], "address") as Address;
      const p = await ps.position(user);
      out(
        [
          `tPOT     ${pot(p.native)}`,
          `stPOT    ${pot(p.stPot)}  (≈ ${pot(p.pot)} tPOT ≈ ${usd(p.usd)})`,
          `tUSD     ${usd(p.tUSD)}`,
          `xUSD     ${usd(p.xUSD)}`,
          `explorer ${accountUrl(user)}`,
        ].join("\n"),
        p,
      );
      break;
    }
    case "balance": {
      const b = await balanceReport(publicClient, need(args[0], "address") as Address);
      out(`${b.tpot.toFixed(4)} tPOT · ${b.canTransact ? "can send transactions" : "below ~10 tPOT: transactions will be rejected"}`, b);
      break;
    }
    case "mandates": {
      const m = mandates(ps);
      const list = args[0]
        ? await m.listByOwner(args[0] as Address)
        : await Promise.all(Array.from({ length: Number(await m.count()) }, (_, i) => m.get(BigInt(i))));
      const live = list.filter((x) => x.owner !== "0x0000000000000000000000000000000000000000");
      const dueNow = await Promise.all(live.map((x) => m.isDue(x.id)));
      out(
        live.length === 0
          ? "no mandates"
          : live
              .map((x, i) => `#${x.id} ${x.dir === 0 ? "SAVE" : "PAY"} ${["RECURRING", "SCHEDULED", "THRESHOLD"][x.trig]} ${usd(x.amount)} · ${x.active ? "active" : "paused"} · ${x.runs} runs${dueNow[i].due ? " · DUE" : ""}`)
              .join("\n"),
        live.map((x, i) => ({ ...x, due: dueNow[i].due })),
      );
      break;
    }
    case "explorer": {
      const target = need(args[0], "address or tx hash");
      if (isAddress(target)) out(`${accountUrl(target)}\nSS58 ${h160ToSs58(target)}`, { url: accountUrl(target), ss58: h160ToSs58(target) });
      else {
        const url = await txUrl(publicClient, target as Hash);
        out(url, { url });
      }
      break;
    }
    case "deploy-cost": {
      const a = need(args[0], "byte count or artifact path");
      const bytes = /^\d+$/.test(a) ? Number(a) : initcodeLength(JSON.parse(readFileSync(a, "utf8")));
      const cost = estimateDeployCost(bytes);
      out(`${bytes} bytes of init code ≈ ${cost.toFixed(1)} tPOT to deploy`, { bytes, tpot: cost });
      break;
    }
    case "offer": {
      const o = await getOffer(need(args[0], "url"));
      out(o ? `${formatXusd(o.amount)} xUSD per request → ${o.payTo} on ${o.network}${o.description ? `\n${o.description}` : ""}` : "free: no payment asked", o);
      break;
    }
    case "deposit": {
      const tx = await writer("PRIVATE_KEY").depositNative(parseEther(need(args[0], "tPOT amount")));
      out(`deposited · ${tx.explorerUrl}`, tx);
      break;
    }
    case "save": {
      const tx = await writer("PRIVATE_KEY").depositStable(parseUnits(need(args[0], "USD amount"), 6), { asset: asset(), slippageBps: slippage() });
      out(`saved · ${tx.explorerUrl}`, tx);
      break;
    }
    case "withdraw": {
      const tx = await writer("PRIVATE_KEY").withdrawToStable(parseEther(need(args[0], "stPOT amount")), { asset: asset(), slippageBps: slippage() });
      out(`withdrew to ${asset()} · ${tx.explorerUrl}`, tx);
      break;
    }
    case "faucet": {
      const tx = await writer("PRIVATE_KEY").faucet(asset(), parseUnits(need(args[0], "USD amount"), 6));
      out(`minted ${args[0]} ${asset()} · ${tx.explorerUrl}`, tx);
      break;
    }
    case "keeper": {
      const k = writer("KEEPER_KEY", "PRIVATE_KEY");
      const failures = new Map<bigint, number>();
      const log = (l: string) => console.log(l);
      console.log(`keeper ${k.walletClient!.account!.address} · MandateManager ${k.addresses.MandateManager}`);
      await runKeeperPass(k, { failures, log });
      const loop = Number(flags.loop ?? 0);
      while (loop > 0) {
        await new Promise((r) => setTimeout(r, loop * 1000));
        await runKeeperPass(k, { failures, log });
      }
      break;
    }
    case "pay": {
      const url = need(args[0], "url");
      const payer = privateKeyToAccount(key("PAYER_KEY", "PRIVATE_KEY"));
      const pay = createPayingFetch({ payer, maxPerRequest: flags.max ?? "1" });
      const res = await pay(url);
      const body = await res.text();
      const s = getSettlement(res);
      let link: string | undefined;
      if (s?.transaction) link = await txUrl(publicClient, s.transaction as Hash).catch(() => undefined);
      if (flags.json) out("", { status: res.status, body: safeJson(body), settlement: s, explorerUrl: link });
      else {
        console.log(`${res.status} ${res.statusText}`);
        console.log(body);
        if (s?.transaction) console.log(`paid · settlement ${s.transaction}${link ? `\n${link}` : ""}`);
      }
      break;
    }
    case "facilitator": {
      const port = Number(flags.port ?? process.env.FACILITATOR_PORT ?? 4020);
      const f = createFacilitator({
        privateKey: key("FACILITATOR_KEY", "PRIVATE_KEY"),
        rpc,
        onResult: (op, ok, d) => console.log(`${op} ${ok ? "ok" : "rejected"}${d.transaction ? ` tx ${d.transaction}` : ""}${ok ? "" : ` (${d.reason ?? "unknown"})`}`),
      });
      f.app.listen(port, () => console.log(`x402 facilitator ${f.address} on ${NETWORK} → http://localhost:${port}`));
      return; // keep running
    }
    case "paywall-demo": {
      const port = Number(flags.port ?? process.env.API_PORT ?? 4021);
      const payTo = (process.env.PAY_TO ?? portaldotV3.deployer) as Address;
      const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:4020";
      const price = process.env.PRICE ?? "0.01";
      const app = express();
      app.use(x402Cors((process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",")));
      app.use(
        xusdPaywall({
          facilitatorUrl,
          routes: { "GET /api/vault-stats": { price, payTo, description: "Live PortaStake Shield vault stats on Portaldot V3" } },
        }),
      );
      app.get("/api/vault-stats", async (_req, res) => {
        const s = await ps.stats();
        res.json({
          vault: ps.addresses.StakingVault,
          tvlPot: Number(formatEther(s.totalAssets)),
          stPotSupply: Number(formatEther(s.totalSupply)),
          targetRatePct: Number(s.targetRateBps) / 100,
          potPerStPot: Number(formatEther(s.exchangeRate)),
          at: new Date().toISOString(),
        });
      });
      app.listen(port, () => console.log(`paid tool → http://localhost:${port}/api/vault-stats  (${price} xUSD → ${payTo}, facilitator ${facilitatorUrl})`));
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"; see portastake --help`);
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

main().catch((e) => {
  const err = e as { shortMessage?: string; message?: string };
  console.error(`error: ${(err.shortMessage ?? err.message ?? String(e)).split("\n")[0]}`);
  process.exit(1);
});
