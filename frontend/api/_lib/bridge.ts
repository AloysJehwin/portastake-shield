// Bridge delivery as a function: no daemon, no contract. Every chain's side of the bridge is the relayer
// wallet. A user bridges by sending that wallet the chain's token with routing appended to the calldata
// (see relayer/src/bridge/tags.ts); the app then calls POST /api/bridge/claim with the transaction, and this
// checks it on the source chain and pays it out on the destination from the same wallet.
//
// Nothing on-chain stops the wallet paying twice, so a claim is only paid when:
//  - the source transfer is final and carries a valid route,
//  - no payout tagged with its release id exists on the destination since the transfer was sent,
//  - the wallet has no unconfirmed transaction (a payout still in the mempool can't be seen by that scan),
//  and the payout is sent at the wallet's current nonce, so two racing claims can land only one transaction.
// The long-running relayer (relayer/src/bridge) follows the same rules and the same tags, so both can run.
import express, { type Express } from "express";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isHash,
  keccak256,
  parseAbi,
  sliceHex,
  size,
  zeroAddress,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import chainsJson from "../../src/deployments/bridge-chains.json" with { type: "json" };
import hubDep from "../../src/deployments/bridge-420420777.json" with { type: "json" };
import baseDep from "../../src/deployments/bridge-84532.json" with { type: "json" };
import arbDep from "../../src/deployments/bridge-421614.json" with { type: "json" };
import opDep from "../../src/deployments/bridge-11155420.json" with { type: "json" };
import sepoliaDep from "../../src/deployments/bridge-11155111.json" with { type: "json" };
import amoyDep from "../../src/deployments/bridge-80002.json" with { type: "json" };

type ChainCfg = {
  key: string;
  name: string;
  chainId: number;
  hub?: boolean;
  rpc: string;
  explorer: string;
  nativeSymbol: string;
  nativeDecimals: number;
  finality: number | "finalized";
  legacy?: boolean;
  logChunk: number;
};
type WalletSide = {
  TokenBridge: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  desk: string;
  deployBlock: number;
  custody: "wallet";
  faucet?: string;
};

const SIDES: Record<number, WalletSide> = Object.fromEntries(
  [hubDep, baseDep, arbDep, opDep, sepoliaDep, amoyDep].map((d, i) => [
    [420420777, 84532, 421614, 11155420, 11155111, 80002][i],
    d as WalletSide,
  ]),
);

const TRANSFER_SELECTOR = "0xa9059cbb";
const BRIDGE_OUT = "0x50534231";
const BRIDGE_SAVE = "0x50534232";
const PAYOUT = "0x50534252";
const TOKEN_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const DESK_ABI = parseAbi([
  "event StableDeposited(address indexed payer, address indexed receiver, uint256 usdIn, uint256 potIn, uint256 shares)",
  "function depositWithStable(uint256 usdAmount, uint256 minShares, address receiver) returns (uint256)",
]);

export type ClaimState =
  | "pending" // the source transaction isn't mined yet
  | "confirming" // mined, waiting for finality
  | "delivering" // a payout is on its way
  | "delivered"
  | "queued" // valid, but can't be paid right now (see message); try again later
  | "invalid";

export type ClaimResult = {
  state: ClaimState;
  message?: string;
  id?: Hex;
  srcChainId?: number;
  dstChainId?: number;
  to?: Address;
  amount?: string;
  confirmations?: number;
  needed?: number | "finalized";
  payoutTx?: Hash;
  /** stPOT minted when the transfer was saved on arrival; 0 when it arrived as tUSD. */
  shares?: string;
};

const chains = (chainsJson as ChainCfg[]).map((c) => ({ ...c, rpc: process.env[`RPC_${c.chainId}`] ?? c.rpc }));
const chainCfg = (id: number) => chains.find((c) => c.chainId === id);
const viemChains = new Map<number, Chain>();
const clients = new Map<number, PublicClient>();

function viemChain(c: ChainCfg): Chain {
  let chain = viemChains.get(c.chainId);
  if (!chain) {
    chain = defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: c.nativeDecimals },
      rpcUrls: { default: { http: [c.rpc] } },
    });
    viemChains.set(c.chainId, chain);
  }
  return chain;
}

function client(c: ChainCfg): PublicClient {
  let pc = clients.get(c.chainId);
  if (!pc) {
    pc = createPublicClient({ chain: viemChain(c), transport: http(c.rpc, { retryCount: 2, timeout: 15_000 }) }) as PublicClient;
    clients.set(c.chainId, pc);
  }
  return pc;
}

