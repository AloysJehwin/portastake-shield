import { ChipSelect } from "./Select";

/** Chip dropdown for card headers ("Daily / Weekly"). Kept as the name pages already use. */
export function Dropdown<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label?: string;
}) {
  return <ChipSelect {...props} />;
}
