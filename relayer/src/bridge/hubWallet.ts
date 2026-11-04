// Delivers transfers from the relayer's wallet on a chain whose side of the bridge is held by that wallet
// rather than a contract. Nothing on-chain stops this wallet paying twice, so this file has to:
//
//  - Every payout is signed and recorded in `inflight` BEFORE broadcast. After a crash the same signed
//    transaction is rebroadcast, and its fixed account nonce means it can only ever land once.
//  - Every payout carries its release id in calldata, so `paid` can be rebuilt from the chain even if
//    the state file is lost.
//  - Nothing is sent while the wallet has an unconfirmed transaction, so a payout still in the
//    mempool (invisible to that rebuild) can't be paid again.
import { ethers } from 'ethers';
import type { Chain } from '../config.ts';
import { errorText } from '../evm.ts';
import type { PendingRelease, Store, WalletState } from '../state.ts';
import { releaseId } from './message.ts';
import { encodePayoutTag, parsePayoutTag } from './tags.ts';

const TUSD = 1_000_000n;
const TPOT = 10n ** 18n;
const ZERO = '0x0000000000000000000000000000000000000000';
const APPROVAL = 10_000n * TUSD;

const TOKEN_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
];
const DESK_ABI = [
  'event StableDeposited(address indexed payer, address indexed receiver, uint256 usdIn, uint256 potIn, uint256 shares)',
  'function depositWithStable(uint256 usdAmount, uint256 minShares, address receiver) returns (uint256)',
];

function envAmount(name: string, fallback: bigint): bigint {
  return process.env[name] ? BigInt(process.env[name]!) : fallback;
}

export class HubWallet {
  private readonly token: ethers.Contract;
  private readonly desk: ethers.Contract;
  private readonly wallet?: ethers.Wallet;
  /** Only a wallet with a desk next to it can save a transfer on arrival. */
  private readonly canSave: boolean;
  private readonly maxPayout = envAmount('BRIDGE_MAX_PAYOUT', 10n * TUSD);
  private readonly dailyCap = envAmount('BRIDGE_DAILY_CAP', 100n * TUSD);
  // Gas guards in the chain's native wei. Portaldot's are in whole tPOT; other chains default to small ETH amounts.
  private readonly maxTxCost: bigint;
  private readonly reserve: bigint;
  private readonly waitMs = Number(process.env.BRIDGE_TX_WAIT_MS ?? 180_000);

  constructor(
    private readonly chain: Chain,
    private readonly provider: ethers.JsonRpcProvider,
    readonly address: string,
    tokenAddress: string,
    deskAddress: string,
    private readonly deployBlock: number,
    private readonly store: Store,
    key: string | undefined,
    private readonly log: (message: string) => void,
  ) {
    this.token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
    this.desk = new ethers.Contract(deskAddress || ZERO, DESK_ABI, provider);
    this.canSave = !!deskAddress && deskAddress !== ZERO;
    this.maxTxCost = chain.hub
      ? envAmount('BRIDGE_MAX_TX_TPOT', 20n) * TPOT
      : envAmount(`BRIDGE_MAX_TX_WEI_${chain.chainId}`, envAmount('BRIDGE_MAX_TX_WEI', 10n ** 16n));
    this.reserve = chain.hub
      ? envAmount('BRIDGE_TPOT_RESERVE', 5n) * TPOT
      : envAmount(`BRIDGE_RESERVE_WEI_${chain.chainId}`, envAmount('BRIDGE_RESERVE_WEI', 10n ** 15n));
    if (key) {
      const wallet = new ethers.Wallet(key, provider);
      if (wallet.address !== ethers.getAddress(address)) {
        throw new Error(`RELAYER_KEY is ${wallet.address}, but ${chain.name}'s bridge wallet is ${address}`);
      }
      this.wallet = wallet;
    }
  }

  /** Portaldot keeps its bookkeeping at the top of the state file; every other chain has its own entry. */
  private get ws(): WalletState {
    const { state } = this.store;
    if (this.chain.hub) return state;
    state.wallets ??= {};
    return (state.wallets[this.chain.chainId] ??= { paid: {}, spend: { day: '', amount: '0' } });
  }

