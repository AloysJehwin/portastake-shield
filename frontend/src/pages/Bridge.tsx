import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseUnits,
  zeroAddress,
  type Hash,
} from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { AlertCircle, CheckCircle2, Clock, Loader2, ShieldCheck } from "lucide-react";
import { addressesFor, bridgeDeployments } from "../addresses";
import { bridgeChains, portaldot, type BridgeChain } from "../chains";
import { applyFee, formatPot, formatUsd } from "../format";
import { AmountInput } from "../components/AmountInput";
import { SlippageControl } from "../components/SlippageControl";
import { TxButton } from "../components/TxButton";
import { Button, Card, Divider, Empty, GlassCard, KeyValue, Section } from "../components/primitives";
import { MockStableAbi } from "../abi/MockStable";
import { StakingVaultAbi } from "../abi/StakingVault";
import { SwapDeskAbi } from "../abi/SwapDesk";
import { TokenBridgeAbi } from "../abi/TokenBridge";
import { WPOTAbi } from "../abi/WPOT";

const BPS = 10_000n;
const FAUCET_AMOUNT = 1_000_000_000n; // 1,000 tUSD
const HISTORY_KEY = "portastake.bridge.transfers";

const hub = bridgeChains.find((c) => c.hub)!;
const live = bridgeChains.filter((c) => bridgeDeployments[c.chainId]);

type Transfer = {
  srcChainId: number;
  dstChainId: number;
  nonce: string;
  amount: string;
  wantsSave: boolean;
  txHash: Hash;
};

function chainById(id: number): BridgeChain | undefined {
  return bridgeChains.find((c) => c.chainId === id);
}

function loadHistory(): Transfer[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(items: Transfer[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 10)));
  } catch {
    // Storage can be blocked; the transfer still completes, it just won't be listed after a reload.
  }
}

