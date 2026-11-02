import { Shield } from "lucide-react";

export function PolicyBadge({ policyId }: { policyId: bigint | undefined }) {
  if (policyId === undefined || policyId === 0n) return null;
  return (
    <span className="chip" title={`Policy #${policyId}`}>
      <Shield size={12} aria-hidden />
      Covered
      <span className="text-fg-subtle num">#{policyId.toString()}</span>
    </span>
  );
}
