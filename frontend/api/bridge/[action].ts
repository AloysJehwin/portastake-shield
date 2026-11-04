import { createBridgeApp } from "../_lib/bridge.js";

// Built once per warm instance.
const app = createBridgeApp();
export default app;
