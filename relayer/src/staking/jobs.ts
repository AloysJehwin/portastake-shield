// Portaldot-only jobs: keep the price feed fresh, move POT into staking, and report rewards to the vault.
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { list, loadChains, loadHubAddresses, type Chain } from '../config.ts';
import { DESK_ABI, providerFor, txOverrides, VAULT_ABI, withHubLock } from '../evm.ts';
import type { Store } from '../state.ts';
import { decidePrice, fallbackAccountOf, h160OfAccount, NATIVE_UNIT, planBond, planSweep, quoteToPrice } from './plan.ts';

const PUSD_ASSET = 7777;
const ONE_POT_PLANCK = 100_000_000_000_000n; // 14 dp
const FEE_RESERVE_PLANCK = 2n * ONE_POT_PLANCK; // covers the existential deposit and fees
const MIN_SWEEP_WEI = 10n ** 18n;
const GAS_RESERVE_WEI = 2n * 10n ** 18n;

type Api = any; // the runtime's calls are decorated from metadata, so @polkadot/api can't type them statically

export class StakingJobs {
  private readonly hub: Chain;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet?: ethers.Wallet;
  private readonly vault: ethers.Contract;
  private readonly desk: ethers.Contract;
  private api?: Api;
  private stash?: KeyringPair;
  private stashAddress?: string;

  constructor(private readonly store: Store, private readonly dryRun: boolean, private readonly log = console.log) {
    const hub = loadChains().find((c) => c.hub);
    if (!hub) throw new Error('bridge-chains.json has no hub chain');
    this.hub = hub;
    this.provider = providerFor(hub);
    const a = loadHubAddresses(hub.chainId);
    if (process.env.RELAYER_KEY) this.wallet = new ethers.Wallet(process.env.RELAYER_KEY, this.provider);
    const runner = this.wallet ?? this.provider;
    this.vault = new ethers.Contract(a.StakingVault, VAULT_ABI, runner);
    this.desk = new ethers.Contract(a.SwapDesk, DESK_ABI, runner);
  }

