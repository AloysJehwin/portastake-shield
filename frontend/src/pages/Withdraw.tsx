import { useMemo, useState } from "react";
import { maxUint256, parseUnits, type Address } from "viem";
import { useAccount, useChainId, useReadContract, useReadContracts } from "wagmi";
import { useProtocol } from "../hooks/useProtocol";
import { useAllowance } from "../hooks/useAllowance";
import { formatPot, formatUsd, applyFee, shortAddress } from "../format";
import { AmountInput } from "../components/AmountInput";
import { SlippageControl } from "../components/SlippageControl";
import { TxButton } from "../components/TxButton";
import { GlassCard, Card, Section, KeyValue, Divider, Empty } from "../components/primitives";
import { SwapDeskAbi } from "../abi/SwapDesk";
import { StakingVaultAbi } from "../abi/StakingVault";

const BPS = 10_000n;

export function Withdraw() {
  const p = useProtocol();
  const [shares, setShares] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  const allowance = useAllowance(p.addresses.StakingVault, p.addresses.SwapDesk);
  const parsed = useMemo(() => {
    if (!shares) return 0n;
    try {
      return parseUnits(shares, 18);
    } catch {
      return 0n;
    }
  }, [shares]);

  // Instant route: desk.quoteUsdForPot(shares_in_pot) — approximation shares==pot at bootstrap.
  const quote = useMemo(() => {
    if (parsed === 0n || !p.desk.price || !p.desk.feeBps) return undefined;
    const potGross = parsed; // 1:1 at bootstrap
    const usd18 = (potGross * p.desk.price) / 10n ** 18n;
    const grossUsd = usd18 / 10n ** 12n;
    const netUsd = applyFee(grossUsd, p.desk.feeBps);
    const min = (netUsd * (BPS - BigInt(slippageBps))) / BPS;
    return { grossUsd, netUsd, min };
  }, [parsed, p.desk.price, p.desk.feeBps, slippageBps]);

  const maxInstantShares = p.availableLiquidity ?? 0n; // 1:1 approximation
  const needsApproval = parsed > 0n && allowance < parsed;
  const slow = parsed > maxInstantShares;

  return (
    <>
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Withdraw</h1>
          <p className="text-sm text-fg-muted mb-5">
            Instant up to the 10% hot reserve. Larger exits queue an unbond (~168 days on Portaldot V3).
          </p>

          <AmountInput
            label="You redeem"
            symbol="stPOT"
            decimals={18}
            value={shares}
            onChange={setShares}
            max={p.stPotBalance}
          />

          <div className="mt-4">
            <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
          </div>

          <Divider className="my-5" />
          <KeyValue label="You receive" value={quote ? `${formatUsd(quote.netUsd)} tUSD` : "—"} />
          <KeyValue label="Minimum (after slippage)" value={quote ? `${formatUsd(quote.min)} tUSD` : "—"} />
          <KeyValue label="Hot reserve available" value={`${formatPot(maxInstantShares)} tPOT`} />
          {slow && (
            <p className="mt-3 text-xs text-danger">
              Instant route only has {formatPot(maxInstantShares)} tPOT free. The slow unstake queue below handles the rest.
            </p>
          )}
        </GlassCard>
      </Section>

      <Section>
        {needsApproval && !slow && (
          <Card className="mb-3">
            <p className="text-sm text-fg-muted mb-3">Approve the desk to transfer your stPOT once.</p>
            <TxButton
              label="Approve stPOT"
              address={p.addresses.StakingVault}
              abi={StakingVaultAbi}
              functionName="approve"
              args={[p.addresses.SwapDesk, maxUint256]}
            />
          </Card>
        )}

        <Card>
          {!slow ? (
            <TxButton
              label={`Redeem ${shares || "0"} stPOT`}
              address={p.addresses.SwapDesk}
              abi={SwapDeskAbi}
              functionName="redeemToStable"
              args={[parsed, quote?.min ?? 0n, p.user ?? "0x0000000000000000000000000000000000000000"]}
              disabled={!quote || parsed === 0n || needsApproval || !p.user}
              onSuccess={() => {
                setShares("");
                p.refetch();
              }}
            />
          ) : (
            <TxButton
              label={`Request unstake of ${shares} stPOT`}
              address={p.addresses.StakingVault}
              abi={StakingVaultAbi}
              functionName="requestUnstake"
              args={[parsed, p.user ?? "0x0000000000000000000000000000000000000000"]}
              disabled={parsed === 0n || !p.user}
              onSuccess={() => {
                setShares("");
                p.refetch();
              }}
            />
          )}
        </Card>
      </Section>

      <PendingUnstakes vault={p.addresses.StakingVault} />
    </>
  );
}

function PendingUnstakes({ vault }: { vault: Address }) {
  // Reading chainId keeps the hook subscribed when the user switches networks.
  useChainId();
  const { address } = useAccount();

  const { data: count } = useReadContract({
    address: vault !== "0x0000000000000000000000000000000000000000" ? vault : undefined,
    abi: StakingVaultAbi,
    functionName: "unstakeRequestCount",
  });

  const n = Number((count as bigint | undefined) ?? 0n);
  const indices = Array.from({ length: n }, (_, i) => BigInt(i));

  const { data: rows } = useReadContracts({
    allowFailure: true,
    contracts: indices.map((i) => ({
      address: vault,
      abi: StakingVaultAbi,
      functionName: "unstakeRequests" as const,
      args: [i] as const,
    })),
    query: { enabled: n > 0 && !!address },
  });

  const mine =
    rows
      ?.map((r, i) => ({ i, row: r.result as [Address, boolean, bigint] | undefined }))
      .filter(({ row }) => row && row[0]?.toLowerCase() === address?.toLowerCase()) ?? [];

  return (
    <Section title="Pending unstakes">
      {mine.length === 0 ? (
        <Empty title="Nothing in the slow queue." hint="Fast withdrawals land in your wallet in seconds." />
      ) : (
        <Card>
          {mine.map(({ i, row }) => (
            <div key={i} className="flex items-center justify-between py-2 text-sm">
              <span className="num text-fg">
                #{i} · {formatPot(row![2])} tPOT
              </span>
              <span className={row![1] ? "chip-success" : "chip"}>
                {row![1] ? "Fulfilled" : "Pending"}
              </span>
              <span className="text-xs text-fg-subtle num">→ {shortAddress(row![0])}</span>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}
