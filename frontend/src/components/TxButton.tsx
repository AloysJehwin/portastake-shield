import { useEffect, useState, type ReactNode } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import type { Address, Abi } from "viem";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { Button } from "./primitives";

type Props = {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  disabled?: boolean;
  onSuccess?: () => void;
  children?: ReactNode;
};

/**
 * Wraps `useWriteContract` with a consistent idle → mining → confirmed → reverted
 * lifecycle so pages stop re-implementing it. Shows the latest tx hash truncated.
 */
export function TxButton({ label, address, abi, functionName, args, value, disabled, onSuccess }: Props) {
  const { isConnected } = useAccount();
  const { writeContract, data: hash, isPending, reset, error } = useWriteContract();
  const { isLoading: mining, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash });
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (confirmed && !done) {
      setDone(true);
      onSuccess?.();
      // Clear the success state after a moment so a second tx starts clean.
      const t = setTimeout(() => {
        reset();
        setDone(false);
      }, 3_000);
      return () => clearTimeout(t);
    }
  }, [confirmed, done, onSuccess, reset]);

  const busy = isPending || mining;

  return (
    <div className="space-y-2">
      <Button
        onClick={() =>
          writeContract({
            address,
            abi,
            functionName,
            args,
            ...(value !== undefined ? { value } : {}),
          })
        }
        disabled={disabled || busy || !isConnected || done}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            {isPending ? "Confirm in wallet…" : "Submitting…"}
          </>
        ) : done ? (
          <>
            <CheckCircle2 size={14} /> Done
          </>
        ) : (
          label
        )}
      </Button>
      {error && (
        <div className="flex items-start gap-2 text-xs text-danger">
          <AlertCircle size={14} className="mt-0.5" aria-hidden />
          <span className="truncate">{normaliseError(error)}</span>
        </div>
      )}
    </div>
  );
}

function normaliseError(e: unknown): string {
  if (!e || typeof e !== "object") return String(e);
  // viem shortMessage is the one-liner we want. shortMessage|message|…
  const anyE = e as { shortMessage?: string; message?: string };
  return anyE.shortMessage ?? anyE.message ?? "Transaction failed";
}
