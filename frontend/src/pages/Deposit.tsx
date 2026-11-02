import { useMemo, useState } from "react";
import { parseUnits, maxUint256 } from "viem";
import { useProtocol } from "../hooks/useProtocol";
import { useAllowance } from "../hooks/useAllowance";
import { formatPot, formatUsd, applyFee, timeAgo } from "../format";
import { AmountInput } from "../components/AmountInput";
import { SlippageControl } from "../components/SlippageControl";
import { TxButton } from "../components/TxButton";
import { GlassCard, Card, Section, KeyValue, Divider } from "../components/primitives";
import { MockStableAbi } from "../abi/MockStable";
import { SwapDeskAbi } from "../abi/SwapDesk";
import { StakingVaultAbi } from "../abi/StakingVault";

const BPS = 10_000n;

export function Deposit() {
  const p = useProtocol();
  const [mode, setMode] = useState<"usd" | "native">("usd");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  const allowance = useAllowance(p.addresses.tUSD, p.addresses.SwapDesk);

  const parsed = useMemo(() => {
    if (!amount) return 0n;
    try {
      return parseUnits(amount, mode === "usd" ? 6 : 18);
    } catch {
      return 0n;
    }
  }, [amount, mode]);

  // Quote: USD → gross POT → fee → net POT; stPOT shares ≈ net POT at bootstrap.
  const quote = useMemo(() => {
    if (parsed === 0n || !p.desk.price || !p.desk.feeBps) return undefined;
    if (mode === "usd") {
      // USD at 6dp → scale to 18dp → ÷ price
      const usd18 = parsed * 10n ** 12n;
      const gross = (usd18 * 10n ** 18n) / p.desk.price;
      const net = applyFee(gross, p.desk.feeBps);
      const min = (net * (BPS - BigInt(slippageBps))) / BPS;
      return { gross, net, min };
    }
    // Native tPOT path: no price conversion, deposit is 1:1 into shares at bootstrap.
    const shares = parsed;
    const min = (shares * (BPS - BigInt(slippageBps))) / BPS;
    return { gross: shares, net: shares, min };
  }, [parsed, p.desk.price, p.desk.feeBps, mode, slippageBps]);

  const needsApproval = mode === "usd" && parsed > 0n && allowance < parsed;
  const now = Math.floor(Date.now() / 1000);
  const priceStale =
    p.desk.updatedAt !== undefined &&
    p.desk.maxAge !== undefined &&
    BigInt(now) > p.desk.updatedAt + p.desk.maxAge;

  return (
    <>
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Deposit</h1>
          <p className="text-sm text-fg-muted mb-5">
            Pay with tUSD and we handle the swap into stPOT. Yield accrues immediately.
          </p>

          <div className="flex gap-1 mb-5">
            <button
              onClick={() => setMode("usd")}
              className={`chip ${mode === "usd" ? "border-fg text-fg" : ""}`}
            >
              tUSD
            </button>
            <button
              onClick={() => setMode("native")}
              className={`chip ${mode === "native" ? "border-fg text-fg" : ""}`}
            >
              Native tPOT
            </button>
          </div>

          <AmountInput
            label={mode === "usd" ? "You pay" : "You deposit"}
            symbol={mode === "usd" ? "tUSD" : "tPOT"}
            decimals={mode === "usd" ? 6 : 18}
            value={amount}
            onChange={setAmount}
            max={mode === "usd" ? p.usdBalance : p.native}
            helper={
              mode === "usd" && p.desk.updatedAt
                ? `Price fed ${timeAgo(p.desk.updatedAt)}`
                : undefined
            }
          />

          <div className="mt-4">
            <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
          </div>

          <Divider className="my-5" />

          <KeyValue
            label="You receive"
            value={quote ? `${formatPot(quote.net)} stPOT` : "—"}
          />
          <KeyValue
            label="Fee"
            value={
              p.desk.feeBps !== undefined ? `${(Number(p.desk.feeBps) / 100).toFixed(2)}%` : "—"
            }
          />
          <KeyValue
            label="Minimum (after slippage)"
            value={quote ? `${formatPot(quote.min)} stPOT` : "—"}
          />
          {priceStale && (
            <p className="mt-3 text-xs text-danger">Price feed is stale. Wait for the next update before depositing.</p>
          )}
        </GlassCard>
      </Section>

      <Section>
        {mode === "usd" && needsApproval && (
          <Card className="mb-3">
            <p className="text-sm text-fg-muted mb-3">The desk needs permission to spend your tUSD once.</p>
            <TxButton
              label="Approve tUSD"
              address={p.addresses.tUSD}
              abi={MockStableAbi}
              functionName="approve"
              args={[p.addresses.SwapDesk, maxUint256]}
            />
          </Card>
        )}

        <Card>
          {mode === "usd" ? (
            <TxButton
              label={`Deposit ${amount || "0"} tUSD`}
              address={p.addresses.SwapDesk}
              abi={SwapDeskAbi}
              functionName="depositWithStable"
              args={[parsed, quote?.min ?? 0n, p.user ?? "0x0000000000000000000000000000000000000000"]}
              disabled={!quote || parsed === 0n || needsApproval || priceStale || !p.user}
              onSuccess={() => {
                setAmount("");
                p.refetch();
              }}
            />
          ) : (
            <TxButton
              label={`Deposit ${amount || "0"} tPOT`}
              address={p.addresses.StakingVault}
              abi={StakingVaultAbi}
              functionName="depositNative"
              args={[p.user ?? "0x0000000000000000000000000000000000000000"]}
              value={parsed}
              disabled={parsed === 0n || !p.user}
              onSuccess={() => {
                setAmount("");
                p.refetch();
              }}
            />
          )}
        </Card>
      </Section>

      {p.user && (
        <Section title="Your balances">
          <Card>
            <KeyValue label="tUSD" value={formatUsd(p.usdBalance)} />
            <KeyValue label="Native tPOT" value={formatPot(p.native)} />
            <KeyValue label="stPOT" value={formatPot(p.stPotBalance)} />
          </Card>
        </Section>
      )}
    </>
  );
}
