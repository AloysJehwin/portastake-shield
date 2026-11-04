// Crash-safe JSON state. Spoke releases are protected on-chain; Portaldot payouts lean on `inflight` and `paid`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type PendingRelease = {
  srcChainId: number;
  dstChainId: number;
  nonce: string;
  to: string;
  amount: string;
  minShares: string;
  attempts: number;
  nextTry: number;
  lastError?: string;
};

/** A signed Portaldot transaction, recorded before it is broadcast. */
export type InflightTx = { raw: string; hash: string; nonce: number; id?: string };

/** What one chain's relayer wallet needs to never pay twice. */
export type WalletState = {
  paid: Record<string, string>;
  paidCursor?: number;
  inflight?: InflightTx;
  spend: { day: string; amount: string };
};

export type State = {
  /** Next source block to scan, per chain id. */
  cursors: Record<string, number>;
  /** Releases still to deliver, keyed `<srcChainId>:<nonce>`. */
  pending: Record<string, PendingRelease>;
  /** Portaldot payouts already on-chain, by release id. Rebuilt from chain data if lost. */
  paid: Record<string, string>;
  /** Next block to scan for the relayer wallet's own payouts. */
  paidCursor?: number;
  inflight?: InflightTx;
  /** tUSD paid out by the relayer wallet on one UTC day. */
  spend: { day: string; amount: string };
  /** The same payout bookkeeping for the relayer wallet on every other chain, by chain id. */
  wallets?: Record<string, WalletState>;
  /** Last era whose staking payouts were claimed. */
  lastPaidEra?: number;
  /** Rewards claimed on Substrate but not yet reported to the vault, in planck. */
  unreportedRewards: string;
};

export class Store {
  state: State;

  constructor(private readonly file: string) {
    const fresh: State = { cursors: {}, pending: {}, paid: {}, spend: { day: '', amount: '0' }, unreportedRewards: '0' };
    this.state = existsSync(file) ? { ...fresh, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<State>) } : fresh;
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
