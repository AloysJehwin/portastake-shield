import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { BookOpen, Github, X } from "lucide-react";

export const REPO_URL = "https://github.com/AloysJehwin/portastake-shield";

type Chapter = { path: string; title: string; body: string[] };

/** The user manual: one chapter per page, opened at the page you are on. */
const MANUAL: Chapter[] = [
  {
    path: "/",
    title: "Home",
    body: [
      "Your balance in USD and stPOT, what it has earned, and the yield it is earning now.",
      "The safety panel shows the insurance pool that covers validator slashing and the reserve that keeps the 8% target steady through slow eras.",
      "The USD value moves with the POT price. Insurance covers slashing, not price.",
    ],
  },
  {
    path: "/deposit",
    title: "Deposit",
    body: [
      "Pay in tUSD (or xUSD, or tPOT directly). The app swaps it to POT, deposits it and mints stPOT to your wallet in one transaction.",
      "Need test money? Use the faucet button on the page. Slippage protects you if the price moves while you confirm.",
      "Your first deposit also mints your coverage certificate, a soulbound policy NFT.",
    ],
  },
  {
    path: "/bridge",
    title: "Bridge",
    body: [
      "Bring USDC from Base, Arbitrum, OP, Ethereum Sepolia or Polygon Amoy to Portaldot, and optionally save it on arrival as stPOT. You can also send tUSD back out.",
      "Get test USDC from the Circle faucet linked on the page. Your wallet sends one transfer; delivery on the other side is automatic and shows under Your transfers.",
      "Each transfer is capped at 10 USDC or tUSD while this is a testnet demo.",
    ],
  },
  {
    path: "/withdraw",
    title: "Withdraw",
    body: [
      "Small withdrawals are paid instantly in tUSD from the hot reserve. Larger ones join the unstake queue.",
      "You can withdraw to xUSD to top up a wallet that pays for on-chain tools.",
    ],
  },
  {
    path: "/automate",
    title: "Automate",
    body: [
      "Pick an amount and how often, then press Start saving. That one button sets up everything the rule needs; your wallet may ask you to confirm twice the first time.",
      "A keeper runs due rules for you. Only you can pause, resume or cancel them, and revoking your tUSD allowance stops them too.",
    ],
  },
  {
    path: "/tools",
    title: "On-chain tools and the API gateway",
    body: [
      "Each tool reads PortaStake live and costs a fraction of an xUSD per run. You sign a payment; you never pay gas.",
      "API gateway: paste any public API URL, set a price and who gets paid, and you get a paid endpoint anyone can call with x402. Keys you add are sealed so they never appear in the link.",
      "Earning: when your endpoint or tool is paid, the xUSD lands in your wallet. Press Move earnings to savings to put it to work in stPOT instead of leaving it idle.",
      "Get test xUSD with the faucet on the page.",
    ],
  },
  {
    path: "/activity",
    title: "Activity",
    body: ["Your recent deposits, withdrawals, unstakes, insurance payouts and rule runs, each linked to the explorer."],
  },
  {
    path: "*sdk",
    title: "Try it with the SDK",
    body: [
      "Most pages have a panel at the bottom that runs the same calls through @portastake/sdk. Pick a call, edit its inputs, press Send and read the live result.",
      "Calls marked WRITE ask your wallet first. The code shown is exactly what runs, so you can copy it into your own app.",
    ],
  },
];

/** GitHub and the user manual, always at hand in the bottom-right corner. */
export function HelpDock() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="fixed right-3 sm:right-5 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-6 z-30 flex flex-col gap-2">
        <DockButton label="Source code on GitHub" href={REPO_URL}>
          <Github size={18} aria-hidden />
        </DockButton>
        <DockButton label="User manual: how each page works" onClick={() => setOpen(true)}>
          <BookOpen size={18} aria-hidden />
        </DockButton>
      </div>
      {open && <Manual onClose={() => setOpen(false)} />}
    </>
  );
}

function DockButton({
  label,
  href,
  onClick,
  children,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const cls =
    "group relative card-glass !rounded-full w-11 h-11 inline-flex items-center justify-center text-fg hover:bg-white/80 transition-colors";
  const tip = (
    <span
      role="tooltip"
      className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-fg text-bg text-xs px-2 py-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
    >
      {label}
    </span>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label={label} className={cls}>
      {children}
      {tip}
    </a>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} className={cls}>
      {children}
      {tip}
    </button>
  );
}

function Manual({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const current = MANUAL.find((c) => c.path === pathname)?.path ?? "/";
  const refs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    refs.current[current]?.scrollIntoView({ block: "start" });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [current, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="User manual">
      <button type="button" aria-label="Close manual" className="absolute inset-0 bg-fg/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative card-glass !bg-white/85 w-full sm:max-w-xl max-h-[85vh] sm:max-h-[80vh] flex flex-col !rounded-b-none sm:!rounded-lg">
        <header className="flex items-center justify-between gap-3 p-4 sm:p-5 border-b border-line/70">
          <div className="flex items-center gap-2">
            <BookOpen size={16} aria-hidden />
            <h2 className="text-sm font-medium text-fg">User manual</h2>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost !h-8 !px-2" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="overflow-y-auto p-4 sm:p-5 space-y-5">
          {MANUAL.map((c) => (
            <section
              key={c.path}
              ref={(el) => {
                refs.current[c.path] = el;
              }}
              className={`scroll-mt-4 rounded-md p-3 -m-3 ${c.path === current ? "bg-white/70 ring-1 ring-black/5" : ""}`}
            >
              <h3 className="text-sm font-medium text-fg mb-1.5 flex items-center gap-2">
                {c.title}
                {c.path === current && <span className="chip !h-5">This page</span>}
              </h3>
              <ul className="space-y-1.5 text-sm text-fg-muted list-disc pl-5">
                {c.body.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-xs text-fg-subtle">
            More detail, the contracts and the SDK docs are on{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline">
              GitHub
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
