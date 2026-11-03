// Crash-safe JSON state. Replays are harmless on-chain, but cursors and reward totals must survive restarts.
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

export type State = {
  /** Next source block to scan, per chain id. */
  cursors: Record<string, number>;
  /** Releases still to deliver, keyed `<srcChainId>:<nonce>`. */
  pending: Record<string, PendingRelease>;
  /** Last era whose staking payouts were claimed. */
  lastPaidEra?: number;
  /** Rewards claimed on Substrate but not yet reported to the vault, in planck. */
  unreportedRewards: string;
};

export class Store {
  state: State;

  constructor(private readonly file: string) {
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as State)
      : { cursors: {}, pending: {}, unreportedRewards: '0' };
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
