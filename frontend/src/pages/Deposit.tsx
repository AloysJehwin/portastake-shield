import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { parseUnits, maxUint256 } from "viem";
import { useProtocol } from "../hooks/useProtocol";
import { useAllowance } from "../hooks/useAllowance";
import { formatPot, formatUsd, applyFee, timeAgo } from "../format";
import { AmountInput } from "../components/AmountInput";
import { SlippageControl } from "../components/SlippageControl";
import { TxButton } from "../components/TxButton";
import { WalletGate } from "../components/WalletGate";
import { GlassCard, Card, Section, KeyValue, Divider } from "../components/primitives";
import { MockStableAbi } from "../abi/MockStable";
import { SwapDeskAbi } from "../abi/SwapDesk";
import { StakingVaultAbi } from "../abi/StakingVault";
import { X402DollarAbi } from "../abi/X402Dollar";
import { XusdGatewayAbi } from "../abi/XusdGateway";
import { useTokenBalance } from "../hooks/useTokenBalance";
import { isDeployed } from "../addresses";

const BPS = 10_000n;

export function Deposit() {
  const p = useProtocol();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"usd" | "xusd" | "native">(params.get("asset") === "xusd" ? "xusd" : "usd");
  const gatewayLive = isDeployed(p.addresses.XusdGateway);
  const xusd = useTokenBalance(p.addresses.xUSD, p.user);
  // The gateway pays tUSD into the desk on your behalf, so its tUSD stock caps an xUSD deposit.
  const gatewayStock = useTokenBalance(p.addresses.tUSD, p.addresses.XusdGateway);
  const xusdAllowance = useAllowance(p.addresses.xUSD, p.addresses.XusdGateway);
  const stable = mode === "usd" || mode === "xusd";
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  const allowance = useAllowance(p.addresses.tUSD, p.addresses.SwapDesk);

  const parsed = useMemo(() => {
    if (!amount) return 0n;
    try {
      return parseUnits(amount, stable ? 6 : 18);
    } catch {
      return 0n;
    }
  }, [amount, stable]);

  // Quote: USD → gross POT → fee → net POT; stPOT shares ≈ net POT at bootstrap.
  const quote = useMemo(() => {
    if (parsed === 0n || !p.desk.price || !p.desk.feeBps) return undefined;
    if (stable) {
      // tUSD/xUSD at 6dp (xUSD swaps 1:1 for tUSD at the gateway) → scale to 18dp → ÷ price
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
  }, [parsed, p.desk.price, p.desk.feeBps, stable, slippageBps]);

  const needsApproval =
    parsed > 0n && (mode === "usd" ? allowance < parsed : mode === "xusd" ? xusdAllowance < parsed : false);
  const stockShort = mode === "xusd" && parsed > gatewayStock.balance;
  const now = Math.floor(Date.now() / 1000);
  const priceStale =
    p.desk.updatedAt !== undefined &&
    p.desk.maxAge !== undefined &&
    BigInt(now) > p.desk.updatedAt + p.desk.maxAge;

  return (
    <WalletGate action="deposit">
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Deposit</h1>
          <p className="text-sm text-fg-muted mb-5">
            Pay with tUSD or xUSD and we handle the swap into stPOT. Yield accrues immediately.
          </p>

          <div className="flex gap-1 mb-5">
            <button
              onClick={() => setMode("usd")}
              className={`chip ${mode === "usd" ? "border-fg text-fg" : ""}`}
            >
              tUSD
            </button>
            {gatewayLive && (
              <button
                onClick={() => setMode("xusd")}
                className={`chip ${mode === "xusd" ? "border-fg text-fg" : ""}`}
              >
                xUSD
              </button>
            )}
            <button
              onClick={() => setMode("native")}
              className={`chip ${mode === "native" ? "border-fg text-fg" : ""}`}
            >
              Native tPOT
            </button>
          </div>

          <AmountInput
            label={stable ? "You pay" : "You deposit"}
            symbol={mode === "usd" ? "tUSD" : mode === "xusd" ? "xUSD" : "tPOT"}
            decimals={stable ? 6 : 18}
            value={amount}
            onChange={setAmount}
            max={mode === "usd" ? p.usdBalance : mode === "xusd" ? xusd.balance : p.native}
            helper={
              stable && p.desk.updatedAt
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
          {stockShort && (
            <p className="mt-3 text-xs text-danger">
              The xUSD gateway can take up to {formatUsd(gatewayStock.balance)} right now. Try a smaller amount.
            </p>
          )}
          {priceStale && (
            <p className="mt-3 text-xs text-danger">Price feed is stale. Wait for the next update before depositing.</p>
          )}
        </GlassCard>
      </Section>

      <Section>
        {mode === "xusd" && needsApproval && (
          <Card className="mb-3">
            <p className="text-sm text-fg-muted mb-3">The xUSD gateway needs permission to spend your xUSD once.</p>
            <TxButton
              label="Approve xUSD"
              address={p.addresses.xUSD}
              abi={X402DollarAbi}
              functionName="approve"
              args={[p.addresses.XusdGateway, maxUint256]}
            />
          </Card>
        )}
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
          ) : mode === "xusd" ? (
            <TxButton
              label={`Deposit ${amount || "0"} xUSD`}
              address={p.addresses.XusdGateway}
              abi={XusdGatewayAbi}
              functionName="depositXusd"
              args={[parsed, quote?.min ?? 0n, p.user ?? "0x0000000000000000000000000000000000000000"]}
              disabled={!quote || parsed === 0n || needsApproval || priceStale || stockShort || !p.user}
              onSuccess={() => {
                setAmount("");
                p.refetch();
                void xusd.refetch();
                void gatewayStock.refetch();
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
            {gatewayLive && <KeyValue label="xUSD" value={formatUsd(xusd.balance)} />}
            <KeyValue label="Native tPOT" value={formatPot(p.native)} />
            <KeyValue label="stPOT" value={formatPot(p.stPotBalance)} />
          </Card>
        </Section>
      )}
    </WalletGate>
  );
}
