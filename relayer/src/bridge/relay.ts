// Watches every chain for transfers, then signs and delivers them on the destination.
//
// A chain's side is either a TokenBridge contract or, with `custody: "wallet"`, the relayer's wallet. On a
// wallet side users bridge out by sending the wallet the chain's token with routing attached, and HubWallet
// pays transfers coming in.
import { ethers } from 'ethers';
import { list, loadBridgeDeployment, loadChains, type Chain } from '../config.ts';
import { errorText, providerFor, safeHead, TOKEN_BRIDGE_ABI, txOverrides, withHubLock } from '../evm.ts';
import type { PendingRelease, Store } from '../state.ts';
import { HubWallet } from './hubWallet.ts';
import { releaseId, signRelease } from './message.ts';
import { hubNonce, parseBridgeOut } from './tags.ts';

const MAX_BACKOFF_MS = 5 * 60_000;
// A wallet side has no deploy block. With none recorded, start this far back from the head.
const LOOKBACK = Number(process.env.BRIDGE_LOOKBACK_BLOCKS ?? 20_000);
const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

type Live = {
  chain: Chain;
  provider: ethers.JsonRpcProvider;
  /** Absent on a wallet-held side, where `hubWallet` stands in for it. */
  bridge?: ethers.Contract;
  hubWallet?: HubWallet;
  token: string;
  /** The address signers bind this chain's side to: its TokenBridge, or the relayer wallet. */
  address: string;
  deployBlock: number;
};

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
      const common = { chain, provider, address: dep.TokenBridge, token: dep.token, deployBlock: dep.deployBlock };
      this.live.set(
        chain.chainId,
        dep.custody === 'wallet'
          ? {
              ...common,
              hubWallet: new HubWallet(chain, provider, dep.TokenBridge, dep.token, dep.desk, dep.deployBlock, store, this.submitKey, log),
            }
          : { ...common, bridge: new ethers.Contract(dep.TokenBridge, TOKEN_BRIDGE_ABI, provider) },
      );
    }
  }

  get chainCount(): number {
    return this.live.size;
  }

  async tick(): Promise<void> {
    // One bad RPC must not stop the other chains.
    await Promise.all(
      [...this.live.values()].map((l) =>
        (l.hubWallet ? this.scanWalletIn(l) : this.scanLocked(l)).catch((e) =>
          this.log(`[bridge] ${l.chain.key}: scan failed: ${errorText(e)}`),
        ),
      ),
    );
    this.store.save();
    await Promise.all(
      [...this.live.values()].map((l) =>
        this.deliverTo(l).catch((e) => this.log(`[bridge] ${l.chain.key}: delivery failed: ${errorText(e)}`)),
      ),
    );
  }

  private addPending(key: string, p: Pick<PendingRelease, 'srcChainId' | 'dstChainId' | 'nonce' | 'to' | 'amount' | 'minShares'>): void {
    if (!this.live.has(p.dstChainId)) {
      this.log(`[bridge] ${key}: destination ${p.dstChainId} has no deployment, skipping`);
      return;
    }
    this.store.state.pending[key] ??= { ...p, attempts: 0, nextTry: 0 };
    this.log(`[bridge] ${key}: locked ${p.amount} for ${p.to} -> ${p.dstChainId}`);
  }

  private async scanLocked(l: Live): Promise<void> {
    const { state } = this.store;
    const bridge = l.bridge!;
    const head = await safeHead(l.provider, l.chain);
    let from = state.cursors[l.chain.chainId] ?? l.deployBlock;
    while (from <= head) {
      const to = Math.min(from + l.chain.logChunk - 1, head);
      const logs = await bridge.queryFilter(bridge.filters.Locked(), from, to);
      for (const log of logs as ethers.EventLog[]) {
        if (log.removed) continue;
        const { nonce, dstChainId, to: receiver, amount, minShares } = log.args;
        this.addPending(`${l.chain.chainId}:${nonce}`, {
          srcChainId: l.chain.chainId,
          dstChainId: Number(dstChainId),
          nonce: nonce.toString(),
          to: receiver,
          amount: amount.toString(),
          minShares: minShares.toString(),
        });
      }
      from = to + 1;
      state.cursors[l.chain.chainId] = from;
    }
  }

  /** Bridge-outs from a wallet side: a token transfer to the wallet, with routing after its calldata. */
  private async scanWalletIn(l: Live): Promise<void> {
    const { state } = this.store;
    const token = new ethers.Contract(l.token, TRANSFER_ABI, l.provider);
    const filter = token.filters.Transfer(null, l.address);
    const head = await safeHead(l.provider, l.chain);
    let from = state.cursors[l.chain.chainId] ?? (l.deployBlock || Math.max(0, head - LOOKBACK));
    while (from <= head) {
      const to = Math.min(from + l.chain.logChunk - 1, head);
      for (const log of (await token.queryFilter(filter, from, to)) as ethers.EventLog[]) {
        if (log.removed) continue;
        const tx = await l.provider.getTransaction(log.transactionHash);
        // Must be a direct transfer by the sender, or the routing isn't theirs to give.
        const route = tx?.to && ethers.getAddress(tx.to) === ethers.getAddress(l.token) && tx.from === log.args.from
          ? parseBridgeOut(tx.data)
          : undefined;
        if (!route) {
          this.log(`[bridge] ${l.chain.key}: ${log.transactionHash} sent the wallet ${log.args.value} with no routing, treating it as inventory`);
          continue;
        }
        const nonce = hubNonce(log.blockNumber, log.index);
        this.addPending(`${l.chain.chainId}:${nonce}`, {
          srcChainId: l.chain.chainId,
          dstChainId: route.dstChainId,
          nonce: nonce.toString(),
          to: route.to,
          amount: log.args.value.toString(),
          // Only a transfer into Portaldot can be saved on arrival.
          minShares: (this.live.get(route.dstChainId)?.chain.hub ? (route.minShares ?? 0n) : 0n).toString(),
        });
      }
      from = to + 1;
      state.cursors[l.chain.chainId] = from;
    }
  }

  /** Sequential per destination so one wallet's nonces stay in order. */
  private async deliverTo(dst: Live): Promise<void> {
    const { state } = this.store;
    if (dst.hubWallet) await dst.hubWallet.scanPaid();
    const due = Object.entries(state.pending)
      .filter(([, p]) => p.dstChainId === dst.chain.chainId && p.nextTry <= Date.now())
      .sort(([, a], [, b]) => Number(BigInt(a.nonce) - BigInt(b.nonce)));
    for (const [key, p] of due) {
      try {
        if (dst.hubWallet) await this.deliverToHub(key, p, dst.hubWallet);
        else await this.deliver(key, p, dst);
      } catch (e) {
        p.attempts += 1;
        p.lastError = errorText(e);
        p.nextTry = Date.now() + Math.min(15_000 * 2 ** p.attempts, MAX_BACKOFF_MS);
        this.log(`[bridge] ${key}: attempt ${p.attempts} failed, will retry: ${p.lastError}`);
      }
      this.store.save();
    }
  }

  private async deliverToHub(key: string, p: PendingRelease, hubWallet: HubWallet): Promise<void> {
    if (this.dryRun) {
      this.log(`[bridge] ${key}: dry run, would pay ${p.amount} to ${p.to} on ${p.dstChainId}`);
      return;
    }
    await withHubLock(() => hubWallet.deliver(key, p));
  }

  private async deliver(key: string, p: PendingRelease, dst: Live): Promise<void> {
    const src = this.live.get(p.srcChainId);
    if (!src) throw new Error(`source ${p.srcChainId} has no deployment`);
    const dstBridge = dst.bridge!;

    const nonce = BigInt(p.nonce);
    const amount = BigInt(p.amount);
    const minShares = BigInt(p.minShares);
    const id = releaseId(p.srcChainId, nonce);

    if (await dstBridge.processed(id)) {
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
    const bridge = dstBridge.connect(wallet) as ethers.Contract;
    const args = [p.srcChainId, nonce, p.to, amount, minShares, sigs] as const;

    const estimate = await bridge.release.estimateGas(...args);
    const tx = await bridge.release(...args, { gasLimit: (estimate * 150n) / 100n, ...txOverrides(dst.chain) });
    await tx.wait(1, 180_000);

    delete this.store.state.pending[key];
    this.log(`[bridge] ${key}: released on ${dst.chain.key} (${tx.hash})`);
  }
}
