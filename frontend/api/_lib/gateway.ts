// API gateway: turns any public HTTP API into a paid x402 endpoint that settles in xUSD on Portaldot.
//
// Nothing is stored. An endpoint's whole configuration (upstream URL, method, price, who gets paid) is
// encoded in its id, so the gateway URL *is* the registration and anyone can read what it forwards to with
// GET /api/gateway/inspect. Upstream credentials (an API key header) are sealed with AES-256-GCM under a
// server secret before they go into the id, so they never appear in the URL in the clear.
//
//   POST /api/gateway/register   { name, url, method, price, payTo, headers? } → { id, path, preview }
//   GET  /api/gateway/inspect?id=…                                              → the public config
//   GET|POST /api/gateway/<id>[?_path=/sub/path&any=query]                      → 402, then the upstream answer
//
// Calls are only settled when the upstream answers below 400, so nobody pays for a failed call.
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { xusdPaywall } from "@portastake/sdk/x402/server";
import { createFacilitator } from "@portastake/sdk/x402/facilitator";

export type GatewayConfig = {
  v: 1;
  /** Display name. */
  n: string;
  /** Upstream URL, http(s). */
  u: string;
  m: "GET" | "POST";
  /** Price per call in whole xUSD. */
  p: string;
  /** Who gets paid. */
  t: Address;
  /** Sealed upstream headers, if any. */
  s?: string;
};

export type PublicConfig = { name: string; url: string; method: "GET" | "POST"; price: string; payTo: Address; sealedHeaders: boolean };

const MIN_PRICE = 0.001;
const MAX_PRICE = 1;
const MAX_ID = 4_000;
const MAX_BODY = 2 * 1024 * 1024;
const PREVIEW_BYTES = 4_096;
const TIMEOUT_MS = 15_000;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Never forwarded from a sealed set: they'd let a caller reshape the upstream request.
const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie"]);

const b64url = {
  encode: (buf: Buffer) => buf.toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url"),
};

export function encodeId(c: GatewayConfig): string {
  return b64url.encode(Buffer.from(JSON.stringify(c)));
}

export function decodeId(id: string): GatewayConfig {
  if (!id || id.length > MAX_ID || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("not a gateway id");
  const c = JSON.parse(b64url.decode(id).toString("utf8")) as GatewayConfig;
  validate(c);
  return c;
}

function validate(c: GatewayConfig): void {
  if (c.v !== 1) throw new Error("unknown gateway id version");
  if (typeof c.n !== "string" || c.n.length < 1 || c.n.length > 60) throw new Error("name must be 1-60 characters");
  if (c.m !== "GET" && c.m !== "POST") throw new Error("method must be GET or POST");
  const price = Number(c.p);
  if (!/^\d+(\.\d{1,6})?$/.test(c.p) || price < MIN_PRICE || price > MAX_PRICE) {
    throw new Error(`price must be between ${MIN_PRICE} and ${MAX_PRICE} xUSD`);
  }
  if (!isAddress(c.t)) throw new Error("payTo must be a 0x address");
  let url: URL;
  try {
    url = new URL(c.u);
  } catch {
    throw new Error("url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("url must be http or https");
  if (url.username || url.password) throw new Error("put credentials in a sealed header, not the URL");
}

export function publicConfig(c: GatewayConfig): PublicConfig {
  return { name: c.n, url: c.u, method: c.m, price: c.p, payTo: getAddress(c.t), sealedHeaders: !!c.s };
}

// ---- sealing upstream headers ------------------------------------------------------------------

function sealKey(secret: string): Buffer {
  return createHash("sha256").update(`portastake-gateway:${secret}`).digest();
}

function seal(headers: Record<string, string>, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(headers), "utf8"), cipher.final()]);
  return b64url.encode(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

function unseal(sealed: string, secret: string): Record<string, string> {
  const raw = b64url.decode(sealed);
  const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

// ---- outbound safety ---------------------------------------------------------------------------

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Refuses anything that resolves to a private, loopback, link-local or metadata address. */
async function assertPublic(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("the upstream must be a public host");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0 || addrs.some((a) => privateIp(a.address))) throw new Error("the upstream must be a public host");
}

type Upstream = { status: number; contentType: string; body: Buffer; truncated: boolean };

async function callUpstream(
  target: URL,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: string | undefined,
  limit: number,
): Promise<Upstream> {
  let url = target;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      method,
      headers: { "user-agent": "PortaStake-Gateway/1", accept: "application/json, */*;q=0.5", ...headers },
      body: method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the upstream redirected off http");
      continue;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - limit))));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body: Buffer.concat(chunks), truncated };
  }
  throw new Error("the upstream redirected too many times");
}

/** The upstream URL for one call: the configured URL, an optional sub-path and the caller's query. */
function targetFor(c: GatewayConfig, req: Request): URL {
  const url = new URL(c.u);
  const sub = typeof req.query._path === "string" ? req.query._path : "";
  if (sub) {
    if (!sub.startsWith("/") || sub.includes("..") || sub.includes("//") || sub.length > 512) throw new Error("bad _path");
    url.pathname = url.pathname.replace(/\/$/, "") + sub;
  }
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "_path" || typeof v !== "string") continue;
    url.searchParams.set(k, v);
  }
  return url;
}

