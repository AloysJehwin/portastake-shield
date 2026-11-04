import type { PortaStake, TxResult } from "./client.js";
import { mandates } from "./mandates.js";

export type KeeperLog = (line: string) => void;

export type KeeperOptions = {
  /** Skip a mandate after this many consecutive failed runs in this process. */
  maxRetries?: number;
  /** Consecutive failures per id, kept between passes. Pass the same Map to every pass. */
  failures?: Map<bigint, number>;
  log?: KeeperLog;
};

export type KeeperPassResult = {
  scanned: number;
  executed: Array<{ id: bigint; amount: bigint; tx: TxResult }>;
  failed: Array<{ id: bigint; reason: string; attempt: number }>;
};

/**
 * One keeper pass over MandateManager: run every mandate that is due now.
 *
 * The contract enforces every rule (due time, cooldown, run cap, expiry, threshold bound,
 * slippage floor), so the keeper only decides when to call, never how much. A run that reverts
 * (for example because the owner revoked an allowance) leaves the mandate untouched and is
 * retried next pass, up to `maxRetries` times in a row.
 */
export async function runKeeperPass(ps: PortaStake, opts: KeeperOptions = {}): Promise<KeeperPassResult> {
  const m = mandates(ps);
  const maxRetries = opts.maxRetries ?? 3;
  const failures = opts.failures ?? new Map<bigint, number>();
  const log = opts.log ?? (() => {});
  const n = Number(await m.count());
  const result: KeeperPassResult = { scanned: n, executed: [], failed: [] };

  for (let i = 0; i < n; i++) {
    const id = BigInt(i);
    if ((failures.get(id) ?? 0) >= maxRetries) continue;
    const { due, amount } = await m.isDue(id);
    if (!due) continue;
    try {
      const tx = await m.execute(id);
      if (tx.status !== "success") throw new Error(`reverted in block ${tx.blockNumber}`);
      failures.delete(id);
      result.executed.push({ id, amount, tx });
      log(`✔ mandate ${id}: moved ${Number(amount) / 1e6} tUSD (${tx.explorerUrl})`);
    } catch (e) {
      const attempt = (failures.get(id) ?? 0) + 1;
      failures.set(id, attempt);
      const err = e as { shortMessage?: string; message?: string };
      const reason = (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
      result.failed.push({ id, reason, attempt });
      log(`✘ mandate ${id}: ${reason} (attempt ${attempt}/${maxRetries})`);
    }
  }
  log(`pass done: ${result.executed.length} executed of ${n} mandates scanned`);
  return result;
}

/** Run keeper passes every `intervalSecs` until `signal` aborts. */
export async function runKeeper(ps: PortaStake, intervalSecs: number, opts: KeeperOptions & { signal?: AbortSignal } = {}) {
  const failures = opts.failures ?? new Map<bigint, number>();
  while (!opts.signal?.aborted) {
    await runKeeperPass(ps, { ...opts, failures });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalSecs * 1000);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