export function Bridge() {
  const { address: user } = useAccount();
  const walletChainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();

  // Routes are hub-and-spoke: from a spoke you can only go to Portaldot, from Portaldot to any spoke.
  const spokes = live.filter((c) => !c.hub);
  const [srcId, setSrcId] = useState(spokes[0]?.chainId ?? hub.chainId);
  const [dstSpokeId, setDstSpokeId] = useState(spokes[0]?.chainId);
  const dstId = srcId === hub.chainId ? dstSpokeId : hub.chainId;
  const src = chainById(srcId)!;
  const dst = dstId !== undefined ? chainById(dstId) : undefined;
  const srcDep = bridgeDeployments[srcId];
  const dstDep = dstId !== undefined ? bridgeDeployments[dstId] : undefined;

  const [amount, setAmount] = useState("");
  const [saveIt, setSaveIt] = useState(true);
  const [slippageBps, setSlippageBps] = useState(50);
  const [transfers, setTransfers] = useState<Transfer[]>(loadHistory);

  const parsed = useMemo(() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  const onSource = walletChainId === srcId;
  const savingIn = dstId === hub.chainId && saveIt;

  const token = srcDep?.token ?? zeroAddress;
  const balance = useReadContract({
    chainId: srcId,
    address: token,
    abi: MockStableAbi,
    functionName: "balanceOf",
    args: [user ?? zeroAddress],
    query: { enabled: !!srcDep && !!user, refetchInterval: 10_000 },
  });
  const allowance = useReadContract({
    chainId: srcId,
    address: token,
    abi: MockStableAbi,
    functionName: "allowance",
    args: [user ?? zeroAddress, srcDep?.TokenBridge ?? zeroAddress],
    query: { enabled: !!srcDep && !!user },
  });
  const maxPerTx = useReadContract({
    chainId: srcId,
    address: srcDep?.TokenBridge ?? zeroAddress,
    abi: TokenBridgeAbi,
    functionName: "maxPerTx",
    query: { enabled: !!srcDep },
  });
  const dstLiquidity = useReadContract({
    chainId: dstId,
    address: dstDep?.token ?? zeroAddress,
    abi: MockStableAbi,
    functionName: "balanceOf",
    args: [dstDep?.TokenBridge ?? zeroAddress],
    query: { enabled: !!dstDep, refetchInterval: 15_000 },
  });

  const hubAddresses = addressesFor(portaldot.id);
  const quote = useSaveQuote(parsed, savingIn, slippageBps, hubAddresses);

  const usdBalance = balance.data as bigint | undefined;
  const approved = (allowance.data as bigint | undefined) ?? 0n;
  const cap = maxPerTx.data as bigint | undefined;
  const liquidity = dstLiquidity.data as bigint | undefined;

  const overBalance = usdBalance !== undefined && parsed > usdBalance;
  const overCap = cap !== undefined && parsed > cap;
  // Tokens locked here can't come back on their own, so never lock more than the far side can pay.
  const overLiquidity = liquidity !== undefined && parsed > liquidity;
  const blocker = overBalance
    ? "That is more than you hold on this chain."
    : overCap
      ? `The limit is ${formatUsd(cap)} per transfer.`
      : overLiquidity
        ? `${dst?.name} can only pay out ${formatUsd(liquidity)} right now.`
        : undefined;

  const { writeContract, data: lockHash, isPending: signing, error: lockError, reset } = useWriteContract();
  const lockReceipt = useWaitForTransactionReceipt({ hash: lockHash, chainId: srcId });

  useEffect(() => {
    const receipt = lockReceipt.data;
    if (!receipt || !lockHash || dstId === undefined) return;
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({ abi: TokenBridgeAbi, data: log.data, topics: log.topics });
        if (event.eventName !== "Locked") continue;
        const next: Transfer = {
          srcChainId: srcId,
          dstChainId: dstId,
          nonce: event.args.nonce.toString(),
          amount: event.args.amount.toString(),
          wantsSave: event.args.minShares > 0n,
          txHash: lockHash,
        };
        setTransfers((prev) => {
          const items = [next, ...prev.filter((t) => t.txHash !== lockHash)];
          saveHistory(items);
          return items;
        });
        setAmount("");
        reset();
        balance.refetch();
        allowance.refetch();
        return;
      } catch {
        // Not one of the bridge's events (the token's Transfer, for one).
      }
    }
  }, [lockReceipt.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = signing || (!!lockHash && lockReceipt.isLoading);
  const minShares = savingIn ? (quote?.minShares ?? 0n) : 0n;

  if (live.length < 2) {
    return (
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Bridge</h1>
          <Empty title="Bridge not deployed yet" hint="Run scripts/deploy-bridge.mjs, then pnpm sync-abis." />
        </GlassCard>
      </Section>
    );
  }

  return (
    <>
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Bring money from another chain</h1>
          <p className="text-sm text-fg-muted mb-5">
            Send tUSD to Portaldot and put it to work in one step. Your stPOT arrives in this wallet.
          </p>

          <div className="grid grid-cols-2 gap-3 mb-5">
            <ChainSelect
              label="From"
              value={srcId}
              chains={live}
              onChange={(id) => {
                setSrcId(id);
                setAmount("");
              }}
            />
            {srcId === hub.chainId ? (
              <ChainSelect label="To" value={dstSpokeId ?? 0} chains={spokes} onChange={setDstSpokeId} />
            ) : (
              <ChainSelect label="To" value={hub.chainId} chains={[hub]} onChange={() => {}} />
            )}
          </div>

          <AmountInput
            label="You send"
            symbol="tUSD"
            decimals={6}
            value={amount}
            onChange={setAmount}
            max={usdBalance}
          />

          {dstId === hub.chainId && (
            <label className="mt-4 flex items-start gap-3 text-sm text-fg cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={saveIt}
                onChange={(e) => setSaveIt(e.target.checked)}
              />
              <span>
                Save it when it arrives
                <span className="block text-xs text-fg-muted">
                  Earns the 8% target in POT, with slashing insurance. The USD value moves with the POT price.
                </span>
              </span>
            </label>
          )}

          {savingIn && (
            <div className="mt-4">
              <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
            </div>
          )}

          <Divider className="my-5" />

          <KeyValue
            label="You receive"
            value={
              parsed === 0n
                ? "—"
                : savingIn
                  ? quote
                    ? `~${formatPot(quote.shares)} stPOT`
                    : "—"
                  : `${formatUsd(parsed)} tUSD`
            }
          />
          <KeyValue label="Arrives on" value={dst?.name ?? "—"} />
          {savingIn && quote?.reasonNotSaved && parsed > 0n && (
            <p className="mt-3 text-xs text-danger">
              {quote.reasonNotSaved} If that is still true when it lands, you will receive tUSD and can save it later.
            </p>
          )}
          {blocker && parsed > 0n && <p className="mt-3 text-xs text-danger">{blocker}</p>}
        </GlassCard>
      </Section>

      <Section>
        <Card className="space-y-3">
          {!onSource ? (
            <Button onClick={() => switchChain({ chainId: srcId })} disabled={switching || !user}>
              {switching ? "Check your wallet…" : user ? `Switch to ${src.name}` : "Connect your wallet"}
            </Button>
          ) : (
            <>
              {!src.hub && usdBalance === 0n && (
                <TxButton
                  label={`Get 1,000 test tUSD on ${src.name}`}
                  address={token}
                  abi={MockStableAbi}
                  functionName="faucet"
                  args={[FAUCET_AMOUNT]}
                  onSuccess={() => balance.refetch()}
                />
              )}
              {parsed > 0n && approved < parsed ? (
                <TxButton
                  label="Allow the bridge to use your tUSD"
                  address={token}
                  abi={MockStableAbi}
                  functionName="approve"
                  args={[srcDep.TokenBridge, parsed]}
                  onSuccess={() => allowance.refetch()}
                />
              ) : (
                <Button
                  disabled={parsed === 0n || !!blocker || busy || !user || !dstId || (savingIn && !quote)}
                  onClick={() =>
                    writeContract({
                      address: srcDep.TokenBridge,
                      abi: TokenBridgeAbi,
                      functionName: "bridge",
                      args: [BigInt(dstId!), user!, parsed, minShares],
                    })
                  }
                >
                  {busy ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {signing ? "Confirm in wallet…" : "Submitting…"}
                    </>
                  ) : savingIn ? (
                    `Send and save ${amount || "0"} tUSD`
                  ) : (
                    `Send ${amount || "0"} tUSD`
                  )}
                </Button>
              )}
            </>
          )}
          {lockError && (
            <div className="flex items-start gap-2 text-xs text-danger">
              <AlertCircle size={14} className="mt-0.5" aria-hidden />
              <span className="truncate">{(lockError as { shortMessage?: string }).shortMessage ?? lockError.message}</span>
            </div>
          )}
        </Card>
      </Section>

      {transfers.length > 0 && (
        <Section title="Your transfers">
          <div className="space-y-3">
            {transfers.map((t) => (
              <TransferRow key={t.txHash} transfer={t} />
            ))}
          </div>
        </Section>
      )}

      <Section title="How much to trust this">
        <Card>
          <p className="text-sm text-fg-muted">
            This is a testnet bridge run by a small signer committee: its signers could release the tUSD it holds. Keep
            transfers small. A real deployment would move to a larger committee and light-client proofs.
          </p>
        </Card>
      </Section>
    </>
  );
}

