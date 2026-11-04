import { useEffect, useState } from "react";
import { isAddress, type Address, type WalletClient } from "viem";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowDownToLine, Check, Copy, Globe, KeyRound, Loader2, PiggyBank, Plus, Target, Trash2, User } from "lucide-react";
import { formatUsd } from "../format";
import { Card, GlassCard, Section } from "../components/primitives";
import { Select } from "../components/Select";
import { ToolCard, type Tool } from "./Tools";

const API = ((import.meta.env.VITE_TOOLS_URL as string | undefined) ?? "").replace(/\/$/, "");
const STORE_KEY = "portastake.gateway.endpoints";

export type Saved = { id: string; name: string; url: string; method: "GET" | "POST"; price: string; payTo: Address; sealed: boolean };
type Preview = { status: number; contentType: string; sample: unknown; truncated: boolean } | { error: string };

/** Public APIs that need no key, to start from. */
const PRESETS: Array<{ label: string; name: string; url: string; method?: "GET" | "POST"; price: string }> = [
  { label: "Crypto prices", name: "Crypto prices (CoinGecko)", url: "https://api.coingecko.com/api/v3/simple/price?ids=polkadot,bitcoin,ethereum&vs_currencies=usd", price: "0.005" },
  { label: "FX rates", name: "USD exchange rates", url: "https://open.er-api.com/v6/latest/USD", price: "0.002" },
  { label: "Country facts", name: "Country facts", url: "https://restcountries.com/v3.1/name/argentina?fields=name,capital,population,currencies", price: "0.001" },
  { label: "JSON echo (POST)", name: "JSON echo", url: "https://httpbin.org/anything", method: "POST", price: "0.001" },
];

function load(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function store(items: Saved[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 20)));
  } catch {
    // Storage can be blocked: the endpoint still works, its link just isn't remembered here.
  }
}

type Props = {
  balance: bigint;
  onPaid: () => void;
  walletClient: WalletClient | undefined;
  address: Address | undefined;
  xusd: Address;
};

/**
 * Turn any public HTTP API into a paid x402 endpoint: paste a URL, set a price and who gets paid, and the
 * gateway answers 402 until a caller pays in xUSD, then forwards the call. Nothing is deployed or stored.
 */