  async connect(): Promise<void> {
    if (this.api) return;
    await cryptoWaitReady();
    this.api = await ApiPromise.create({
      provider: new WsProvider(process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev'),
      noInitWarn: true,
    });
    const keyring = new Keyring({ type: 'sr25519', ss58Format: this.api.registry.chainSS58 });
    if (process.env.STASH_SURI) {
      this.stash = keyring.addFromUri(process.env.STASH_SURI);
    } else if (process.env.STASH_JSON) {
      this.stash = keyring.addFromJson(JSON.parse(readFileSync(process.env.STASH_JSON, 'utf8')));
      this.stash.unlock(process.env.STASH_PASSWORD ?? '');
    }
    this.stashAddress = this.stash?.address ?? process.env.STASH_SS58;
  }

  async disconnect(): Promise<void> {
    await this.api?.disconnect();
    this.api = undefined;
  }

  private async sendEvm(label: string, send: (o: object) => Promise<ethers.TransactionResponse>): Promise<void> {
    if (this.dryRun || !this.wallet) {
      this.log(`[${label}] dry run, no transaction sent`);
      return;
    }
    const tx = await send(txOverrides(this.hub));
    await tx.wait(1, 180_000);
    this.log(`[${label}] confirmed ${tx.hash}`);
  }

  /** Resolves at in-block with the events, and rejects if the extrinsic failed. */
  private sendSubstrate(tx: any): Promise<any[]> {
    return new Promise((resolve, reject) => {
      tx.signAndSend(this.stash, ({ status, events, dispatchError }: any) => {
        if (dispatchError) {
          const detail = dispatchError.isModule ? this.api.registry.findMetaError(dispatchError.asModule) : null;
          reject(new Error(detail ? `${detail.section}.${detail.name}` : dispatchError.toString()));
        } else if (status.isInBlock || status.isFinalized) {
          resolve(events);
        }
      }).catch(reject);
    });
  }

  async price(): Promise<void> {
    await this.connect();
    const quote = await this.api.call.assetConversionApi.quotePriceExactTokensForTokens(
      'Native',
      { WithId: PUSD_ASSET },
      ONE_POT_PLANCK,
      true,
    );
    if (quote.isNone) return this.log('[price] the pool returned no quote');

    const pool = quoteToPrice(BigInt(quote.unwrap().toString()));
    const head = await this.provider.getBlock('latest');
    if (!head) throw new Error('node returned no latest block');
    const [current, updatedAt, maxAge] = await Promise.all([this.desk.price(), this.desk.updatedAt(), this.desk.maxAge()]);
    const decision = decidePrice({ current, quote: pool, age: BigInt(head.timestamp) - updatedAt, maxAge });

    this.log(`[price] desk ${ethers.formatEther(current)}, pool ${ethers.formatEther(pool)}: ${decision.reason}`);
    if (decision.update) await this.sendEvm('price', (o) => this.desk.setPrice(pool, o));
  }

  async staking(): Promise<void> {
    await this.connect();
    if (!this.stashAddress) return this.log('[staking] no stash configured (STASH_SURI, STASH_JSON or STASH_SS58)');
    if (await this.ensureMapped()) {
      await this.sweep();
      await this.bond();
    }
    await this.claimRewards();
    await this.reportRewards();
  }

  /** Swept POT only reaches the stash if the vault points at its mapped H160. */
  private async ensureMapped(): Promise<boolean> {
    const accountId = decodeAddress(this.stashAddress!);
    const h160 = h160OfAccount(accountId);

    const original = await this.api.query.revive.originalAccount(h160);
    if (original.isNone) {
      this.log(`[staking] stash is not mapped to ${h160}`);
      if (this.dryRun || !this.stash) return false;
      await this.sendSubstrate(this.api.tx.revive.mapAccount());
      this.log('[staking] mapped the stash');
    }
    const configured: string = await this.vault.stakingAccount();
    if (configured !== h160) {
      this.log(`[staking] NOT sweeping: vault.stakingAccount is ${configured}, the stash is ${h160}. Admin must call setStakingAccount(${h160})`);
      return false;
    }
    return true;
  }

  private async sweep(): Promise<void> {
    const [liquid, totalAssets, targetHotBps] = await Promise.all([
      this.vault.availableLiquidity(),
      this.vault.totalAssets(),
      this.vault.targetHotBps(),
    ]);
    const amount = planSweep({ liquid, totalAssets, targetHotBps, minSweep: MIN_SWEEP_WEI });
    this.log(`[sweep] liquid ${ethers.formatEther(liquid)}, can sweep ${ethers.formatEther(amount)}`);
    if (amount > 0n) await this.sendEvm('sweep', (o) => this.vault.sweepToStake(amount, o));
  }

  private async bond(): Promise<void> {
    const { data } = await this.api.query.system.account(this.stashAddress);
    const transferable = BigInt(data.free.toString()) - BigInt(data.frozen.toString());
    const amount = planBond({ transferable, keep: FEE_RESERVE_PLANCK, minBond: ONE_POT_PLANCK });
    const bonded = (await this.api.query.staking.bonded(this.stashAddress)).isSome;
    this.log(`[bond] transferable ${transferable} planck, can bond ${amount}, already bonded: ${bonded}`);

    if (amount > 0n && !this.dryRun && this.stash) {
      if (bonded) {
        await this.sendSubstrate(this.api.tx.staking.bondExtra(amount));
      } else {
        // Rewards go straight to the relayer's EVM account, which is what pays notifyReward.
        if (!this.wallet) throw new Error('RELAYER_KEY is required to set the reward destination');
        const payee = { Account: fallbackAccountOf(this.wallet.address) };
        await this.sendSubstrate(this.api.tx.staking.bond(amount, payee));
      }
      this.log(`[bond] bonded ${amount} planck`);
    }

    const nominations = await this.api.query.staking.nominators(this.stashAddress);
    if (nominations.isNone && (bonded || amount > 0n) && !this.dryRun && this.stash) {
      const configured = list(process.env.NOMINATE);
      const targets = configured.length ? configured : (await this.api.query.session.validators()).map(String);
      await this.sendSubstrate(this.api.tx.staking.nominate(targets));
      this.log(`[bond] nominated ${targets.join(', ')}`);
    }
  }

  private async claimRewards(): Promise<void> {
    const { state } = this.store;
    const nominations = await this.api.query.staking.nominators(this.stashAddress);
    const active = (await this.api.query.staking.activeEra()).unwrap().index.toNumber();
    if (nominations.isNone) {
      // No exposure yet, so nothing older than this era can be owed.
      state.lastPaidEra = active - 1;
      this.store.save();
      return this.log(`[rewards] not nominating yet (era ${active})`);
    }
    const targets = nominations.unwrap().targets.map(String);

    for (let era = (state.lastPaidEra ?? active - 1) + 1; era < active; era++) {
      for (const validator of targets) {
        const overview = await this.api.query.staking.erasStakersOverview(era, validator);
        if (overview.isNone) continue;
        const claimed = (await this.api.query.staking.claimedRewards(era, validator)).map(Number);
        for (let page = 0; page < overview.unwrap().pageCount.toNumber(); page++) {
          if (claimed.includes(page)) continue;
          const exposure = await this.api.query.staking.erasStakersPaged(era, validator, page);
          if (exposure.isNone || !exposure.unwrap().others.some((o: any) => o.who.toString() === this.stashAddress)) continue;
          if (this.dryRun || !this.stash) {
            this.log(`[rewards] dry run, would claim era ${era} from ${validator}`);
            continue;
          }
          const events = await this.sendSubstrate(this.api.tx.staking.payoutStakersByPage(validator, era, page));
          for (const { event } of events) {
            if (event.section === 'staking' && event.method === 'Rewarded' && event.data[0].toString() === this.stashAddress) {
              const amount = BigInt(event.data[event.data.length - 1].toString());
              state.unreportedRewards = (BigInt(state.unreportedRewards) + amount).toString();
              this.log(`[rewards] era ${era}: claimed ${amount} planck`);
            }
          }
          this.store.save();
        }
      }
      if (!this.dryRun && this.stash) {
        state.lastPaidEra = era;
        this.store.save();
      }
    }
  }

  private async reportRewards(): Promise<void> {
    const { state } = this.store;
    const value = BigInt(state.unreportedRewards) * NATIVE_UNIT;
    if (value === 0n) return;

    if (this.wallet) {
      const balance = await this.provider.getBalance(this.wallet.address);
      if (balance < value + GAS_RESERVE_WEI) {
        return this.log(`[rewards] relayer holds ${ethers.formatEther(balance)}, needs ${ethers.formatEther(value)} plus gas`);
      }
    }
    await this.sendEvm('rewards', (o) => this.vault.notifyReward({ value, ...o }));
    if (!this.dryRun && this.wallet) {
      state.unreportedRewards = '0';
      this.store.save();
    }
  }
}
