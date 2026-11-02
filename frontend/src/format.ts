import { formatUnits } from "viem";

const USD_PRECISION = 6; // MockStable decimals
const POT_PRECISION = 18;
const BPS = 10_000n;

/** Format a tUSD amount (6 dp) as a human string with 2 fractional digits. */
export function formatUsd(wei: bigint | undefined, maxDecimals = 2): string {
  if (wei === undefined) return "—";
  return formatFixed(formatUnits(wei, USD_PRECISION), maxDecimals);
}

/** Format a POT or stPOT amount (18 dp) as a human string with 4 fractional digits by default. */
export function formatPot(wei: bigint | undefined, maxDecimals = 4): string {
  if (wei === undefined) return "—";
  return formatFixed(formatUnits(wei, POT_PRECISION), maxDecimals);
}

/** Format bps as a percent with 2 fractional digits. */
export function formatBps(bps: bigint | undefined, maxDecimals = 2): string {
  if (bps === undefined) return "—";
  const pct = Number(bps) / 100;
  return `${pct.toFixed(maxDecimals)}%`;
}

/** Shorten a 0x-address to `0x1234…abcd`. */
export function shortAddress(address: string | undefined, visible = 4): string {
  if (!address) return "";
  if (address.length < 2 * visible + 2) return address;
  return `${address.slice(0, visible + 2)}…${address.slice(-visible)}`;
}

/** POT at 18dp × price (USD per 1 POT, 18dp) → USD at 6dp. */
export function potToUsd(pot: bigint, priceUsdPerPot: bigint): bigint {
  // (pot * price) / 1e18 is 18dp USD; scale down to 6dp.
  const usd18 = (pot * priceUsdPerPot) / 10n ** 18n;
  return usd18 / 10n ** 12n;
}

/** USD at 6dp × 1e18 / price → POT at 18dp. */
export function usdToPot(usd: bigint, priceUsdPerPot: bigint): bigint {
  if (priceUsdPerPot === 0n) return 0n;
  const usd18 = usd * 10n ** 12n;
  return (usd18 * 10n ** 18n) / priceUsdPerPot;
}

/** Apply a fee in bps (e.g. 30 for 0.30%). */
export function applyFee(x: bigint, feeBps: bigint): bigint {
  return (x * (BPS - feeBps)) / BPS;
}

function formatFixed(value: string, maxDecimals: number): string {
  const [whole, frac = ""] = value.split(".");
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed.length ? `${grouped}.${trimmed}` : grouped;
}

export function timeAgo(unixSec: bigint | number | undefined): string {
  if (unixSec === undefined) return "never";
  const now = Math.floor(Date.now() / 1000);
  const delta = now - Number(unixSec);
  if (delta < 0) return "in the future";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}
