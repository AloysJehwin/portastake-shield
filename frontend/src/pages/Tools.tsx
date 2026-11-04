import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useReadContract, useWalletClient } from "wagmi";
import { Link } from "react-router-dom";
import { isAddress, type Address, type WalletClient } from "viem";
import { CheckCircle2, Loader2, AlertCircle, Wrench, Receipt, ArrowDownToLine, ArrowUpFromLine, Play } from "lucide-react";
import { createPayingFetch, getOffer, getSettlement, type Offer } from "@portastake/sdk/x402";
import { isDeployed } from "../addresses";
import { useProtocol } from "../hooks/useProtocol";
import { useX402Payments } from "../hooks/useX402Payments";
import { X402DollarAbi } from "../abi/X402Dollar";
import { TxButton } from "../components/TxButton";
import { TxLink, AddressLink } from "../components/ExplorerLink";
import { WalletGate } from "../components/WalletGate";
import { GlassCard, Card, Section, KeyValue, Divider, Empty, Button } from "../components/primitives";
import { formatUsd, timeAgo } from "../format";
import { GatewaySection } from "./Gateway";

// Same origin by default: the tools are Vercel functions of this app (`pnpm tools` in development).
const TOOLS_URL = ((import.meta.env.VITE_TOOLS_URL as string | undefined) ?? "").replace(/\/$/, "");
const FAUCET_AMOUNT = 10_000_000n; // 10 xUSD
const MAX_PER_RUN = 1_000_000n; // the wallet never signs more than 1 xUSD for one run

export type ToolParam = { name: string; label: string; placeholder?: string; fromWallet?: boolean };
export type Tool = {
  id: string;
  name: string;
  summary: string;
  price: string;
  params?: ToolParam[];
  /** Full path for endpoints outside /api/tools (gateway endpoints). */
  endpoint?: string;
  method?: "GET" | "POST";
};
type Catalog = { tools: Tool[]; payTo: Address; live: boolean };
type Step = "idle" | "signing" | "settling" | "done" | "error";

const absolute = (path: string) => (TOOLS_URL || window.location.origin) + path;