/** Must match relayer/src/bridge/message.ts. */
export function releaseId(srcChainId: number, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [BigInt(srcChainId), nonce]));
}

/** Must match relayer/src/bridge/tags.ts. */
export function parseRoute(input: Hex): { dstChainId: number; to: Address; minShares: bigint } | undefined {
  if (!input.toLowerCase().startsWith(TRANSFER_SELECTOR) || size(input) < 68 + 32) return undefined;
  const suffix = sliceHex(input, 68);
  const magic = sliceHex(suffix, 0, 4).toLowerCase();
  const saving = magic === BRIDGE_SAVE;
  if (!saving && magic !== BRIDGE_OUT) return undefined;
  if (size(suffix) !== 32 + (saving ? 32 : 0)) return undefined;
  const to = getAddress(sliceHex(suffix, 12, 32));
  if (to === zeroAddress) return undefined;
  return {
    dstChainId: Number(BigInt(sliceHex(suffix, 4, 12))),
    to,
    minShares: saving ? BigInt(sliceHex(suffix, 32, 64)) : 0n,
  };
}

function payoutIdOf(input: Hex): Hex | undefined {
  if (size(input) < 36) return undefined;
  const tail = sliceHex(input, size(input) - 36);
  return sliceHex(tail, 0, 4).toLowerCase() === PAYOUT ? sliceHex(tail, 4) : undefined;
}

const envBig = (name: string, fallback: bigint) => (process.env[name] ? BigInt(process.env[name]!) : fallback);

function limits(c: ChainCfg) {
  return {
    maxPayout: envBig("BRIDGE_MAX_PAYOUT", 10_000_000n),
    maxTxCost: c.hub
      ? envBig("BRIDGE_MAX_TX_TPOT", 20n) * 10n ** 18n
      : envBig(`BRIDGE_MAX_TX_WEI_${c.chainId}`, envBig("BRIDGE_MAX_TX_WEI", 10n ** 16n)),
    reserve: c.hub
      ? envBig("BRIDGE_TPOT_RESERVE", 5n) * 10n ** 18n
      : envBig(`BRIDGE_RESERVE_WEI_${c.chainId}`, envBig("BRIDGE_RESERVE_WEI", 10n ** 15n)),
  };
}

const CLAIM_WINDOW_SECS = Number(process.env.BRIDGE_CLAIM_WINDOW_SECS ?? 3 * 86_400);

/** The highest block at or before `ts`, by binary search. */
async function blockAtOrBefore(pc: PublicClient, ts: bigint): Promise<bigint> {
  let hi = await pc.getBlockNumber();
  let lo = 0n;
  const top = await pc.getBlock({ blockNumber: hi });
  if (top.timestamp <= ts) return hi;
  // Most claims are recent; bound the search before bisecting the whole chain.
  for (let step = 256n; step < hi; step *= 4n) {
    const b = await pc.getBlock({ blockNumber: hi - step });
    if (b.timestamp <= ts) {
      lo = hi - step;
      break;
    }
    hi = hi - step;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await pc.getBlock({ blockNumber: mid })).timestamp <= ts) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A payout tagged `id` from the wallet on `dst` at or after `fromBlock`, if one exists. */
async function findPayout(dst: ChainCfg, side: WalletSide, id: Hex, fromBlock: bigint) {
  const pc = client(dst);
  const head = await pc.getBlockNumber();
  const wallet = getAddress(side.TokenBridge);
  for (let from = fromBlock; from <= head; from += BigInt(dst.logChunk)) {
    const to = from + BigInt(dst.logChunk) - 1n > head ? head : from + BigInt(dst.logChunk) - 1n;
    const logs = await pc.getLogs({
      address: getAddress(side.token),
      event: TOKEN_ABI[0],
      args: { from: wallet },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const tx = await pc.getTransaction({ hash: log.transactionHash! });
      if (payoutIdOf(tx.input)?.toLowerCase() === id.toLowerCase()) return log.transactionHash!;
    }
  }
  return undefined;
}

async function sharesIn(dst: ChainCfg, hash: Hash): Promise<bigint> {
  const receipt = await client(dst).getTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: DESK_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "StableDeposited") return ev.args.shares;
    } catch {
      // another contract's event
    }
  }
  return 0n;
}

