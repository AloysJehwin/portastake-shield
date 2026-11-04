import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { xusd, formatXusd, getOffer, createPayingFetch, XUSD, NETWORK } from "../src/x402/index.js";
import { xusdPaywall, x402Cors } from "../src/x402/server.js";
import { createFacilitator } from "../src/x402/facilitator.js";

describe("amounts", () => {
  it("converts whole xUSD to base units and back", () => {
    expect(xusd("0.01")).toBe(10_000n);
    expect(xusd(1)).toBe(1_000_000n);
    expect(formatXusd(10_000n)).toBe("0.01");
  });
});

describe("paywall", () => {
  const PAY_TO = "0x000000000000000000000000000000000000dEaD";
  const servers: Server[] = [];
  let api = "";
  const listen = (app: express.Express) =>
    new Promise<string>((resolve) => {
      const s = app.listen(0, () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`));
      servers.push(s);
    });

  beforeAll(async () => {
    // A real facilitator in-process: /supported needs no chain access.
    const facilitatorUrl = await listen(createFacilitator({ privateKey: generatePrivateKey() }).app);
    const app = express();
    app.use(x402Cors(["https://app.example"]));
    app.use(xusdPaywall({ facilitatorUrl, routes: { "GET /paid": { price: "0.01", payTo: PAY_TO, description: "test" } } }));
    app.get("/paid", (_req, res) => res.json({ ok: true }));
    app.get("/free", (_req, res) => res.json({ free: true }));
    api = await listen(app);
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it("answers 402 with the xUSD price", async () => {
    const offer = await getOffer(`${api}/paid`);
    expect(offer).not.toBeNull();
    expect(offer!.amount).toBe(10_000n);
    expect(offer!.asset.toLowerCase()).toBe(XUSD.toLowerCase());
    expect(offer!.payTo).toBe(PAY_TO);
    expect(offer!.network).toBe(NETWORK);
    expect(offer!.description).toBe("test");
  });

  it("leaves free routes alone", async () => {
    expect(await getOffer(`${api}/free`)).toBeNull();
  });

  it("exposes x402 headers to allowed browser origins", async () => {
    const r = await fetch(`${api}/paid`, { headers: { Origin: "https://app.example" } });
    expect(r.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
    const other = await fetch(`${api}/paid`, { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("works with an in-process facilitator", async () => {
    const app = express();
    const { client } = createFacilitator({ privateKey: generatePrivateKey() });
    app.use(xusdPaywall({ facilitator: client, routes: { "GET /tool": { price: "0.02", payTo: PAY_TO } } }));
    app.get("/tool", (_req, res) => res.json({ ok: true }));
    const url = await listen(app);
    expect((await getOffer(`${url}/tool`))!.amount).toBe(20_000n);
  });

  it("refuses to sign above the spend limit", async () => {
    const pay = createPayingFetch({ payer: privateKeyToAccount(generatePrivateKey()), maxPerRequest: "0.001" });
    await expect(pay(`${api}/paid`)).rejects.toThrow();
  });
});
