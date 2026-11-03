// Watches `Locked` on every chain, then signs and delivers `release` on the destination.
import { ethers } from 'ethers';
import { list, loadBridgeDeployment, loadChains, type Chain } from '../config.ts';
import { errorText, providerFor, safeHead, TOKEN_BRIDGE_ABI, txOverrides } from '../evm.ts';
import type { PendingRelease, Store } from '../state.ts';
import { releaseId, signRelease } from './message.ts';

const MAX_BACKOFF_MS = 5 * 60_000;

// A too-low gas limit makes the desk call fail inside TokenBridge's try/catch while the transaction
// still succeeds, paying tUSD instead of stPOT. Node estimators can land on exactly that limit, so
// save releases get a floor well above what the deposit path uses.
const SAVE_GAS_FLOOR = 1_500_000n;

type Live = { chain: Chain; provider: ethers.JsonRpcProvider; bridge: ethers.Contract; address: string; deployBlock: number };

export class BridgeRelayer {
  private readonly live = new Map<number, Live>();
  private readonly signers: ethers.Wallet[];
  private readonly submitKey?: string;

  constructor(private readonly store: Store, private readonly dryRun: boolean, private readonly log = console.log) {
    this.signers = list(process.env.BRIDGE_SIGNER_KEYS).map((k) => new ethers.Wallet(k));
    this.submitKey = process.env.RELAYER_KEY;
    for (const chain of loadChains()) {
      const dep = loadBridgeDeployment(chain.chainId);
      if (!dep) continue;
      const provider = providerFor(chain);
      this.live.set(chain.chainId, {
        chain,
        provider,
        address: dep.TokenBridge,
        deployBlock: dep.deployBlock,
        bridge: new ethers.Contract(dep.TokenBridge, TOKEN_BRIDGE_ABI, provider),
      });
    }
  }

  get chainCount(): number {
    return this.live.size;
  }

  async tick(): Promise<void> {
    // One bad RPC must not stop the other chains.
    await Promise.all(
      [...this.live.values()].map((l) =>
        this.scan(l).catch((e) => this.log(`[bridge] ${l.chain.key}: scan failed: ${errorText(e)}`)),
      ),
    );
    this.store.save();
    await Promise.all(
      [...this.live.values()].map((l) =>
        this.deliverTo(l).catch((e) => this.log(`[bridge] ${l.chain.key}: delivery failed: ${errorText(e)}`)),
      ),
    );
  }

  private async scan(l: Live): Promise<void> {
    const { state } = this.store;
    const head = await safeHead(l.provider, l.chain);
    let from = state.cursors[l.chain.chainId] ?? l.deployBlock;
    while (from <= head) {
      const to = Math.min(from + l.chain.logChunk - 1, head);
      const logs = await l.bridge.queryFilter(l.bridge.filters.Locked(), from, to);
      for (const log of logs as ethers.EventLog[]) {
        if (log.removed) continue;
        const { nonce, dstChainId, to: receiver, amount, minShares } = log.args;
        const key = `${l.chain.chainId}:${nonce}`;
        if (!this.live.has(Number(dstChainId))) {
          this.log(`[bridge] ${key}: destination ${dstChainId} has no deployment, skipping`);
          continue;
        }
        state.pending[key] ??= {
          srcChainId: l.chain.chainId,
          dstChainId: Number(dstChainId),
          nonce: nonce.toString(),
          to: receiver,
          amount: amount.toString(),
          minShares: minShares.toString(),
          attempts: 0,
          nextTry: 0,
        };
        this.log(`[bridge] ${key}: locked ${amount} for ${receiver} -> ${dstChainId}`);
      }
      from = to + 1;
      state.cursors[l.chain.chainId] = from;
    }
  }

  /** Sequential per destination so one wallet's nonces stay in order. */
  private async deliverTo(dst: Live): Promise<void> {
    const { state } = this.store;
    const due = Object.entries(state.pending)
      .filter(([, p]) => p.dstChainId === dst.chain.chainId && p.nextTry <= Date.now())
      .sort(([, a], [, b]) => Number(BigInt(a.nonce) - BigInt(b.nonce)));
    for (const [key, p] of due) {
      try {
        await this.deliver(key, p, dst);
      } catch (e) {
        p.attempts += 1;
        p.lastError = errorText(e);
        p.nextTry = Date.now() + Math.min(15_000 * 2 ** p.attempts, MAX_BACKOFF_MS);
        this.log(`[bridge] ${key}: attempt ${p.attempts} failed, will retry: ${p.lastError}`);
      }
      this.store.save();
    }
  }

  private async deliver(key: string, p: PendingRelease, dst: Live): Promise<void> {
    const src = this.live.get(p.srcChainId);
    if (!src) throw new Error(`source ${p.srcChainId} has no deployment`);

    const nonce = BigInt(p.nonce);
    const amount = BigInt(p.amount);
    const minShares = BigInt(p.minShares);
    const id = releaseId(p.srcChainId, nonce);

    if (await dst.bridge.processed(id)) {
      this.log(`[bridge] ${key}: already released`);
      delete this.store.state.pending[key];
      return;
    }
    if (this.dryRun) {
      this.log(`[bridge] ${key}: dry run, would release ${amount} to ${p.to} on ${dst.chain.key}`);
      return;
    }
    if (!this.submitKey || this.signers.length === 0) throw new Error('RELAYER_KEY and BRIDGE_SIGNER_KEYS are required');

    const sigs = await signRelease(
      {
        srcChainId: p.srcChainId,
        srcBridge: src.address,
        dstChainId: dst.chain.chainId,
        dstBridge: dst.address,
        nonce,
        to: p.to,
        amount,
        minShares,
      },
      this.signers,
    );

    const wallet = new ethers.Wallet(this.submitKey, dst.provider);
    const bridge = dst.bridge.connect(wallet) as ethers.Contract;
    const args = [p.srcChainId, nonce, p.to, amount, minShares, sigs] as const;

    const estimate = await bridge.release.estimateGas(...args);
    const padded = (estimate * 150n) / 100n;
    const gasLimit = minShares > 0n && padded < SAVE_GAS_FLOOR ? SAVE_GAS_FLOOR : padded;

    const tx = await bridge.release(...args, { gasLimit, ...txOverrides(dst.chain) });
    const receipt = await tx.wait(1, 180_000);
    const released = receipt.logs
      .map((log: ethers.Log) => {
        try {
          return bridge.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: ethers.LogDescription | null) => parsed?.name === 'Released');

    const shares: bigint = released?.args.shares ?? 0n;
    delete this.store.state.pending[key];
    if (minShares > 0n && dst.chain.hub && shares === 0n) {
      this.log(`[bridge] ${key}: delivered as tUSD, the desk could not take the save (${tx.hash})`);
    } else {
      this.log(`[bridge] ${key}: released on ${dst.chain.key}, shares ${shares} (${tx.hash})`);
    }
  }
}
