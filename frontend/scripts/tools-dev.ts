// Serve the app's functions locally for `pnpm dev` (Vite proxies /api here): on-chain tools, the API
// gateway and bridge delivery. Each app only answers under its own /api/<name> prefix.
//   FACILITATOR_KEY=0x… BRIDGE_KEY=0x… pnpm tools
import express from "express";
import { createToolsApp } from "../api/_lib/tools.js";
import { createGatewayApp } from "../api/_lib/gateway.js";
import { createBridgeApp } from "../api/_lib/bridge.js";

const port = Number(process.env.TOOLS_PORT ?? 4021);
const app = express();
app.use(createGatewayApp());
app.use(createBridgeApp());
app.use(createToolsApp());
app.listen(port, () => console.log(`functions → http://localhost:${port}/api/tools/catalog`));