/** On-chain tools: small paid endpoints over PortaStake on Portaldot, charged per run in xUSD with x402. */
export function Tools() {
  const p = useProtocol();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const xusd = p.addresses.xUSD;
  const live = isDeployed(xusd);

  const { data: bal, refetch: refetchBal } = useReadContract({
    address: live && address ? xusd : undefined,
    abi: X402DollarAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: live && !!address, refetchInterval: 8_000 },
  });
  const balance = (bal as bigint | undefined) ?? 0n;

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const loadCatalog = useCallback(async () => {
    setCatalogErr(null);
    try {
      const r = await fetch(`${TOOLS_URL}/api/tools/catalog`);
      if (!r.ok) throw new Error(`answered ${r.status}`);
      setCatalog((await r.json()) as Catalog);
    } catch (e) {
      setCatalog(null);
      setCatalogErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const [refreshKey, setRefreshKey] = useState(0);
  const history = useX402Payments(xusd, address, refreshKey);
  const onPaid = useCallback(() => {
    void refetchBal();
    setRefreshKey((k) => k + 1);
  }, [refetchBal]);

  if (!live) {
    return (
      <Section>
        <GlassCard>
          <Empty icon={<Wrench size={20} aria-hidden />} title="On-chain tools aren't live on this network yet" />
        </GlassCard>
      </Section>
    );
  }

  return (
    <WalletGate action="run on-chain tools">
      <Section>
        <GlassCard>
          <h1 className="text-lg text-fg mb-1">On-chain tools</h1>
          <p className="text-sm text-fg-muted mb-5">
            Tools that read PortaStake live on Portaldot and charge per run with x402. Your wallet signs a one-off xUSD
            payment, the tool runs, and the payment settles on Portaldot. You sign; you never pay gas.
          </p>
          <KeyValue label="Your xUSD" value={formatUsd(balance)} />
          <KeyValue label="Spend limit" value={`${formatUsd(MAX_PER_RUN)} xUSD per run`} />
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

      <Section title="Tools">
        {catalogErr || (catalog && !catalog.live) ? (
          <Card>
            <div className="flex items-start gap-2 text-sm text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {catalogErr ? `Couldn't load the tools (${catalogErr}).` : "The tools are offline on this deployment."}{" "}
                <button type="button" onClick={() => void loadCatalog()} className="underline">
                  Retry
                </button>
              </span>
            </div>
          </Card>
        ) : !catalog ? (
          <Card>
            <span className="text-sm text-fg-muted">Loading tools…</span>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {catalog.tools.map((t) => (
              <ToolCard
                key={t.id}
                tool={t}
                balance={balance}
                onPaid={onPaid}
                walletClient={walletClient}
                address={address}
                xusd={xusd}
              />
            ))}
          </div>
        )}
      </Section>

      <GatewaySection
        balance={balance}
        onPaid={onPaid}
        walletClient={walletClient}
        address={address}
        xusd={xusd}
      />

      <Section title="Your runs">
        {history.data.length === 0 ? (
          <Empty
            icon={<Receipt size={20} aria-hidden />}
            title={history.loading ? "Loading…" : "No runs yet."}
            hint={history.loading ? undefined : "Every tool you pay for shows up here with its settlement."}
          />
        ) : (
          <Card>
            {history.data.map((h) => (
              <div key={h.txHash} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 border-b border-line last:border-b-0 text-sm">
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

type ToolCardProps = {
  tool: Tool;
  balance: bigint;
  onPaid: () => void;
  walletClient: WalletClient | undefined;
  address: Address | undefined;
  xusd: Address;
};

export function ToolCard({ tool, balance, onPaid, walletClient, address, xusd, extra }: ToolCardProps & { extra?: ReactNode }) {
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries((tool.params ?? []).map((q) => [q.name, q.fromWallet && address ? address : ""])),
  );
  // Fill wallet-bound inputs once a wallet connects, without overwriting what the user typed.
  useEffect(() => {
    if (!address) return;
    setParams((s) => {
      const next = { ...s };
      for (const q of tool.params ?? []) if (q.fromWallet && !next[q.name]) next[q.name] = address;
      return next;
    });
  }, [address, tool.params]);
  const isPost = tool.method === "POST";
  const { body: postBody = "", query: rawQuery = "", ...named } = params;
  const query = [new URLSearchParams(named).toString(), rawQuery.replace(/^\?/, "")].filter(Boolean).join("&");
  const path = `${tool.endpoint ?? `/api/tools/${tool.id}`}${query ? `?${query}` : ""}`;
  const bodyOk = !isPost || (() => {
    try {
      JSON.parse(postBody || "{}");
      return true;
    } catch {
      return false;
    }
  })();
  const paramsOk = bodyOk && (tool.params ?? []).every((q) => q.name !== "address" || isAddress(params[q.name] ?? ""));

  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerErr, setOfferErr] = useState<string | null>(null);
  useEffect(() => {
    if (!paramsOk) return;
    let gone = false;
    setOffer(null);
    getOffer(`${TOOLS_URL}${path}`, isPost ? { method: "POST", headers: { "content-type": "application/json" }, body: postBody || "{}" } : undefined)
      .then((o) => !gone && (setOffer(o), setOfferErr(null)))
      .catch((e) => !gone && setOfferErr(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [path, paramsOk, isPost, postBody]);

  const [step, setStep] = useState<Step>("idle");
  const [result, setResult] = useState<unknown>(null);
  const [settleTx, setSettleTx] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  const payFetch = useMemo(() => {
    if (!walletClient) return null;
    // Signing happens inside the paying fetch; the retry that carries the signature means settling.
    const tracked: typeof fetch = (input, init) => {
      const h = new Headers(init?.headers);
      if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) setStep("settling");
      return fetch(input, init);
    };
    return createPayingFetch({ payer: walletClient, maxPerRequest: MAX_PER_RUN, asset: xusd, fetch: tracked });
  }, [walletClient, xusd]);

  async function run() {
    if (!payFetch) return;
    setStep("signing");
    setRunErr(null);
    setResult(null);
    setSettleTx(null);
    try {
      const r = await payFetch(
        `${TOOLS_URL}${path}`,
        isPost ? { method: "POST", headers: { "content-type": "application/json" }, body: postBody || "{}" } : undefined,
      );
      if (!r.ok) {
        const detail = await r.json().then((j: { error?: string }) => j.error).catch(() => undefined);
        throw new Error(`the tool answered ${r.status}${detail ? `: ${detail}` : ""}`);
      }
      const text = await r.text();
      try {
        setResult(JSON.parse(text));
      } catch {
        setResult(text);
      }
      setSettleTx(getSettlement(r)?.transaction ?? null);
      setStep("done");
      onPaid();
    } catch (e) {
      setStep("error");
      const msg = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
      setRunErr(msg.split("\n")[0]);
    }
  }

  const busy = step === "signing" || step === "settling";
  const amount = offer?.amount;
  const short = !!address && amount !== undefined && balance < amount;

  return (
    <Card>
      <div className="flex items-start gap-3 mb-3">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-sm bg-surface border border-line shrink-0">
          <Wrench size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg break-words">{tool.name}</div>
          <div className="text-xs text-fg-muted break-words">{tool.summary}</div>
        </div>
        {extra}
      </div>
      <div className="text-xs text-fg-subtle num truncate mb-3" title={absolute(path)}>
        {isPost ? "POST" : "GET"} {absolute(path)}
      </div>

      {(tool.params ?? []).map((q) =>
        q.name === "body" ? (
          <label key={q.name} className="block mb-3">
            <span className="text-xs text-fg-muted">{q.label}</span>
            <textarea
              className="mt-1 w-full min-h-[72px] px-3 py-2 rounded-sm border border-line bg-bg text-xs num"
              value={params.body ?? ""}
              placeholder={q.placeholder}
              onChange={(e) => setParams((s) => ({ ...s, body: e.target.value }))}
            />
            {!bodyOk && <span className="text-xs text-danger">Body must be JSON.</span>}
          </label>
        ) : (
        <label key={q.name} className="block mb-3">
          <span className="text-xs text-fg-muted">{q.label}</span>
          <input
            className="mt-1 w-full h-9 px-3 rounded-sm border border-line bg-bg text-sm num"
            value={params[q.name] ?? ""}
            placeholder={q.placeholder}
            onChange={(e) => setParams((s) => ({ ...s, [q.name]: e.target.value.trim() }))}
          />
        </label>
        ),
      )}

      {offerErr ? (
        <div className="flex items-start gap-2 text-xs text-danger mb-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>This tool is unavailable right now ({offerErr}).</span>
        </div>
      ) : (
        <>
          <KeyValue label="Price" value={amount !== undefined ? `${formatUsd(amount, 4)} xUSD` : `${tool.price} xUSD`} hint="per run" />
          <KeyValue label="Paid to" value={offer ? <AddressLink address={offer.payTo} /> : "…"} />
        </>
      )}

      <div className="mt-3">
        <Button onClick={run} disabled={!offer || !payFetch || busy || short || !paramsOk}>
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {step === "signing" ? "Confirm in wallet…" : "Settling payment…"}
            </>
          ) : (
            <>
              <Play size={14} aria-hidden /> Run for {amount !== undefined ? formatUsd(amount, 4) : tool.price} xUSD
            </>
          )}
        </Button>
        {short && (
          <p className="mt-2 text-xs text-fg-muted">Not enough xUSD. Get some from the faucet above, or top up from your savings.</p>
        )}
        {runErr && (
          <div className="mt-2 flex items-start gap-2 text-xs text-danger">
            <AlertCircle size={14} className="mt-0.5" aria-hidden />
            <span className="break-all">{runErr}</span>
          </div>
        )}
      </div>

      {step === "done" && result !== null && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-success mb-2">
            <CheckCircle2 size={14} aria-hidden /> Paid and run
            {settleTx && <TxLink hash={settleTx as `0x${string}`} label="View settlement on explorer" />}
          </div>
          <pre className="num text-xs bg-bg border border-line rounded-sm p-3 overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </Card>
  );
}
