// EVM helpers shared by every job.
import { ethers } from 'ethers';
import type { Chain } from './config.ts';

export const TOKEN_BRIDGE_ABI = [
  'event Locked(uint64 indexed nonce, uint256 indexed dstChainId, address indexed sender, address to, uint256 amount, uint256 minShares)',
  'event Released(bytes32 indexed id, uint256 indexed srcChainId, uint64 nonce, address indexed to, uint256 amount, uint256 shares)',
  'function remotes(uint256 chainId) view returns (address)',
  'function processed(bytes32 id) view returns (bool)',
  'function threshold() view returns (uint8)',
  'function isSigner(address) view returns (bool)',
  'function releaseId(uint256 srcChainId, uint64 srcNonce) pure returns (bytes32)',
  'function release(uint256 srcChainId, uint64 srcNonce, address to, uint256 amount, uint256 minShares, bytes sigs) returns (uint256)',
];

export const VAULT_ABI = [
  'function availableLiquidity() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function targetHotBps() view returns (uint256)',
  'function bondedPrincipal() view returns (uint256)',
  'function stakingAccount() view returns (address)',
  'function sweepToStake(uint256 amount)',
  'function notifyReward() payable',
];

export const DESK_ABI = [
  'function price() view returns (uint256)',
  'function updatedAt() view returns (uint64)',
  'function maxAge() view returns (uint64)',
  'function setPrice(uint256 newPrice)',
];

export function providerFor(chain: Chain): ethers.JsonRpcProvider {
  // The revive RPC drops connections under load, so send one request at a time. No response cache:
  // a cached nonce would make back-to-back releases collide.
  return new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
}

/** Highest block we trust a log from. */
export async function safeHead(provider: ethers.JsonRpcProvider, chain: Chain): Promise<number> {
  if (chain.finality === 'finalized') {
    const block = await provider.getBlock('finalized');
    if (!block) throw new Error(`${chain.key}: node returned no finalized block`);
    return block.number;
  }
  return (await provider.getBlockNumber()) - chain.finality;
}

/** Portaldot needs type-0 transactions: revive folds its storage deposit into the gas field. */
export function txOverrides(chain: Chain): { type?: number } {
  return chain.legacy ? { type: 0 } : {};
}

export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; message?: string };
  return err.shortMessage ?? err.reason ?? err.message ?? String(e);
}
