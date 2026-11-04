// Serve the on-chain tools locally for `pnpm dev` (Vite proxies /api here).
//   FACILITATOR_KEY=0x… pnpm tools
import { createToolsApp } from "../api/_lib/tools.js";

const port = Number(process.env.TOOLS_PORT ?? 4021);
createToolsApp().listen(port, () => console.log(`on-chain tools → http://localhost:${port}/api/tools/catalog`));
