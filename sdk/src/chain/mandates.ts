import { zeroAddress, type Abi, type Address } from "viem";
import { MandateManagerAbi } from "../abi/MandateManager.js";
import type { PortaStake, TxResult } from "./client.js";

/** SAVE moves tUSD into stPOT; PAY sells stPOT and sends tUSD to `payee`. */
export enum Direction {
  SAVE = 0,
  PAY = 1,
}

/** RECURRING runs every `interval`; SCHEDULED runs once at `start`; THRESHOLD keeps a balance at `bound`. */
export enum Trigger {
  RECURRING = 0,
  SCHEDULED = 1,
  THRESHOLD = 2,
}

export type MandateParams = {
  dir: Direction;
  trig: Trigger;
  /** PAY only: who receives the tUSD. Zero means the owner. */
  payee?: Address;
  /** Per-run amount (or per-run cap for THRESHOLD), tUSD with 6 decimals. */
  amount: bigint;
  /** THRESHOLD only: the tUSD balance to keep. */
  bound?: bigint;
  /** First run, unix seconds. 0 means now. */
  start?: bigint;
  /** RECURRING period, or THRESHOLD cooldown, in seconds. Required for both. */
  interval?: number;
  /** 0 means unlimited. */
  maxRuns?: number;
  /** Unix seconds; 0 means never. */
  expiry?: bigint;
  maxSlippageBps?: number;
};

export type Mandate = {
  id: bigint;
  owner: Address;
  nextRun: bigint;
  dir: Direction;
  trig: Trigger;
  active: boolean;
  payee: Address;
  interval: number;
  runs: number;
  maxRuns: number;
  amount: bigint;
  bound: bigint;
  expiry: bigint;
  maxSlippageBps: number;
};

export const DAY = 86_400;
export const WEEK = 7 * DAY;

/**
 * Save and pay rules on MandateManager. Owners create, pause, resume and cancel them; anyone can
 * `execute` a due one, which is what the keeper does. The contract enforces every rule.
 */
export function mandates(ps: PortaStake) {
  const manager = ps.addresses.MandateManager;
  const abi = MandateManagerAbi as Abi;
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ps.publicClient.readContract({ address: manager, abi, functionName, args }) as Promise<T>;

  async function count(): Promise<bigint> {
    return read<bigint>("nextId");
  }

  async function get(id: bigint): Promise<Mandate> {
    const m = await read<Omit<Mandate, "id">>("getMandate", [id]);
    return { id, ...m } as Mandate;
  }

  async function isDue(id: bigint): Promise<{ due: boolean; amount: bigint }> {
    const [due, amount] = await read<readonly [boolean, bigint]>("isDue", [id]);
    return { due, amount };
  }

  /** Every live mandate owned by `owner`. Walks ids [0, nextId). */
  async function listByOwner(owner: Address): Promise<Mandate[]> {
    const n = await count();
    const all = await Promise.all(Array.from({ length: Number(n) }, (_, i) => get(BigInt(i))));
    return all.filter((m) => m.owner.toLowerCase() === owner.toLowerCase());
  }

  /** Ids that are due right now, with the amount each would move. */
  async function due(): Promise<Array<{ id: bigint; amount: bigint }>> {
    const n = Number(await count());
    const out: Array<{ id: bigint; amount: bigint }> = [];
    for (let i = 0; i < n; i++) {
      const r = await isDue(BigInt(i));
      if (r.due) out.push({ id: BigInt(i), amount: r.amount });
    }
    return out;
  }

  /**
   * Create a rule. SAVE pulls tUSD from you, and PAY pulls stPOT, so the matching allowance to
   * MandateManager is set first if it is missing.
   */
  async function create(p: MandateParams): Promise<TxResult> {
    const params = {
      dir: p.dir,
      trig: p.trig,
      payee: p.payee ?? zeroAddress,
      amount: p.amount,
      bound: p.bound ?? 0n,
      start: p.start ?? 0n,
      interval: p.interval ?? 0,
      maxRuns: p.maxRuns ?? 0,
      expiry: p.expiry ?? 0n,
      maxSlippageBps: p.maxSlippageBps ?? 50,
    };
    if (p.dir === Direction.SAVE) await ps.ensureAllowance(ps.addresses.tUSD, manager, p.amount);
    else await ps.ensureAllowance(ps.addresses.StakingVault, manager, 1n);
    return ps.send(manager, abi, "create", [params]);
  }

  return {
    address: manager,
    count,
    get,
    isDue,
    due,
    listByOwner,
    create,
    pause: (id: bigint) => ps.send(manager, abi, "pauseMandate", [id]),
    resume: (id: bigint) => ps.send(manager, abi, "resumeMandate", [id]),
    cancel: (id: bigint) => ps.send(manager, abi, "cancel", [id]),
    /** Run a due mandate. Permissionless: any funded account may call it. */
    execute: (id: bigint) => ps.send(manager, abi, "execute", [id]),
  };
}
