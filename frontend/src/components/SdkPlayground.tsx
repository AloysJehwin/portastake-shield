import { useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import type { PublicClient, WalletClient } from "viem";
import { createPortaStake, type PortaStake } from "@portastake/sdk/chain";
import { Braces, Check, ChevronDown, Copy, Loader2, Play, TerminalSquare } from "lucide-react";
import { portaldot } from "../chains";

/** One thing a page lets people try. `run` executes the same call the snippet shows. */
export type SdkOp = {
  id: string;
  /** The call as it reads in code, e.g. `ps.stats()`. */
  title: string;
  summary: string;
  /** "sdk" runs through @portastake/sdk; "http" calls one of this app's endpoints. */
  kind?: "sdk" | "http";
  /** Sends a transaction or signs a payment: needs a connected wallet on Portaldot. */
  writes?: boolean;
  params?: Array<{ name: string; label: string; placeholder?: string; initial?: string; fromWallet?: boolean }>;
  code: (p: Record<string, string>) => string;
  run: (ctx: RunCtx, p: Record<string, string>) => Promise<unknown>;
};

export type RunCtx = {
  ps: PortaStake;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  address?: `0x${string}`;
};

type Response = { ok: boolean; ms: number; body: unknown };

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) ?? "undefined";

/**
 * An API-client style panel: pick a call, edit its inputs, see the exact code, send it and read the
 * response. Collapsed by default so it never crowds the page it sits on.
 */