function preview(u: Upstream): { status: number; contentType: string; sample: unknown; truncated: boolean } {
  const text = u.body.toString("utf8");
  let sample: unknown = text;
  if (!u.truncated && u.contentType.includes("json")) {
    try {
      sample = JSON.parse(text);
    } catch {
      // keep the text
    }
  }
  return { status: u.status, contentType: u.contentType, sample, truncated: u.truncated };
}

const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).split("\n")[0];

export function createGatewayApp(env: Record<string, string | undefined> = process.env): Express {
  const key = env.FACILITATOR_KEY;
  const secret = env.GATEWAY_SECRET ?? key;
  const app = express();
  app.disable("x-powered-by");
  app.use("/api/gateway", express.json({ limit: "64kb" }));

  app.post("/api/gateway/register", async (req: Request, res: Response) => {
    try {
      const b = req.body ?? {};
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((b.headers ?? {}) as Record<string, unknown>)) {
        if (!k && !v) continue;
        if (!HEADER_NAME.test(k) || typeof v !== "string" || v.length > 2_048 || BLOCKED_HEADERS.has(k.toLowerCase())) {
          throw new Error(`header ${k || "(empty)"} is not allowed`);
        }
        headers[k] = v;
      }
      if (Object.keys(headers).length > 0 && !secret) throw new Error("sealed headers are not available on this deployment");
      const config: GatewayConfig = {
        v: 1,
        n: String(b.name ?? "").trim(),
        u: String(b.url ?? "").trim(),
        m: b.method === "POST" ? "POST" : "GET",
        p: String(b.price ?? "").trim(),
        t: String(b.payTo ?? "") as Address,
        ...(Object.keys(headers).length ? { s: seal(headers, secret!) } : {}),
      };
      validate(config);
      config.t = getAddress(config.t);
      const id = encodeId(config);
      if (id.length > MAX_ID) throw new Error("that configuration is too long");
      // A free, size-capped test call so the creator sees what payers will get.
      let test: ReturnType<typeof preview> | { error: string };
      try {
        test = preview(
          await callUpstream(new URL(config.u), config.m, headers, config.m === "POST" ? JSON.stringify(b.sampleBody ?? {}) : undefined, PREVIEW_BYTES),
        );
      } catch (e) {
        test = { error: errText(e) };
      }
      res.json({ id, path: `/api/gateway/${id}`, config: publicConfig(config), preview: test, live: !!key });
    } catch (e) {
      res.status(400).json({ error: errText(e) });
    }
  });

  app.get("/api/gateway/inspect", (req, res) => {
    try {
      res.json({ ...publicConfig(decodeId(String(req.query.id ?? ""))), live: !!key });
    } catch (e) {
      res.status(400).json({ error: errText(e) });
    }
  });

  if (!key) {
    app.use("/api/gateway", (_req, res) => {
      res.status(503).json({ error: "Paid gateway calls are not configured on this deployment (FACILITATOR_KEY missing)" });
    });
    return app;
  }

  const { client } = createFacilitator({ privateKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex, rpc: env.RPC });
  // One paywall per endpoint, built on first use. Bounded so a flood of ids can't grow memory forever.
  const paywalls = new Map<string, RequestHandler>();
  const paywallFor = (id: string, c: GatewayConfig): RequestHandler => {
    let pw = paywalls.get(id);
    if (!pw) {
      const route = { price: c.p, payTo: c.t, description: `${c.n} via PortaStake gateway` };
      pw = xusdPaywall({
        facilitator: client,
        routes: { [`GET /api/gateway/${id}`]: route, [`POST /api/gateway/${id}`]: route },
      });
      if (paywalls.size >= 500) paywalls.delete(paywalls.keys().next().value!);
      paywalls.set(id, pw);
    }
    return pw;
  };

  // Validate before charging, so nobody pays for a call that can only fail.
  app.all("/api/gateway/:id", (req, res, next) => {
    let c: GatewayConfig;
    try {
      c = decodeId(req.params.id);
      targetFor(c, req);
    } catch (e) {
      res.status(400).json({ error: errText(e) });
      return;
    }
    if (req.method !== c.m) {
      res.status(405).json({ error: `this endpoint takes ${c.m}` });
      return;
    }
    res.locals.gateway = c;
    paywallFor(req.params.id, c)(req, res, next);
  });

  app.all("/api/gateway/:id", async (req, res) => {
    const c = res.locals.gateway as GatewayConfig;
    try {
      const headers = c.s && secret ? unseal(c.s, secret) : {};
      if (c.m === "POST") headers["content-type"] = "application/json";
      const up = await callUpstream(targetFor(c, req), c.m, headers, c.m === "POST" ? JSON.stringify(req.body ?? {}) : undefined, MAX_BODY);
      if (up.truncated) {
        res.status(502).json({ error: "the upstream answer is over 2 MB" });
        return;
      }
      // A failed upstream is answered with an error status, so the payment is not settled.
      res.status(up.status >= 400 ? 502 : up.status).setHeader("Content-Type", up.contentType);
      res.setHeader("X-Gateway-Upstream-Status", String(up.status));
      res.send(up.body);
    } catch (e) {
      res.status(502).json({ error: `the upstream failed: ${errText(e)}` });
    }
  });

  return app;
}
