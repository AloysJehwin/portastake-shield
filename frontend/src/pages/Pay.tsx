import { useEffect, useState } from "react";
import { useParams, useLocation, Link } from "react-router-dom";
import { useAccount, useReadContract, useWalletClient } from "wagmi";
import { getAddress, type Address } from "viem";
import { AlertCircle, ArrowUpFromLine, Globe } from "lucide-react";
import { isDeployed } from "../addresses";
import { useProtocol } from "../hooks/useProtocol";
import { X402DollarAbi } from "../abi/X402Dollar";
import { TxButton } from "../components/TxButton";
import { AddressLink } from "../components/ExplorerLink";
import { WalletGate } from "../components/WalletGate";
import { GlassCard, Section, KeyValue, Divider, Empty } from "../components/primitives";
import { formatUsd } from "../format";
import { ToolCard } from "./Tools";
import { toTool, type Saved } from "./Gateway";

const API = ((import.meta.env.VITE_TOOLS_URL as string | undefined) ?? "").replace(/\/$/, "");
type Inspect = { name: string; url: string; method: "GET" | "POST"; price: string; payTo: Address; sealedHeaders: boolean; live: boolean };

/**
 * Pay page for a shared gateway endpoint. Browsers that open /api/gateway/<id> are sent here, so the
 * person holding the link can connect a wallet, pay in xUSD and see the answer, instead of a raw 402.
 */
export function Pay() {
  const { id = "" } = useParams();
  const { search } = useLocation();
  const p = useProtocol();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const xusd = p.addresses.xUSD;

  const [cfg, setCfg] = useState<Inspect | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${API}/api/gateway/inspect?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `answered ${r.status}`);
        setCfg(j as Inspect);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const { data: bal, refetch } = useReadContract({
    address: address && isDeployed(xusd) ? xusd : undefined,
    abi: X402DollarAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && isDeployed(xusd), refetchInterval: 8_000 },
  });
  const balance = (bal as bigint | undefined) ?? 0n;

  if (err) {
    return (
      <Section>
        <GlassCard>
          <Empty icon={<AlertCircle size={20} aria-hidden />} title="This payment link isn't valid" hint={err} />
        </GlassCard>
      </Section>
    );
  }
  if (!cfg) {
    return (
      <Section>
        <GlassCard>
          <span className="text-sm text-fg-muted">Loading…</span>
        </GlassCard>
      </Section>
    );
  }

  const saved: Saved = { id, name: cfg.name, url: cfg.url, method: cfg.method, price: cfg.price, payTo: getAddress(cfg.payTo), sealed: cfg.sealedHeaders };
  const tool = toTool(saved);
  // Carry the query the link was opened with (for example ?city=Lima) into the call.
  const query = new URLSearchParams(search);
  if (cfg.method === "GET" && [...query].length) {
    tool.params = tool.params?.map((q) => (q.name === "query" ? { ...q, value: query.toString() } : q));
  }

  return (
    <WalletGate action={`pay for ${cfg.name}`}>
      <Section>
        <GlassCard>
          <div className="flex items-start gap-3 mb-4">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-sm bg-fg text-bg shrink-0">
              <Globe size={16} aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg text-fg">{cfg.name}</h1>
              <p className="text-sm text-fg-muted break-words">
                A paid API on Portaldot. Pay {cfg.price} xUSD per call with x402: your wallet signs, the gateway answers, and the
                payment settles on Portaldot. You never pay gas.
              </p>
            </div>
          </div>
          <KeyValue label="Price" value={`${cfg.price} xUSD per call`} />
          <KeyValue label="Paid to" value={<AddressLink address={cfg.payTo} />} />
          <KeyValue label="Your xUSD" value={formatUsd(balance)} />
          {!cfg.live && <p className="mt-3 text-xs text-danger">Paid calls are offline on this deployment.</p>}
          <Divider className="my-4" />
          <div className="flex flex-wrap gap-2">
            <TxButton
              label="Get 10 test xUSD"
              address={xusd}
              abi={X402DollarAbi}
              functionName="faucet"
              args={[10_000_000n]}
              onSuccess={() => void refetch()}
            />
            {isDeployed(p.addresses.XusdGateway) && (
              <Link to="/withdraw?asset=xusd" className="btn-secondary">
                <ArrowUpFromLine size={14} aria-hidden /> Top up xUSD from savings
              </Link>
            )}
          </div>
        </GlassCard>
      </Section>

      <Section title="Call it">
        <ToolCard tool={tool} balance={balance} onPaid={() => void refetch()} walletClient={walletClient} address={address} xusd={xusd} />
      </Section>
    </WalletGate>
  );
}