export function GatewaySection(props: Props) {
  const { address } = props;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState<"GET" | "POST">("GET");
  const [price, setPrice] = useState("0.01");
  const [payTo, setPayTo] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [saved, setSaved] = useState<Saved[]>(load);

  useEffect(() => {
    if (address && !payTo) setPayTo(address);
  }, [address, payTo]);

  const priceNum = Number(price);
  const valid =
    name.trim().length > 0 &&
    /^https?:\/\/.+/i.test(url.trim()) &&
    priceNum >= 0.001 &&
    priceNum <= 1 &&
    isAddress(payTo) &&
    (!headerName || /^[A-Za-z0-9-]{1,64}$/.test(headerName));

  async function create() {
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    try {
      const r = await fetch(`${API}/api/gateway/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          method,
          price: String(priceNum),
          payTo,
          headers: headerName && headerValue ? { [headerName]: headerValue } : undefined,
        }),
      });
      const j = (await r.json()) as { id?: string; error?: string; preview?: Preview; config?: { payTo: Address; sealedHeaders: boolean } };
      if (!r.ok || !j.id) throw new Error(j.error ?? `the gateway answered ${r.status}`);
      setPreview(j.preview);
      const item: Saved = {
        id: j.id,
        name: name.trim(),
        url: url.trim(),
        method,
        price: String(priceNum),
        payTo: j.config?.payTo ?? (payTo as Address),
        sealed: !!j.config?.sealedHeaders,
      };
      const next = [item, ...saved.filter((s) => s.id !== j.id)];
      setSaved(next);
      store(next);
      setHeaderValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    store(next);
  }

  return (
    <>
      <Section title="API gateway">
        <GlassCard>
          <div className="flex items-start gap-3 mb-4">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-sm bg-fg text-bg shrink-0">
              <Globe size={16} aria-hidden />
            </span>
            <div className="min-w-0">
              <span className="chip !h-6 mb-1.5">Process 1 · Earning</span>
              <h2 className="text-base text-fg">Sell your API or tool, and save what it earns</h2>
              <p className="text-sm text-fg-muted">
                Paste any public API, set a price per call and who gets paid. Any app, script or AI agent can pay it in
                xUSD on Portaldot, and callers only pay when the API answers.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div className="rounded-md border border-line bg-white/50 p-3 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-fg-muted mb-1">
                <User size={12} aria-hidden /> Who
              </div>
              <p className="text-sm text-fg">Someone who registers an endpoint on the gateway or runs a paid tool.</p>
            </div>
            <div className="rounded-md border border-line bg-white/50 p-3 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-fg-muted mb-1">
                <Target size={12} aria-hidden /> Goal
              </div>
              <p className="text-sm text-fg">
                Money that comes in goes straight into savings instead of sitting idle in the wallet.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white/50 p-3 mb-5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-success/10 text-success shrink-0">
                <PiggyBank size={16} aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-xs text-fg-muted">Earnings waiting in your wallet</div>
                <div className="num text-sm text-fg">{formatUsd(props.balance)} xUSD</div>
              </div>
            </div>
            <Link
              to="/deposit?asset=xusd"
              className={`btn-primary ${props.balance === 0n ? "pointer-events-none opacity-50" : ""}`}
              aria-disabled={props.balance === 0n}
            >
              <ArrowDownToLine size={14} aria-hidden /> Move earnings to savings
            </Link>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1 mb-4 -mx-1 px-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="chip shrink-0 hover:border-line-strong"
                onClick={() => {
                  setName(p.name);
                  setUrl(p.url);
                  setMethod(p.method ?? "GET");
                  setPrice(p.price);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={name} maxLength={60} placeholder="My prices API" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Price per call (xUSD)">
              <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
            </Field>
            <div className="sm:col-span-2 grid gap-3 grid-cols-[minmax(0,1fr)_auto]">
              <Field label="API URL">
                <input className="input num text-sm" value={url} placeholder="https://api.example.com/v1/data?x=1" onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <div className="min-w-0">
                <span className="block text-xs text-fg-muted mb-1.5">Method</span>
                <Select
                  label="HTTP method"
                  className="w-28"
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: "GET", label: "GET" },
                    { value: "POST", label: "POST" },
                  ]}
                />
              </div>
            </div>
            <div className="sm:col-span-2">
              <Field label="Paid to">
                <input className="input num text-sm" value={payTo} placeholder="0x…" onChange={(e) => setPayTo(e.target.value.trim())} />
              </Field>
            </div>
            <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
              <Field label="API key header (optional)" icon={<KeyRound size={12} aria-hidden />}>
                <input className="input text-sm" value={headerName} placeholder="x-api-key" onChange={(e) => setHeaderName(e.target.value.trim())} />
              </Field>
              <Field label="Header value (sealed, never shown)">
                <input
                  className="input text-sm"
                  type="password"
                  autoComplete="off"
                  value={headerValue}
                  disabled={!headerName}
                  onChange={(e) => setHeaderValue(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={!valid || busy} onClick={create}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} aria-hidden />}
              {busy ? "Checking the API…" : "Create paid endpoint"}
            </button>
            <span className="text-xs text-fg-subtle">Free to create. Between 0.001 and 1 xUSD per call.</span>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 text-xs text-danger">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span className="break-words">{error}</span>
            </div>
          )}
          {preview && (
            <div className="mt-4">
              <div className="text-xs text-fg-muted mb-1">
                {"error" in preview
                  ? `Created, but the test call failed: ${preview.error}`
                  : `Test call answered ${preview.status} (${preview.contentType.split(";")[0]})${preview.truncated ? ", first 4 KB" : ""}`}
              </div>
              {!("error" in preview) && (
                <pre className="num text-xs bg-bg border border-line rounded-sm p-3 overflow-auto max-h-48">
                  {typeof preview.sample === "string" ? preview.sample : JSON.stringify(preview.sample, null, 2)}
                </pre>
              )}
            </div>
          )}
        </GlassCard>
      </Section>

      {saved.length > 0 && (
        <Section title="Your paid endpoints">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {saved.map((s) => (
              <ToolCard
                key={s.id}
                {...props}
                tool={toTool(s)}
                extra={<EndpointActions id={s.id} onRemove={() => remove(s.id)} />}
              />
            ))}
          </div>
          <Card className="mt-4">
            <p className="text-xs text-fg-muted">
              Share the endpoint URL with anyone. Callers get HTTP 402 with the price, pay with the SDK's{" "}
              <code className="num">createPayingFetch</code> or any x402 client, and receive the API's answer. Add{" "}
              <code className="num">?_path=/sub/path</code> or extra query parameters to reach other routes of the same API.
              Endpoints live in their link: this list is only kept in this browser.
            </p>
          </Card>
        </Section>
      )}
    </>
  );
}

export function toTool(s: Saved): Tool {
  return {
    id: s.id,
    name: s.name,
    summary: `${s.method} ${s.url}${s.sealed ? " · with a sealed key" : ""}`,
    price: s.price,
    endpoint: `/api/gateway/${s.id}`,
    method: s.method,
    params:
      s.method === "POST"
        ? [{ name: "body", label: "JSON body", placeholder: '{"hello":"world"}' }]
        : [{ name: "query", label: "Extra query (optional)", placeholder: "city=Lima&_path=/v2" }],
  };
}

function EndpointActions({ id, onRemove }: { id: string; onRemove: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = `${API || window.location.origin}/api/gateway/${id}`;
  return (
    <span className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        className="btn-ghost !h-8 !px-2"
        aria-label="Copy endpoint URL"
        title="Copy endpoint URL"
        onClick={() =>
          void navigator.clipboard?.writeText(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button type="button" className="btn-ghost !h-8 !px-2" aria-label="Remove from this list" title="Remove from this list" onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </span>
  );
}

function Field({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="flex items-center gap-1 text-xs text-fg-muted mb-1.5">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}
