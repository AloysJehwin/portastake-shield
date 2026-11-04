import { createGatewayApp } from "../_lib/gateway.js";

// Built once per warm instance.
const app = createGatewayApp();
export default app;