export async function claim(srcChainId: number, txHash: Hash, key: string | undefined): Promise<ClaimResult> {
  const src = chainCfg(srcChainId);
  const srcSide = SIDES[srcChainId];
  if (!src || !srcSide) return { state: "invalid", message: `chain ${srcChainId} is not on the bridge` };
  const pc = client(src);

  const receipt = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) return { state: "pending", message: "Waiting for the transaction to be mined" };
  if (receipt.status !== "success") return { state: "invalid", message: "The transaction reverted" };

  const tx = await pc.getTransaction({ hash: txHash });
  const wallet = getAddress(srcSide.TokenBridge);
  const token = getAddress(srcSide.token);
  if (!tx.to || getAddress(tx.to) !== token) return { state: "invalid", message: "Not a transfer of the bridged token" };
  const route = parseRoute(tx.input);
  if (!route) return { state: "invalid", message: "The transfer has no bridge routing" };
  const log = receipt.logs.find((l) => {
    if (getAddress(l.address) !== token) return false;
    try {
      const ev = decodeEventLog({ abi: TOKEN_ABI, data: l.data, topics: l.topics });
      return ev.eventName === "Transfer" && getAddress(ev.args.from) === getAddress(tx.from) && getAddress(ev.args.to) === wallet;
    } catch {
      return false;
    }
  });
  if (!log) return { state: "invalid", message: "No transfer to the bridge wallet in this transaction" };
  const amount = (decodeEventLog({ abi: TOKEN_ABI, data: log.data, topics: log.topics }).args as { value: bigint }).value;

  const dst = chainCfg(route.dstChainId);
  const dstSide = SIDES[route.dstChainId];
  // Hub and spoke: spokes go to Portaldot, Portaldot goes to any spoke.
  if (!dst || !dstSide || !!dst.hub === !!src.hub) return { state: "invalid", message: "That route is not supported" };

  const nonce = (receipt.blockNumber << 16n) | BigInt(log.logIndex!);
  const id = releaseId(srcChainId, nonce);
  const base: ClaimResult = {
    state: "confirming",
    id,
    srcChainId,
    dstChainId: dst.chainId,
    to: route.to,
    amount: amount.toString(),
  };

  // Finality on the source chain.
  if (src.finality === "finalized") {
    const fin = await pc.getBlock({ blockTag: "finalized" });
    if (receipt.blockNumber > fin.number) return { ...base, needed: "finalized", message: `Waiting for ${src.name} to finalize` };
  } else {
    const head = await pc.getBlockNumber();
    const confirmations = Number(head - receipt.blockNumber);
    if (confirmations < src.finality) {
      return { ...base, confirmations, needed: src.finality, message: `Waiting for ${src.name} confirmations` };
    }
  }

  const block = await pc.getBlock({ blockNumber: receipt.blockNumber });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const dpc = client(dst);
  const fromBlock = await blockAtOrBefore(dpc, block.timestamp - 900n);
  const paid = await findPayout(dst, dstSide, id, fromBlock);
  if (paid) {
    return { ...base, state: "delivered", payoutTx: paid, shares: (dst.hub ? await sharesIn(dst, paid) : 0n).toString() };
  }
  if (now - block.timestamp > BigInt(CLAIM_WINDOW_SECS)) {
    // Past the window the payout scan above no longer reaches back far enough to rule out a double payment.
    return { ...base, state: "queued", message: "This transfer is too old to deliver automatically; the relayer will pick it up" };
  }
  if (!key) return { ...base, state: "queued", message: "Delivery is offline on this deployment; it will be paid once it is back" };

  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  if (getAddress(account.address) !== getAddress(dstSide.TokenBridge)) {
    return { ...base, state: "queued", message: "Delivery is misconfigured on this deployment" };
  }
  const walletAddr = account.address;
  const latestNonce = await dpc.getTransactionCount({ address: walletAddr, blockTag: "latest" });
  const pendingNonce = await dpc.getTransactionCount({ address: walletAddr, blockTag: "pending" });
  if (pendingNonce !== latestNonce) return { ...base, state: "delivering", message: "A payout is on its way" };

  const lim = limits(dst);
  if (amount > lim.maxPayout) return { ...base, state: "queued", message: "Over the per-transfer limit; it needs a manual payout" };
  const dstToken = getAddress(dstSide.token);
  const held = await dpc.readContract({ address: dstToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [walletAddr] });
  if (held < amount) return { ...base, state: "queued", message: `${dst.name} is waiting for more liquidity` };

  const wc = createWalletClient({ account, chain: viemChain(dst), transport: http(dst.rpc, { retryCount: 1, timeout: 20_000 }) });
  const tag = concatHex([PAYOUT, id]);
  const desk = dstSide.desk && dstSide.desk !== zeroAddress ? getAddress(dstSide.desk) : undefined;

  async function sendTx(to: Address, data: Hex, nonce: number): Promise<Hash> {
    const gas = ((await dpc.estimateGas({ account: walletAddr, to, data })) * 120n) / 100n;
    const gasPrice = await dpc.getGasPrice();
    const cost = gas * gasPrice;
    if (cost > lim.maxTxCost) throw new Error("gas is priced over the limit right now");
    const balance = await dpc.getBalance({ address: walletAddr });
    if (balance < cost + lim.reserve) throw new Error("the bridge wallet is low on gas");
    return wc.sendTransaction({
      to,
      data,
      gas,
      gasPrice,
      nonce,
      ...(dst!.legacy ? { type: "legacy" as const } : {}),
    } as Parameters<typeof wc.sendTransaction>[0]);
  }

  let nextNonce = latestNonce;
  let to = dstToken;
  let data = concatHex([encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [route.to, amount] }), tag]);
  if (dst.hub && desk && route.minShares > 0n) {
    try {
      const allowance = await dpc.readContract({ address: dstToken, abi: TOKEN_ABI, functionName: "allowance", args: [walletAddr, desk] });
      if (allowance < amount) {
        const approve = encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [desk, 10_000n * 1_000_000n] });
        const h = await sendTx(dstToken, approve, nextNonce);
        await dpc.waitForTransactionReceipt({ hash: h, timeout: 45_000 });
        nextNonce += 1;
      }
      const deposit = concatHex([
        encodeFunctionData({ abi: DESK_ABI, functionName: "depositWithStable", args: [amount, route.minShares, route.to] }),
        tag,
      ]);
      await dpc.call({ account: walletAddr, to: desk, data: deposit });
      to = desk;
      data = deposit;
    } catch {
      // The desk can't take it (stale price, short inventory, slippage): deliver tUSD instead.
    }
  }

  let payoutTx: Hash;
  try {
    payoutTx = await sendTx(to, data, nextNonce);
  } catch (e) {
    const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
    // Another claim took this nonce first; whichever landed is found by the next check.
    if (/nonce|already known|replacement/i.test(msg)) return { ...base, state: "delivering", message: "A payout is on its way" };
    return { ...base, state: "queued", message: msg.split("\n")[0] };
  }
  const done = await dpc.waitForTransactionReceipt({ hash: payoutTx, timeout: 40_000 }).catch(() => null);
  if (!done) return { ...base, state: "delivering", payoutTx, message: "Payout sent, waiting for it to confirm" };
  if (done.status !== "success") return { ...base, state: "queued", payoutTx, message: "The payout reverted; it will be retried" };
  return { ...base, state: "delivered", payoutTx, shares: (to === desk ? await sharesIn(dst, payoutTx) : 0n).toString() };
}

