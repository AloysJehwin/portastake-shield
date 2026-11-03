// The message signers attest to. Must stay byte-identical to TokenBridge.releaseDigest.
import { ethers } from 'ethers';

const RELEASE_TYPEHASH = ethers.id(
  'PortaStakeRelease(uint256 srcChainId,address srcBridge,uint256 dstChainId,address dstBridge,uint64 nonce,address to,uint256 amount,uint256 minShares)',
);

export type ReleaseMessage = {
  srcChainId: number;
  srcBridge: string;
  dstChainId: number;
  dstBridge: string;
  nonce: bigint;
  to: string;
  amount: bigint;
  minShares: bigint;
};

export function releaseDigest(m: ReleaseMessage): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'uint256', 'address', 'uint64', 'address', 'uint256', 'uint256'],
      [RELEASE_TYPEHASH, m.srcChainId, m.srcBridge, m.dstChainId, m.dstBridge, m.nonce, m.to, m.amount, m.minShares],
    ),
  );
}

export function releaseId(srcChainId: number, nonce: bigint): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint64'], [srcChainId, nonce]));
}

/** Concatenated signatures ordered by ascending signer address, as TokenBridge requires. */
export async function signRelease(m: ReleaseMessage, signers: ethers.Wallet[]): Promise<string> {
  const digest = ethers.getBytes(releaseDigest(m));
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const sigs = await Promise.all(sorted.map((s) => s.signMessage(digest)));
  return ethers.concat(sigs);
}
