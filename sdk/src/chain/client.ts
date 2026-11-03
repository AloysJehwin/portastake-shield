import {
  createPublicClient,
  http,
  maxUint256,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { StakingVaultAbi } from "../abi/StakingVault.js";
import { SwapDeskAbi } from "../abi/SwapDesk.js";
import { MockStableAbi } from "../abi/MockStable.js";
import { X402DollarAbi } from "../abi/X402Dollar.js";
import { XusdGatewayAbi } from "../abi/XusdGateway.js";
import { InsuranceFundAbi } from "../abi/InsuranceFund.js";
import { StabilizationReserveAbi } from "../abi/StabilizationReserve.js";
import { CHAIN_ID, DEFAULT_EXPLORER, getAddresses, isDeployed, portaldotChain, type Addresses } from "../network.js";
import { LEGACY_TX } from "./portaldot.js";
import { blockUrl } from "./explorer.js";

const BPS = 10_000n;

export type Stable = "tUSD" | "xUSD";

export type PortaStakeOptions = {
  /** Reads go through this client. Defaults to the public Portaldot V3 RPC. */
  publicClient?: PublicClient;
  /** Needed for writes. Must carry an account. */
  walletClient?: WalletClient<Transport, Chain | undefined, Account | undefined>;
  /** RPC used when `publicClient` is not given. */
  rpc?: string;
  chainId?: number;
  /** Your own deployment, merged over the known one. */
  addresses?: Partial<Addresses>;
  explorer?: string;
};

/** Result of a write: the hash, the block it landed in and an explorer link for it. */
export type TxResult = { hash: Hash; blockNumber: bigint; status: "success" | "reverted"; explorerUrl: string };

export type VaultStats = {
  totalAssets: bigint;
  totalSupply: bigint;
  /** POT per stPOT, 18 decimals. */
  exchangeRate: bigint;
  targetRateBps: bigint;
  effectiveRateBps: bigint;
  availableLiquidity: bigint;
  insuranceBalance: bigint;
  reserveBalance: bigint;
};

export type DeskState = {
  /** USD per POT, 18 decimals. */
  price: bigint;
  updatedAt: bigint;
  maxAge: bigint;
  feeBps: bigint;
  /** False once the price is older than `maxAge`: stable deposits and withdrawals then revert. */
  fresh: boolean;
};

export type Position = {
  user: Address;
  native: bigint;
  stPot: bigint;
  /** stPOT valued in POT. */
  pot: bigint;
  /** stPOT valued in USD (6 decimals) at the desk price, before fees. */
  usd: bigint;
  tUSD: bigint;
  xUSD: bigint;
};

type AnyWallet = WalletClient<Transport, Chain | undefined, Account | undefined>;
type SendOpts = { asset?: Stable; slippageBps?: number; receiver?: Address };

export interface PortaStake {
  chainId: number;
  addresses: Addresses;
  explorer: string;
  publicClient: PublicClient;
  walletClient?: AnyWallet;
  /** Vault totals, rates and safety-fund balances. */
  stats(): Promise<VaultStats>;
  /** Desk price, fee and whether the price is fresh. */
  desk(): Promise<DeskState>;
  /** A user's balances and savings value. */
  position(user: Address): Promise<Position>;
  quoteDeposit(usd: bigint, slippageBps?: number): Promise<{ pot: bigint; shares: bigint; minShares: bigint }>;
  quoteWithdraw(shares: bigint, slippageBps?: number): Promise<{ pot: bigint; usd: bigint; minUsd: bigint }>;
  depositNative(amount: bigint, receiver?: Address): Promise<TxResult>;
  depositStable(usd: bigint, opts?: SendOpts): Promise<TxResult>;
  withdrawToStable(shares: bigint, opts?: SendOpts): Promise<TxResult>;
  requestUnstake(shares: bigint, receiver?: Address): Promise<TxResult>;
  faucet(asset: Stable, amount: bigint): Promise<TxResult>;
  ensureAllowance(token: Address, spender: Address, amount: bigint, abi?: Abi): Promise<TxResult | null>;
  /** Low-level: send any write with Portaldot defaults and get a TxResult back. */
  send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint): Promise<TxResult>;
}

/**
 * A client for PortaStake Shield on Portaldot: vault and desk reads, deposits, withdrawals and
 * faucets. Mandates and the keeper live in `mandates(...)` and `runKeeperPass(...)`.
 */