  /** Rebuilds `paid` from the wallet's own tagged transfers. Saves show up as its Transfer to the desk. */
  async scanPaid(): Promise<void> {
    const state = this.ws;
    const latest = await this.provider.getBlockNumber();
    const finalized = (await this.provider.getBlock('finalized'))?.number ?? latest;
    const filter = this.token.filters.Transfer(this.address);
    // A wallet side has no deploy block; with none recorded, look back a bounded distance from the head.
    let from = state.paidCursor ?? (this.deployBlock || Math.max(0, latest - Number(process.env.BRIDGE_LOOKBACK_BLOCKS ?? 20_000)));
    const start = from;
    while (from <= latest) {
      const to = Math.min(from + this.chain.logChunk - 1, latest);
      for (const log of await this.token.queryFilter(filter, from, to)) {
        const tx = await this.provider.getTransaction(log.transactionHash);
        const id = tx && parsePayoutTag(tx.data);
        if (id) state.paid[id] = log.transactionHash;
      }
      from = to + 1;
    }
    // Scanned to the tip, but only finalized blocks are never looked at again.
    state.paidCursor = Math.max(start, Math.min(finalized + 1, latest + 1));
  }

  async deliver(key: string, p: PendingRelease): Promise<void> {
    const state = this.ws;
    const pending = this.store.state.pending;
    const id = releaseId(p.srcChainId, BigInt(p.nonce));
    await this.settleInflight();

    if (state.paid[id]) {
      this.log(`[bridge] ${key}: already paid (${state.paid[id]})`);
      delete pending[key];
      return;
    }
    if (!this.wallet) throw new Error('RELAYER_KEY is required');

    const nonce = await this.provider.getTransactionCount(this.address, 'latest');
    if ((await this.provider.getTransactionCount(this.address, 'pending')) !== nonce) {
      throw new Error('the wallet has an unconfirmed transaction, waiting for it');
    }

    const amount = BigInt(p.amount);
    if (amount > this.maxPayout) throw new Error(`${amount} is over the ${this.maxPayout} payout limit`);
    const day = new Date().toISOString().slice(0, 10);
    const spent = state.spend.day === day ? BigInt(state.spend.amount) : 0n;
    if (spent + amount > this.dailyCap) throw new Error(`the ${this.dailyCap} daily limit is used up`);
    const held: bigint = await this.token.balanceOf(this.address);
    if (amount > held) throw new Error(`the wallet holds ${held} of the token, needs ${amount}`);

    const minShares = BigInt(p.minShares);
    const tag = encodePayoutTag(id).slice(2);
    let saving = false;
    let data = this.token.interface.encodeFunctionData('transfer', [p.to, amount]) + tag;
    let to = await this.token.getAddress();

    if (minShares > 0n && this.canSave) {
      await this.ensureAllowance(amount);
      const deposit = this.desk.interface.encodeFunctionData('depositWithStable', [amount, minShares, p.to]) + tag;
      const deskAddress = await this.desk.getAddress();
      try {
        await this.provider.call({ from: this.address, to: deskAddress, data: deposit });
        saving = true;
        data = deposit;
        to = deskAddress;
      } catch (e) {
        this.log(`[bridge] ${key}: the desk can't take the save: ${errorText(e)}`);
      }
    }

    const receipt = await this.send({ to, data }, id);
    if (!receipt) throw new Error('the payout is still unconfirmed');

    state.spend = { day, amount: (spent + amount).toString() };
    state.paid[id] = receipt.hash;
    delete pending[key];
    if (saving) {
      this.log(`[bridge] ${key}: saved on ${this.chain.key}, shares ${this.sharesIn(receipt)} (${receipt.hash})`);
    } else {
      this.log(`[bridge] ${key}: delivered on ${this.chain.key}${minShares > 0n ? ' unsaved' : ''} (${receipt.hash})`);
    }
  }

  private sharesIn(receipt: ethers.TransactionReceipt): bigint {
    for (const log of receipt.logs) {
      try {
        const parsed = this.desk.interface.parseLog(log);
        if (parsed?.name === 'StableDeposited') return parsed.args.shares;
      } catch {
        // Some other contract's event.
      }
    }
    return 0n;
  }

