import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "chain/index": "src/chain/index.ts",
      "x402/index": "src/x402/index.ts",
      "x402/server": "src/x402/server.ts",
      "x402/facilitator": "src/x402/facilitator.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    splitting: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
  },
]);
