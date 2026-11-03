import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Home, ArrowDownToLine, ArrowUpFromLine, Repeat, History, Shield, Zap } from "lucide-react";
import { WalletButton } from "./WalletButton";

const NAV = [
  { to: "/", label: "Home", icon: Home },
  { to: "/deposit", label: "Deposit", icon: ArrowDownToLine },
  { to: "/withdraw", label: "Withdraw", icon: ArrowUpFromLine },
  { to: "/automate", label: "Automate", icon: Repeat },
  { to: "/pay-per-use", label: "Pay per use", icon: Zap },
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

      {/* Mobile header */}
      <header className="lg:hidden sticky top-0 z-20 card-glass mx-3 mt-3 px-4 py-3 flex items-center justify-between">
        <Brand compact />
        <WalletButton compact />
      </header>

      {/* Main */}
      <main className="flex-1 lg:ml-60">
        <div className="mx-auto w-full max-w-content px-4 py-6 lg:py-10 pb-28 lg:pb-10">{children}</div>
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="lg:hidden fixed bottom-3 inset-x-3 z-20 card-glass px-2 py-2 flex items-center justify-between">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded text-[11px] transition-colors ${
                isActive ? "text-fg" : "text-fg-subtle"
              }`
            }
          >
            <Icon size={18} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
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