  private async ensureAllowance(amount: bigint): Promise<void> {
    const deskAddress = await this.desk.getAddress();
    if ((await this.token.allowance(this.address, deskAddress)) >= amount) return;
    const data = this.token.interface.encodeFunctionData('approve', [deskAddress, APPROVAL]);
    const receipt = await this.send({ to: await this.token.getAddress(), data });
    if (!receipt) throw new Error('the desk approval is still unconfirmed');
  }

  /** Signs, records, then broadcasts. Returns undefined if it hasn't confirmed by the deadline. */
  private async send(request: { to: string; data: string }, id?: string): Promise<ethers.TransactionReceipt | undefined> {
    const wallet = this.wallet!;
    const state = this.ws;
    const estimate = await this.provider.estimateGas({ ...request, from: this.address });
    const gasLimit = (estimate * 120n) / 100n;
    const gasPrice = (await this.provider.getFeeData()).gasPrice ?? 0n;

    // A mispriced transaction must never be able to drain the wallet's gas.
    const cost = gasLimit * gasPrice;
    const unit = this.chain.hub ? 'tPOT' : 'native';
    if (cost > this.maxTxCost) throw new Error(`would cost ${ethers.formatEther(cost)} ${unit}, over the limit`);
    const balance = await this.provider.getBalance(this.address);
    if (balance < cost + this.reserve) {
      throw new Error(`holds ${ethers.formatEther(balance)} ${unit}, needs ${ethers.formatEther(cost + this.reserve)} with the reserve`);
    }

    const nonce = await this.provider.getTransactionCount(this.address, 'latest');
    const raw = await wallet.signTransaction({
      ...request,
      from: this.address,
      nonce,
      gasLimit,
      gasPrice,
      chainId: this.chain.chainId,
      type: this.chain.legacy ? 0 : undefined,
    });
    state.inflight = { raw, hash: ethers.keccak256(raw), nonce, ...(id ? { id } : {}) };
    this.store.save();
    return this.broadcastAndWait();
  }

  /** Finishes whatever a crashed run left signed. Throws while it is still unconfirmed. */
  private async settleInflight(): Promise<void> {
    const state = this.ws;
    const inflight = state.inflight;
    if (!inflight) return;

    const existing = await this.provider.getTransactionReceipt(inflight.hash);
    if (!existing && (await this.provider.getTransactionCount(this.address, 'latest')) > inflight.nonce) {
      // Another transaction took this nonce, so this one can never land. The tagged-transfer scan decides
      // whether its payout happened some other way.
      this.log(`[bridge] transaction ${inflight.hash} was replaced`);
      delete state.inflight;
      this.store.save();
      return;
    }
    const receipt = existing ?? (await this.broadcastAndWait());
    if (!receipt) throw new Error(`transaction ${inflight.hash} is still unconfirmed`);
    if (existing) this.finish(existing);
  }

  private async broadcastAndWait(): Promise<ethers.TransactionReceipt | undefined> {
    const inflight = this.ws.inflight!;
    try {
      await this.provider.broadcastTransaction(inflight.raw);
    } catch (e) {
      const text = errorText(e).toLowerCase();
      // Only forget a transaction the node definitely refused. A network error may mean it was accepted,
      // so it stays recorded and is settled by its hash or nonce on the next pass.
      if (/insufficient funds|invalid transaction|intrinsic gas|underpriced/.test(text)) {
        delete this.ws.inflight;
        this.store.save();
        throw e;
      }
      if (!/already|known|nonce (has already been used|too low)/.test(text)) throw e;
    }
    const receipt = await this.provider.waitForTransaction(inflight.hash, 1, this.waitMs).catch((e) => {
      if ((e as { code?: string }).code === 'TIMEOUT') return null;
      throw e;
    });
    if (!receipt) return undefined;
    this.finish(receipt);
    if (receipt.status !== 1) throw new Error(`transaction ${receipt.hash} reverted`);
    return receipt;
  }

  private finish(receipt: ethers.TransactionReceipt): void {
    const state = this.ws;
    if (receipt.status === 1 && state.inflight?.id) state.paid[state.inflight.id] = receipt.hash;
    delete state.inflight;
    this.store.save();
  }
}