function ChainSelect({
  label,
  value,
  chains,
  onChange,
}: {
  label: string;
  value: number;
  chains: BridgeChain[];
  onChange: (id: number) => void;
}) {
  return (
    <label className="block text-xs text-fg-muted">
      <span className="block mb-1.5">{label}</span>
      <select className="input w-full text-sm text-fg" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {chains.map((c) => (
          <option key={c.chainId} value={c.chainId}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What a save would produce, read from Portaldot whatever chain the wallet is on. */
function useSaveQuote(
  usdAmount: bigint,
  enabled: boolean,
  slippageBps: number,
  a: ReturnType<typeof addressesFor>,
) {
  const read = { chainId: portaldot.id, query: { enabled, refetchInterval: 30_000 } };
  const price = useReadContract({ ...read, address: a.SwapDesk, abi: SwapDeskAbi, functionName: "price" });
  const feeBps = useReadContract({ ...read, address: a.SwapDesk, abi: SwapDeskAbi, functionName: "feeBps" });
  const updatedAt = useReadContract({ ...read, address: a.SwapDesk, abi: SwapDeskAbi, functionName: "updatedAt" });
  const maxAge = useReadContract({ ...read, address: a.SwapDesk, abi: SwapDeskAbi, functionName: "maxAge" });
  const inventory = useReadContract({
    ...read,
    address: a.WPOT,
    abi: WPOTAbi,
    functionName: "balanceOf",
    args: [a.SwapDesk],
  });

  const pot = useMemo(() => {
    if (usdAmount === 0n || !price.data || feeBps.data === undefined) return undefined;
    const gross = (usdAmount * 10n ** 12n * 10n ** 18n) / (price.data as bigint);
    return applyFee(gross, feeBps.data as bigint);
  }, [usdAmount, price.data, feeBps.data]);

  const preview = useReadContract({
    ...read,
    address: a.StakingVault,
    abi: StakingVaultAbi,
    functionName: "previewDeposit",
    args: [pot ?? 0n],
    query: { enabled: enabled && pot !== undefined },
  });

  if (pot === undefined || preview.data === undefined) return undefined;
  const shares = preview.data as bigint;
  const stale =
    updatedAt.data !== undefined &&
    maxAge.data !== undefined &&
    BigInt(Math.floor(Date.now() / 1000)) > (updatedAt.data as bigint) + (maxAge.data as bigint);
  const short = inventory.data !== undefined && pot > (inventory.data as bigint);
  return {
    shares,
    // Never zero: a zero minShares is what tells the bridge not to save at all.
    minShares: ((shares * (BPS - BigInt(slippageBps))) / BPS) || 1n,
    reasonNotSaved: stale
      ? "The savings price is out of date."
      : short
        ? `Savings can only take about ${formatPot(inventory.data as bigint)} POT right now.`
        : undefined,
  };
}

function TransferRow({ transfer: t }: { transfer: Transfer }) {
  const srcChain = chainById(t.srcChainId);
  const dstChain = chainById(t.dstChainId);
  const dstDep = bridgeDeployments[t.dstChainId];
  const client = usePublicClient({ chainId: t.dstChainId });
  const [shares, setShares] = useState<bigint>();

  const id = useMemo(
    () =>
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint64" }],
          [BigInt(t.srcChainId), BigInt(t.nonce)],
        ),
      ),
    [t.srcChainId, t.nonce],
  );

  const processed = useReadContract({
    chainId: t.dstChainId,
    address: dstDep?.TokenBridge ?? zeroAddress,
    abi: TokenBridgeAbi,
    functionName: "processed",
    args: [id],
    query: {
      enabled: !!dstDep,
      refetchInterval: (q) => (q.state.data ? false : 6_000),
    },
  });
  const delivered = processed.data === true;

  useEffect(() => {
    if (!delivered || !client || !dstDep || !t.wantsSave) return;
    let cancelled = false;
    client
      .getContractEvents({
        address: dstDep.TokenBridge,
        abi: TokenBridgeAbi,
        eventName: "Released",
        args: { id },
        fromBlock: BigInt(dstDep.deployBlock),
      })
      .then((logs) => {
        if (!cancelled && logs[0]) setShares(logs[0].args.shares);
      })
      .catch(() => {
        // Public RPCs can refuse wide log ranges; the row still shows the transfer as delivered.
      });
    return () => {
      cancelled = true;
    };
  }, [delivered, client, dstDep, t.wantsSave, id]);

  const outcome = !delivered ? (
    <span className="inline-flex items-center gap-1.5 text-fg-muted">
      <Clock size={14} aria-hidden /> Waiting for {srcChain?.name} to confirm
    </span>
  ) : shares !== undefined && shares > 0n ? (
    <span className="inline-flex items-center gap-1.5 text-fg">
      <ShieldCheck size={14} aria-hidden /> Saving: {formatPot(shares)} stPOT
    </span>
  ) : t.wantsSave && shares === 0n ? (
    <span className="text-fg">
      Arrived as tUSD.{" "}
      <Link to="/deposit" className="underline">
        Save it now
      </Link>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-fg">
      <CheckCircle2 size={14} aria-hidden /> Arrived on {dstChain?.name}
    </span>
  );

  return (
    <Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-fg">
          {formatUsd(BigInt(t.amount))} tUSD · {srcChain?.name} → {dstChain?.name}
        </span>
        {srcChain && (
          <a
            href={`${srcChain.explorer}/tx/${t.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-fg-muted underline"
          >
            View
          </a>
        )}
      </div>
      <div className="mt-2 text-sm">{outcome}</div>
    </Card>
  );
}