export function createPortaStake(opts: PortaStakeOptions = {}): PortaStake {
  const chainId = opts.chainId ?? opts.publicClient?.chain?.id ?? CHAIN_ID;
  const addresses = getAddresses(chainId, opts.addresses);
  const explorer = opts.explorer ?? DEFAULT_EXPLORER;
  const publicClient =
    opts.publicClient ??
    (createPublicClient({ chain: portaldotChain(opts.rpc), transport: http(opts.rpc, { retryCount: 2 }) }) as PublicClient);
  const walletClient = opts.walletClient;

  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;

  function wallet() {
    if (!walletClient?.account) throw new Error("this call needs a walletClient with an account");
    return { wc: walletClient, account: walletClient.account };
  }

  async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint): Promise<TxResult> {
    const { wc, account } = wallet();
    const hash = await wc.writeContract({
      ...LEGACY_TX,
      address,
      abi,
      functionName,
      args,
      value,
      account,
      chain: wc.chain ?? publicClient.chain,
    } as Parameters<typeof wc.writeContract>[0]);
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return { hash, blockNumber: r.blockNumber, status: r.status, explorerUrl: blockUrl(r.blockNumber, explorer) };
  }

  const stableAddress = (s: Stable) => (s === "xUSD" ? addresses.xUSD : addresses.tUSD);
  const stableAbi = (s: Stable) => (s === "xUSD" ? X402DollarAbi : MockStableAbi) as Abi;

  /** Approves `spender` for `amount` of `token` if the current allowance is lower. */
  async function ensureAllowance(token: Address, spender: Address, amount: bigint, abi: Abi = MockStableAbi as Abi) {
    const { account } = wallet();
    const current = await read<bigint>(token, abi, "allowance", [account.address, spender]);
    if (current >= amount) return null;
    return send(token, abi, "approve", [spender, maxUint256]);
  }

  async function stats(): Promise<VaultStats> {
    const v = addresses.StakingVault;
    const vault = StakingVaultAbi as Abi;
    const [totalAssets, totalSupply, targetRateBps, effectiveRateBps, availableLiquidity, insuranceBalance, reserveBalance] =
      await Promise.all([
        read<bigint>(v, vault, "totalAssets"),
        read<bigint>(v, vault, "totalSupply"),
        read<bigint>(v, vault, "targetRateBps"),
        read<bigint>(v, vault, "lastEffectiveRateBps"),
        read<bigint>(v, vault, "availableLiquidity"),
        read<bigint>(addresses.InsuranceFund, InsuranceFundAbi as Abi, "balance"),
        read<bigint>(addresses.StabilizationReserve, StabilizationReserveAbi as Abi, "balance"),
      ]);
    const exchangeRate = totalSupply > 0n ? (totalAssets * 10n ** 18n) / totalSupply : 10n ** 18n;
    return { totalAssets, totalSupply, exchangeRate, targetRateBps, effectiveRateBps, availableLiquidity, insuranceBalance, reserveBalance };
  }

  async function desk(): Promise<DeskState> {
    const d = addresses.SwapDesk;
    const abi = SwapDeskAbi as Abi;
    const [price, updatedAt, maxAge, feeBps, block] = await Promise.all([
      read<bigint>(d, abi, "price"),
      read<bigint>(d, abi, "updatedAt"),
      read<bigint>(d, abi, "maxAge"),
      read<bigint>(d, abi, "feeBps"),
      publicClient.getBlock(),
    ]);
    return { price, updatedAt, maxAge, feeBps, fresh: price > 0n && block.timestamp <= updatedAt + maxAge };
  }

  async function position(user: Address): Promise<Position> {
    const vault = StakingVaultAbi as Abi;
    const [native, stPot, tUSD, xUSD, d] = await Promise.all([
      publicClient.getBalance({ address: user }),
      read<bigint>(addresses.StakingVault, vault, "balanceOf", [user]),
      read<bigint>(addresses.tUSD, MockStableAbi as Abi, "balanceOf", [user]),
      isDeployed(addresses.xUSD) ? read<bigint>(addresses.xUSD, X402DollarAbi as Abi, "balanceOf", [user]) : Promise.resolve(0n),
      desk(),
    ]);
    const pot = stPot > 0n ? await read<bigint>(addresses.StakingVault, vault, "convertToAssets", [stPot]) : 0n;
    const usd = (pot * d.price) / 10n ** 30n; // 18dp POT × 18dp price → 6dp USD
    return { user, native, stPot, pot, usd, tUSD, xUSD };
  }

  /** stPOT you get for `usd` (6 decimals) of tUSD or xUSD, and the floor after `slippageBps`. */
  async function quoteDeposit(usd: bigint, slippageBps = 50) {
    const pot = await read<bigint>(addresses.SwapDesk, SwapDeskAbi as Abi, "quotePotForUsd", [usd]);
    const shares = await read<bigint>(addresses.StakingVault, StakingVaultAbi as Abi, "previewDeposit", [pot]);
    return { pot, shares, minShares: (shares * (BPS - BigInt(slippageBps))) / BPS };
  }

  /** USD (6 decimals) you get for `shares` stPOT, and the floor after `slippageBps`. */
  async function quoteWithdraw(shares: bigint, slippageBps = 50) {
    const pot = await read<bigint>(addresses.StakingVault, StakingVaultAbi as Abi, "previewRedeem", [shares]);
    const usd = await read<bigint>(addresses.SwapDesk, SwapDeskAbi as Abi, "quoteUsdForPot", [pot]);
    return { pot, usd, minUsd: (usd * (BPS - BigInt(slippageBps))) / BPS };
  }

  /** Stake native tPOT (wei) and receive stPOT. */
  async function depositNative(amount: bigint, receiver?: Address) {
    const to = receiver ?? wallet().account.address;
    return send(addresses.StakingVault, StakingVaultAbi as Abi, "depositNative", [to], amount);
  }

  /** Save `usd` (6 decimals) of tUSD or xUSD as stPOT. Approves the desk or gateway first if needed. */
  async function depositStable(usd: bigint, opts: { asset?: Stable; slippageBps?: number; receiver?: Address } = {}) {
    const asset = opts.asset ?? "tUSD";
    const to = opts.receiver ?? wallet().account.address;
    const { minShares } = await quoteDeposit(usd, opts.slippageBps);
    if (asset === "xUSD") {
      await ensureAllowance(addresses.xUSD, addresses.XusdGateway, usd, stableAbi(asset));
      return send(addresses.XusdGateway, XusdGatewayAbi as Abi, "depositXusd", [usd, minShares, to]);
    }
    await ensureAllowance(addresses.tUSD, addresses.SwapDesk, usd, stableAbi(asset));
    return send(addresses.SwapDesk, SwapDeskAbi as Abi, "depositWithStable", [usd, minShares, to]);
  }

  /** Withdraw `shares` stPOT as tUSD or xUSD. Approves the desk or gateway for stPOT first if needed. */
  async function withdrawToStable(shares: bigint, opts: { asset?: Stable; slippageBps?: number; receiver?: Address } = {}) {
    const asset = opts.asset ?? "tUSD";
    const to = opts.receiver ?? wallet().account.address;
    const { minUsd } = await quoteWithdraw(shares, opts.slippageBps);
    const vault = StakingVaultAbi as Abi;
    if (asset === "xUSD") {
      await ensureAllowance(addresses.StakingVault, addresses.XusdGateway, shares, vault);
      return send(addresses.XusdGateway, XusdGatewayAbi as Abi, "withdrawToXusd", [shares, minUsd, to]);
    }
    await ensureAllowance(addresses.StakingVault, addresses.SwapDesk, shares, vault);
    return send(addresses.SwapDesk, SwapDeskAbi as Abi, "redeemToStable", [shares, minUsd, to]);
  }

  /** Queue `shares` stPOT for unstaking back to native tPOT. */
  async function requestUnstake(shares: bigint, receiver?: Address) {
    const to = receiver ?? wallet().account.address;
    return send(addresses.StakingVault, StakingVaultAbi as Abi, "requestUnstake", [shares, to]);
  }

  /** Mint test tUSD or xUSD (6 decimals) to the wallet. Testnet only. */
  async function faucet(asset: Stable, amount: bigint) {
    return send(stableAddress(asset), stableAbi(asset), "faucet", [amount]);
  }

  return {
    chainId,
    addresses,
    explorer,
    publicClient,
    walletClient,
    stats,
    desk,
    position,
    quoteDeposit,
    quoteWithdraw,
    depositNative,
    depositStable,
    withdrawToStable,
    requestUnstake,
    faucet,
    ensureAllowance,
    send,
  };
}

export { MandateManagerAbi } from "../abi/MandateManager.js";