export type SideStatus = {
  chainId: number;
  name: string;
  hub: boolean;
  token: Address;
  symbol: string;
  wallet: Address;
  /** What the wallet can pay out on this chain, in token base units. Null when the chain didn't answer. */
  liquidity: string | null;
  faucet?: string;
};

export async function status(): Promise<SideStatus[]> {
  return Promise.all(
    chains
      .filter((c) => SIDES[c.chainId])
      .map(async (c) => {
        const side = SIDES[c.chainId];
        const wallet = getAddress(side.TokenBridge);
        const token = getAddress(side.token);
        const liquidity = await client(c)
          .readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [wallet] })
          .then((v) => v.toString())
          .catch(() => null);
        return { chainId: c.chainId, name: c.name, hub: !!c.hub, token, symbol: side.tokenSymbol, wallet, liquidity, faucet: side.faucet };
      }),
  );
}

export function createBridgeApp(env: Record<string, string | undefined> = process.env): Express {
  const key = env.BRIDGE_KEY ?? env.RELAYER_KEY;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4kb" }));

  app.get("/api/bridge/status", async (_req, res) => {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.json({ live: !!key, sides: await status() });
  });

  app.post("/api/bridge/claim", async (req, res) => {
    const srcChainId = Number(req.body?.srcChainId);
    const txHash = String(req.body?.txHash ?? "");
    if (!Number.isInteger(srcChainId) || !isHash(txHash)) {
      res.status(400).json({ state: "invalid", message: "srcChainId and txHash are required" });
      return;
    }
    try {
      res.json(await claim(srcChainId, txHash as Hash, key));
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
      res.status(502).json({ state: "queued", message: `A chain didn't answer (${msg.split("\n")[0]}); try again shortly` });
    }
  });

  app.use("/api/bridge", (_req, res) => {
    res.status(404).json({ error: "unknown bridge route" });
  });
  return app;
}
