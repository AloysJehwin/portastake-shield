import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { Home, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Repeat, History, Shield, Wrench, MoreHorizontal } from "lucide-react";
import { portaldot, spokeChains } from "../chains";
import { WalletButton } from "./WalletButton";
import { HelpDock } from "./HelpDock";
import { SdkPlayground } from "./SdkPlayground";
import { SDK_OPS } from "../sdkOps";

/** Which SDK calls each page offers in its playground. */
const PLAYGROUND: Record<string, { ops: (typeof SDK_OPS)[keyof typeof SDK_OPS]; title?: string }> = {
  "/": { ops: SDK_OPS.home },
  "/deposit": { ops: SDK_OPS.deposit },
  "/withdraw": { ops: SDK_OPS.withdraw },
  "/automate": { ops: SDK_OPS.automate },
  "/tools": { ops: SDK_OPS.tools, title: "Try it with the SDK and API" },
  "/activity": { ops: SDK_OPS.activity },
  "/bridge": { ops: SDK_OPS.bridge, title: "Try the bridge API" },
};

// The phone tab bar holds the four everyday pages; the rest live under More.
const PRIMARY = ["/", "/deposit", "/withdraw", "/automate"];

const NAV = [
  { to: "/", label: "Home", icon: Home },
  { to: "/deposit", label: "Deposit", icon: ArrowDownToLine },
  { to: "/bridge", label: "Bridge", icon: ArrowLeftRight },
  { to: "/withdraw", label: "Withdraw", icon: ArrowUpFromLine },
  { to: "/automate", label: "Automate", icon: Repeat },
  { to: "/tools", label: "On-chain tools", short: "Tools", icon: Wrench },
  { to: "/activity", label: "Activity", icon: History },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:fixed lg:inset-y-0 lg:left-0 p-4">
        <div className="card-glass flex-1 p-5 flex flex-col gap-6">
          <Brand />
          <nav className="flex flex-col gap-1">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-3 h-10 px-3 rounded text-sm transition-colors ${
                    isActive ? "bg-fg text-bg" : "text-fg-muted hover:text-fg hover:bg-white/40"
                  }`
                }
              >
                <Icon size={16} aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto">
            <WalletButton />
          </div>
        </div>
      </aside>

      {/* Mobile and tablet header */}
      <header className="lg:hidden sticky top-0 z-20 card-glass mx-3 mt-3 px-3 sm:px-4 py-2.5 flex items-center justify-between gap-3 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <Brand compact />
        <WalletButton compact />
      </header>

      {/* Main */}
      <main className="flex-1 min-w-0 lg:ml-60">
        <div className="mx-auto w-full max-w-content px-3 sm:px-6 lg:px-8 py-5 sm:py-6 lg:py-10 pb-36 lg:pb-24">
          <SpokeChainNotice />
          {children}
          <RoutePlayground />
        </div>
      </main>

      <HelpDock />
      <MobileNav />
    </div>
  );
}

function RoutePlayground() {
  const { pathname } = useLocation();
  const entry = PLAYGROUND[pathname];
  return entry ? <SdkPlayground key={pathname} ops={entry.ops} title={entry.title} /> : null;
}

/** Bottom tab bar below lg: four everyday pages and a More sheet for the rest. */
function MobileNav() {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);
  const primary = NAV.filter((n) => PRIMARY.includes(n.to));
  const secondary = NAV.filter((n) => !PRIMARY.includes(n.to));
  const inSecondary = secondary.some((n) => n.to === pathname);
  const tab = (active: boolean) =>
    `flex-1 min-w-0 flex flex-col items-center gap-0.5 py-1.5 rounded text-[11px] transition-colors ${
      active ? "text-fg" : "text-fg-subtle"
    }`;

  return (
    <>
      {more && (
        <>
          <button type="button" aria-label="Close menu" className="lg:hidden fixed inset-0 z-20" onClick={() => setMore(false)} />
          <div className="lg:hidden fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 card-glass !bg-white/85 p-2 grid gap-1">
            {secondary.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-3 h-11 px-3 rounded text-sm ${isActive ? "bg-fg text-bg" : "text-fg hover:bg-white/60"}`
                }
              >
                <Icon size={16} aria-hidden />
                {label}
              </NavLink>
            ))}
          </div>
        </>
      )}
      <nav
        aria-label="Main"
        className="lg:hidden fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] inset-x-3 z-30 card-glass px-1.5 py-1.5 flex items-center justify-between sm:max-w-md sm:mx-auto"
      >
        {primary.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => tab(isActive)}>
            <Icon size={19} aria-hidden />
            <span className="truncate max-w-full">{label}</span>
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={tab(inSecondary || more)}>
          <MoreHorizontal size={19} aria-hidden />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

/** Savings only exist on Portaldot, so every page but Bridge reads as empty from another chain. */
function SpokeChainNotice() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { pathname } = useLocation();
  const { switchChain } = useSwitchChain();
  const spoke = spokeChains.find((c) => c.id === chainId);
  if (!isConnected || !spoke || pathname === "/bridge") return null;
  return (
    <div className="card mb-6 p-4 flex items-center justify-between gap-3 text-sm text-fg">
      <span>You are on {spoke.name}. Your savings are on {portaldot.name}.</span>
      <button className="btn-secondary shrink-0" onClick={() => switchChain({ chainId: portaldot.id })}>
        Switch
      </button>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-fg">
      <span className="inline-flex items-center justify-center w-7 h-7 rounded bg-fg text-bg">
        <Shield size={16} strokeWidth={1.6} />
      </span>
      {!compact && (
        <div>
          <div className="text-sm font-medium leading-none">PortaStake</div>
          <div className="text-[11px] text-fg-muted leading-none mt-1">Shield</div>
        </div>
      )}
      {compact && <span className="text-sm font-medium">PortaStake</span>}
    </div>
  );
}
