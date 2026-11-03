import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Hash } from "viem";
import { ExternalLink } from "lucide-react";
import { accountUrl, blockUrl } from "../explorer";
import { shortAddress } from "../format";

const linkCls = "inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline num";

/**
 * Link to a transaction on the explorer. Pass `blockNumber` when you already have
 * it (event logs do); otherwise the receipt is fetched to find the block.
 */
export function TxLink({
  hash,
  blockNumber,
  label,
}: {
  hash: Hash;
  blockNumber?: bigint;
  label?: string;
}) {
  const client = usePublicClient();
  const [block, setBlock] = useState<bigint | undefined>(blockNumber);

  useEffect(() => {
    if (blockNumber !== undefined) {
      setBlock(blockNumber);
      return;
    }
    if (!client) return;
    let cancelled = false;
    let tries = 0;
    // The receipt can lag the hash by a block or two; retry briefly.
    const look = async () => {
      try {
        const r = await client.getTransactionReceipt({ hash });
        if (!cancelled) setBlock(r.blockNumber);
      } catch {
        if (!cancelled && ++tries < 10) setTimeout(look, 3_000);
      }
    };
    void look();
    return () => {
      cancelled = true;
    };
  }, [client, hash, blockNumber]);

  const text = label ?? `tx ${shortAddress(hash, 6)}`;
  if (block === undefined) {
    return (
      <span className={linkCls} title={hash}>
        {text}
      </span>
    );
  }
  return (
    <a
      href={blockUrl(block)}
      target="_blank"
      rel="noreferrer"
      className={linkCls}
      title={`${hash} · block #${block.toString()}`}
      onClick={(e) => e.stopPropagation()}
    >
      {text} <ExternalLink size={11} aria-hidden />
    </a>
  );
}

/** Link to an address's account page on the explorer. */
export function AddressLink({ address, label }: { address: Address; label?: string }) {
  return (
    <a
      href={accountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className={linkCls}
      title={address}
      onClick={(e) => e.stopPropagation()}
    >
      {label ?? shortAddress(address)} <ExternalLink size={11} aria-hidden />
    </a>
  );
}
