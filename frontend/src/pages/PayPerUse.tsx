import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useWalletClient } from "wagmi";
import { Link } from "react-router-dom";
import type { Address } from "viem";
import { CheckCircle2, Loader2, AlertCircle, Zap, Receipt, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { isDeployed } from "../addresses";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { useProtocol } from "../hooks/useProtocol";
import { useX402Payments } from "../hooks/useX402Payments";
import { X402DollarAbi } from "../abi/X402Dollar";
import { TxButton } from "../components/TxButton";
import { TxLink, AddressLink } from "../components/ExplorerLink";
import { WalletGate } from "../components/WalletGate";
import { GlassCard, Card, Section, KeyValue, Divider, Empty, Button } from "../components/primitives";
import { formatUsd, timeAgo } from "../format";

const API_URL = (import.meta.env.VITE_X402_API_URL as string | undefined) ?? "http://localhost:4021";
const ENDPOINT = `${API_URL}/api/vault-stats`;
const FAUCET_AMOUNT = 10_000_000n; // 10 xUSD
const MAX_PER_REQUEST = "1000000"; // the wallet never signs more than 1 xUSD for one request

type Offer = { amount: bigint; payTo: Address; asset: Address; network: string; description?: string };
type Step = "idle" | "signing" | "settling" | "done" | "error";

/** x402: pay-per-request APIs, settled in xUSD on Portaldot. */
export function PayPerUse() {
  const p = useProtocol();
  const { address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const xusd = p.addresses.xUSD;
  const live = xusd !== "0x0000000000000000000000000000000000000000";

  const { data: bal, refetch: refetchBal } = useReadContract({
    address: live && address ? xusd : undefined,
    abi: X402DollarAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: live && !!address, refetchInterval: 8_000 },
  });
  const balance = (bal as bigint | undefined) ?? 0n;

  // What the API asks for: a plain GET returns 402 with the requirements in PAYMENT-REQUIRED.
  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerErr, setOfferErr] = useState<string | null>(null);
  const loadOffer = useCallback(async () => {
    setOfferErr(null);
    try {
      const r = await fetch(ENDPOINT);
      const header = r.headers.get("PAYMENT-REQUIRED");
      if (r.status !== 402 || !header) throw new Error(`expected 402, got ${r.status}`);
      const req = decodePaymentRequiredHeader(header);
      const a = req.accepts.find((x) => x.network === `eip155:${chainId ?? 420420777}`) ?? req.accepts[0];
      setOffer({
        amount: BigInt(a.amount),
        payTo: a.payTo as Address,
        asset: a.asset as Address,
        network: a.network,
        description: req.resource?.description,
      });
    } catch (e) {
      setOffer(null);
      setOfferErr(e instanceof Error ? e.message : String(e));
    }
  }, [chainId]);
  useEffect(() => {
    void loadOffer();
  }, [loadOffer]);

  const [step, setStep] = useState<Step>("idle");
  const [result, setResult] = useState<unknown>(null);
  const [settleTx, setSettleTx] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const history = useX402Payments(xusd, address, refreshKey);

  const payFetch = useMemo(() => {
    if (!walletClient || !live) return null;
    const account = walletClient.account;
    const signer = {
      address: account.address,
      signTypedData: (msg: Parameters<typeof walletClient.signTypedData>[0]) =>
        walletClient.signTypedData({ ...msg, account }),
    };
    const network = `eip155:${walletClient.chain.id}` as const;
    const client = x402Client.fromConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schemes: [{ network, client: new ExactEvmScheme(signer as any) }],
      spendControls: { allowedAssets: [{ network, asset: xusd, maxAmountPerPayment: MAX_PER_REQUEST }] },
    });
    // Signing happens inside the wrapped fetch; flag it so the button shows "Confirm in wallet".
    const tracked: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT")) setStep("settling");
      return fetch(input, init);
    };
    return wrapFetchWithPayment(tracked, client);
  }, [walletClient, live, xusd]);

  async function pay() {
    if (!payFetch) return;
    setStep("signing");
    setPayErr(null);
    setResult(null);
    setSettleTx(null);
    try {
      const r = await payFetch(ENDPOINT);
      if (!r.ok) throw new Error(`API answered ${r.status}`);
      setResult(await r.json());
      const h = r.headers.get("PAYMENT-RESPONSE") ?? r.headers.get("X-PAYMENT-RESPONSE");
      if (h) setSettleTx(decodePaymentResponseHeader(h).transaction ?? null);
      setStep("done");
      void refetchBal();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setStep("error");
      const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
      setPayErr(msg.split("\n")[0]);
    }
  }

  if (!live) {
    return (
      <Section>
        <GlassCard>
          <Empty icon={<Zap size={20} aria-hidden />} title="Pay per use isn't live on this network yet" />
        </GlassCard>
      </Section>
    );
  }

  const busy = step === "signing" || step === "settling";
  const short = !!address && offer !== null && balance < offer.amount;

  return (
    <WalletGate action="pay for API calls">
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">Pay per use</h1>
          <p className="text-sm text-fg-muted mb-5">
            APIs that charge per request with x402. Your wallet signs a one-off xUSD payment, the API answers, and the
            payment settles on Portaldot. You sign, you never pay gas.
          </p>
          <KeyValue label="Your xUSD" value={formatUsd(balance)} />
          <KeyValue label="Spend limit" value={`${formatUsd(BigInt(MAX_PER_REQUEST))} xUSD per request`} />
          <Divider className="my-4" />
          <TxButton
            label="Get 10 test xUSD"
            address={xusd}
            abi={X402DollarAbi}
            functionName="faucet"
            args={[FAUCET_AMOUNT]}
            onSuccess={() => void refetchBal()}
          />
          {isDeployed(p.addresses.XusdGateway) && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/withdraw?asset=xusd" className="btn-secondary">
                <ArrowUpFromLine size={14} aria-hidden /> Top up xUSD from savings
              </Link>
              <Link to="/deposit?asset=xusd" className="btn-secondary">
                <ArrowDownToLine size={14} aria-hidden /> Save spare xUSD
              </Link>
            </div>
          )}
        </GlassCard>
      </Section>

      <Section title="Try a paid API">
        <Card>
          <div className="flex items-start gap-3 mb-4">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-sm bg-surface border border-line shrink-0">
              <Zap size={16} aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="text-sm text-fg">Live vault stats</div>
              <div className="text-xs text-fg-muted num truncate">GET {ENDPOINT}</div>
            </div>
          </div>

          {offerErr ? (
            <div className="flex items-start gap-2 text-sm text-danger mb-4">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Couldn't reach the paid API ({offerErr}).{" "}
                <button type="button" onClick={() => void loadOffer()} className="underline">
                  Retry
                </button>
              </span>
            </div>
          ) : (
            <>
              <KeyValue label="Price" value={offer ? `${formatUsd(offer.amount, 4)} xUSD` : "…"} hint="per request" />
              <KeyValue label="Paid to" value={offer ? <AddressLink address={offer.payTo} /> : "…"} />
            </>
          )}

          <div className="mt-4">
            <Button onClick={pay} disabled={!offer || !payFetch || busy || short}>
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {step === "signing" ? "Confirm in wallet…" : "Settling payment…"}
                </>
              ) : offer ? (
                `Pay ${formatUsd(offer.amount, 4)} xUSD and fetch`
              ) : (
                "Pay and fetch"
              )}
            </Button>
            {short && (
              <p className="mt-2 text-xs text-fg-muted">
                Not enough xUSD. Get some from the faucet above, or top up from your savings.
              </p>
            )}
            {payErr && (
              <div className="mt-2 flex items-start gap-2 text-xs text-danger">
                <AlertCircle size={14} className="mt-0.5" aria-hidden />
                <span className="break-all">{payErr}</span>
              </div>
            )}
          </div>

          {step === "done" && result !== null && (
            <div className="mt-5">
              <div className="flex items-center gap-2 text-sm text-success mb-2">
                <CheckCircle2 size={14} aria-hidden /> Paid and delivered
                {settleTx && <TxLink hash={settleTx as `0x${string}`} label="View settlement on explorer" />}
              </div>
              <pre className="num text-xs bg-bg border border-line rounded-sm p-3 overflow-x-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Your payments">
        {history.data.length === 0 ? (
          <Empty
            icon={<Receipt size={20} aria-hidden />}
            title={history.loading ? "Loading…" : "No payments yet."}
            hint={history.loading ? undefined : "Requests you pay for show up here."}
          />
        ) : (
          <Card>
            {history.data.map((h) => (
              <div key={h.txHash} className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0 text-sm">
                <span className="num text-fg">{formatUsd(h.amount, 4)} xUSD</span>
                <span className="text-xs text-fg-muted">→ <AddressLink address={h.to} /></span>
                <TxLink hash={h.txHash} blockNumber={h.blockNumber} />
                <span className="text-xs text-fg-subtle">{h.timestamp ? timeAgo(h.timestamp) : `#${h.blockNumber}`}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </WalletGate>
  );
}