export function SdkPlayground({ ops, title = "Try it with the SDK" }: { ops: SdkOp[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(ops[0]?.id);
  const op = ops.find((o) => o.id === sel) ?? ops[0];
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: portaldot.id }) as PublicClient | undefined;
  const { data: walletClient } = useWalletClient();
  const onPortaldot = chainId === portaldot.id;

  const ps = useMemo(
    () =>
      publicClient
        ? createPortaStake({
            publicClient,
            ...(walletClient && onPortaldot ? { walletClient: walletClient as never } : {}),
          })
        : undefined,
    [publicClient, walletClient, onPortaldot],
  );

  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const params = values[op.id] ?? {};
  // Defaults, and the connected address for wallet-bound inputs, without overwriting what was typed.
  useEffect(() => {
    setValues((all) => {
      const next = { ...all };
      for (const o of ops) {
        const cur = { ...(next[o.id] ?? {}) };
        for (const q of o.params ?? []) {
          if (cur[q.name] === undefined || (q.fromWallet && !cur[q.name])) {
            cur[q.name] = q.fromWallet && address ? address : (q.initial ?? "");
          }
        }
        next[o.id] = cur;
      }
      return next;
    });
  }, [ops, address]);

  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Record<string, Response>>({});
  const [copied, setCopied] = useState(false);
  const code = op.code(params);
  const needsWallet = op.writes && (!walletClient || !onPortaldot);

  async function send() {
    if (!ps || !publicClient) return;
    setBusy(true);
    const t0 = performance.now();
    try {
      const body = await op.run({ ps, publicClient, walletClient: walletClient ?? undefined, address }, params);
      setRes((r) => ({ ...r, [op.id]: { ok: true, ms: Math.round(performance.now() - t0), body } }));
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setRes((r) => ({
        ...r,
        [op.id]: { ok: false, ms: Math.round(performance.now() - t0), body: { error: (err.shortMessage ?? err.message ?? String(e)).split("\n")[0] } },
      }));
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }

  const r = res[op.id];
  return (
    <section className="mb-8">
      <div className="card overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="w-full flex items-center gap-3 p-4 sm:px-5 text-left hover:bg-white/30 transition-colors"
        >
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-fg text-bg shrink-0">
            <TerminalSquare size={15} aria-hidden />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-fg">{title}</span>
            <span className="block text-xs text-fg-muted truncate">
              {ops.length} {ops.length === 1 ? "call" : "calls"} you can run live from this page
            </span>
          </span>
          <ChevronDown size={16} className={`shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>

        {open && (
          <div className="border-t border-line/70 grid md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
            {/* Operation list: a scrolling row on phones, a sidebar from md up. */}
            <nav
              aria-label="Calls"
              className="flex md:flex-col gap-1 p-2 min-w-0 overflow-x-auto md:overflow-hidden border-b md:border-b-0 md:border-r border-line/70 bg-white/20"
            >
              {ops.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setSel(o.id)}
                  title={o.title}
                  className={`shrink-0 md:shrink md:w-full min-w-0 text-left rounded-sm px-2.5 py-2 transition-colors ${
                    o.id === op.id ? "bg-fg text-bg" : "text-fg-muted hover:text-fg hover:bg-white/50"
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <MethodBadge op={o} active={o.id === op.id} />
                    {/* Truncate in the sidebar so a long call never spills into the detail pane. */}
                    <span className="num text-xs whitespace-nowrap md:truncate min-w-0">{o.title}</span>
                  </span>
                </button>
              ))}
            </nav>

            <div className="min-w-0 p-4 sm:p-5 space-y-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <MethodBadge op={op} />
                  <code className="num text-sm text-fg break-all">{op.title}</code>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{op.summary}</p>
              </div>

              {(op.params ?? []).length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(op.params ?? []).map((q) => (
                    <label key={q.name} className="block min-w-0">
                      <span className="text-xs text-fg-muted">{q.label}</span>
                      <input
                        className="mt-1 w-full h-9 px-3 rounded-sm border border-line bg-bg text-sm num"
                        value={params[q.name] ?? ""}
                        placeholder={q.placeholder}
                        onChange={(e) =>
                          setValues((all) => ({ ...all, [op.id]: { ...(all[op.id] ?? {}), [q.name]: e.target.value.trim() } }))
                        }
                      />
                    </label>
                  ))}
                </div>
              )}

              <div className="rounded-sm border border-line bg-fg text-bg/90 overflow-hidden">
                <div className="flex items-center justify-between px-3 h-8 border-b border-white/10 text-[11px] text-white/60">
                  <span className="num">{op.kind === "http" ? "fetch" : "@portastake/sdk"}</span>
                  <button type="button" onClick={copy} className="inline-flex items-center gap-1 hover:text-white" aria-label="Copy code">
                    {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="num text-[12px] leading-relaxed p-3 overflow-x-auto text-white/90">{code}</pre>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="btn-primary" onClick={send} disabled={busy || !ps || needsWallet}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} aria-hidden />}
                  {busy ? "Running…" : op.writes ? "Run (asks your wallet)" : "Send"}
                </button>
                {needsWallet && (
                  <span className="text-xs text-fg-muted">Connect a wallet on {portaldot.name} to run this one.</span>
                )}
              </div>

              <div className="rounded-sm border border-line bg-bg/70">
                <div className="flex items-center justify-between gap-3 px-3 h-8 border-b border-line text-xs">
                  <span className="inline-flex items-center gap-1.5 text-fg-muted">
                    <Braces size={12} aria-hidden /> Response
                  </span>
                  {r && (
                    <span className="flex items-center gap-2">
                      <span className={r.ok ? "chip-success !h-5" : "chip-danger !h-5"}>{r.ok ? "OK" : "Error"}</span>
                      <span className="num text-fg-subtle">{r.ms} ms</span>
                    </span>
                  )}
                </div>
                <pre className="num text-xs p-3 overflow-auto max-h-72 text-fg">{r ? json(r.body) : "Send the call to see its live result here."}</pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MethodBadge({ op, active }: { op: SdkOp; active?: boolean }) {
  const label = op.kind === "http" ? (op.writes ? "POST" : "GET") : op.writes ? "WRITE" : "READ";
  const tone = op.writes ? "text-[#B45309] bg-[#F59E0B]/10" : "text-success bg-success/10";
  return (
    <span className={`shrink-0 num text-[10px] font-semibold px-1.5 py-0.5 rounded ${active ? "bg-white/15 text-bg" : tone}`}>{label}</span>
  );
}
