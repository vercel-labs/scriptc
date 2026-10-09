/* Closed-loop HTTP/1.1 load client for the server workloads.
 *
 * Usage: node http-load.mjs --port=<n> [--connections=64] [--threads=2]
 *        [--warmup=4000] [--requests=40000]
 *
 * The same client drives every server (Node and compiled), so differences in
 * the numbers come from the server. Each connection is a keep-alive socket
 * that issues its own deterministic request sequence one request at a time
 * (no pipelining); requests are split evenly across connections, and the
 * connections are spread across worker threads so the client has CPU
 * headroom. Mutable server state (carts) is partitioned per connection, so
 * every response is a pure function of (connection, request index).
 *
 * Phases: connect + warmup requests (untimed) -> barrier -> measured requests.
 * The measured wall time spans from releasing the barrier until the last
 * connection finishes; per-request latency is sampled in the measured phase.
 *
 * stdout (compared byte-for-byte between servers): request and status counts
 * plus a digest over every response's status, selected headers, and body.
 * stderr: one `BENCH {json}` line with timing; nothing else on success.
 * Finally sends POST /shutdown so the server prints its totals and exits. */
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const HASHED_HEADERS = ["content-type", "cache-control", "etag", "x-request-id"];

/* ── deterministic schedule ───────────────────────────────────────────── */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const categories = ["books", "games", "garden", "kitchen", "music", "outdoor", "tools", "toys"];

/** The request list of one connection: [method, path, headers, body]. */
function schedule(conn, total) {
  const random = lcg(0x9e3779b9 ^ Math.imul(conn + 1, 2654435761));
  const list = [];
  const cart = (k) => `c${conn}-${k % 4}`;
  const token = `Bearer tok-${conn.toString(36).padStart(6, "0")}`;
  const added = [];
  for (let k = 0; k < total; k++) {
    const headers = { "x-request-id": `${conn}-${k}` };
    const r = random();
    let method = "GET";
    let path;
    let body = "";
    if (r < 0.1) path = "/health";
    else if (r < 0.4) {
      const id = random() < 0.03 ? 2000 + Math.floor(random() * 100) : Math.floor(random() * 2000);
      path = `/products/${id}`;
      if (id < 2000 && random() < 0.3) headers["if-none-match"] = `"p${id}-v1"`;
    } else if (r < 0.6) {
      const category = random() < 0.15 ? "" : categories[Math.floor(random() * categories.length)];
      const params = [];
      if (category) params.push(`category=${category}`);
      params.push(`limit=${5 + Math.floor(random() * 20)}`);
      if (random() < 0.5) params.push(`offset=${Math.floor(random() * 200)}`);
      if (random() < 0.4) params.push(`minPrice=${Math.floor(random() * 60)}`);
      path = `/products?${params.join("&")}`;
    } else if (r < 0.8) {
      method = "POST";
      const k2 = Math.floor(random() * 8);
      path = `/carts/${cart(k2)}/items`;
      const productId = Math.floor(random() * 2000);
      const auth = random();
      if (auth >= 0.04) headers.authorization = token;
      headers["content-type"] = "application/json";
      body =
        auth > 0.98
          ? `{"productId":${productId},`
          : JSON.stringify({ productId, qty: 1 + Math.floor(random() * 3) });
      if (auth >= 0.04 && auth <= 0.98) added.push([k2, productId]);
    } else if (r < 0.9) path = `/carts/${cart(Math.floor(random() * 8))}`;
    else if (r < 0.97) {
      method = "DELETE";
      const pick =
        added.length > 0 && random() < 0.8 ? added[Math.floor(random() * added.length)] : null;
      const productId = pick ? pick[1] : Math.floor(random() * 2000);
      path = `/carts/${cart(pick ? pick[0] : Math.floor(random() * 8))}/items/sku-${100000 + productId}`;
      headers.authorization = token;
    } else path = random() < 0.5 ? "/admin/metrics" : "/products/7/reviews";
    list.push(encode(method, path, headers, body));
  }
  return list;
}

function encode(method, path, headers, body) {
  let head = `${method} ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nuser-agent: scriptc-bench/1\r\naccept: application/json\r\n`;
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
  if (method === "POST" || body.length > 0)
    head += `content-length: ${Buffer.byteLength(body)}\r\n`;
  return Buffer.from(head + "\r\n" + body);
}

/* ── response parsing ─────────────────────────────────────────────────── */
/** Parses one complete response from `buf`, or returns null if incomplete. */
function parseResponse(buf, method) {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const head = buf.toString("latin1", 0, end).split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  const headers = new Map();
  for (let i = 1; i < head.length; i++) {
    const colon = head[i].indexOf(":");
    headers.set(head[i].slice(0, colon).trim().toLowerCase(), head[i].slice(colon + 1).trim());
  }
  let offset = end + 4;
  let body;
  if (status === 204 || status === 304 || method === "HEAD" || (status >= 100 && status < 200))
    body = Buffer.alloc(0);
  else if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    const parts = [];
    for (;;) {
      const lineEnd = buf.indexOf("\r\n", offset);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.toString("latin1", offset, lineEnd), 16);
      if (size === 0) {
        // No trailers are expected: the terminator is "0\r\n\r\n".
        if (buf.length < lineEnd + 4) return null;
        offset = lineEnd + 4;
        break;
      }
      if (buf.length < lineEnd + 2 + size + 2) return null;
      parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
      offset = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  } else if (headers.has("content-length")) {
    const length = Number(headers.get("content-length"));
    if (buf.length < offset + length) return null;
    body = buf.subarray(offset, offset + length);
    offset += length;
  } else throw new Error(`response without framing: ${head[0]}`);
  return { status, headers, body, consumed: offset };
}

/* ── one keep-alive connection ────────────────────────────────────────── */
function runConnection(port, conn, requests, measuredFrom) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const statuses = new Map();
    const latencies = [];
    const methods = requests.map((r) => r.toString("latin1", 0, 8).split(" ")[0]);
    let next = 0;
    let sentAt = 0n;
    let buf = Buffer.alloc(0);
    let waitForGo = null;
    const socket = connect({ port, host: "127.0.0.1", noDelay: true });
    const send = () => {
      sentAt = process.hrtime.bigint();
      socket.write(requests[next]);
    };
    socket.on("error", reject);
    socket.on("connect", send);
    socket.on("data", (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const response = parseResponse(buf, methods[next]);
      if (response === null) return;
      if (response.consumed !== buf.length) {
        reject(new Error(`connection ${conn}: unexpected bytes after response ${next}`));
        return;
      }
      buf = Buffer.alloc(0);
      if (next >= measuredFrom) latencies.push(Number(process.hrtime.bigint() - sentAt) / 1e6);
      hash.update(`${response.status}\n`);
      for (const name of HASHED_HEADERS)
        hash.update(`${name}:${response.headers.get(name) ?? ""}\n`);
      hash.update(response.body);
      hash.update("\n");
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      next++;
      if (next === requests.length) {
        socket.end();
        resolve({ conn, digest: hash.digest("hex"), statuses, latencies });
      } else if (next === measuredFrom) {
        waitForGo = send;
        warmed();
      } else send();
    });
    socket.on("close", () => {
      if (next !== requests.length) reject(new Error(`connection ${conn} closed after ${next}`));
    });
    const warmed = () => pending.warm(conn, () => waitForGo());
  });
}

/* Barrier bookkeeping shared by all connections of one thread. */
const pending = {
  waiting: [],
  expected: 0,
  onAllWarm: null,
  warm(conn, go) {
    this.waiting.push(go);
    if (this.waiting.length === this.expected) this.onAllWarm();
  },
  release() {
    for (const go of this.waiting.splice(0)) go();
  },
};

async function runThread({ port, conns, warmupPer, measuredPer }) {
  pending.expected = conns.length;
  const warm = new Promise((resolve) => (pending.onAllWarm = resolve));
  const results = Promise.all(
    conns.map((conn) =>
      runConnection(port, conn, schedule(conn, warmupPer + measuredPer), warmupPer),
    ),
  );
  results.catch(() => {});
  return { warm, results };
}

/* ── worker ───────────────────────────────────────────────────────────── */
if (!isMainThread) {
  const { warm, results } = await runThread(workerData);
  await warm;
  parentPort.postMessage({ type: "warm" });
  parentPort.once("message", async () => {
    pending.release();
    try {
      parentPort.postMessage({ type: "done", results: await results });
    } catch (error) {
      parentPort.postMessage({ type: "error", message: String(error?.stack ?? error) });
    }
  });
} else {
  await main();
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      connections: { type: "string", default: "64" },
      threads: { type: "string", default: "2" },
      warmup: { type: "string", default: "4000" },
      requests: { type: "string", default: "40000" },
    },
  });
  const port = Number(values.port);
  const connections = Number(values.connections);
  const threads = Math.min(Number(values.threads), connections);
  // Every connection warms up with at least one request (which also opens it).
  const warmupPer = Math.max(1, Math.ceil(Number(values.warmup) / connections));
  const measuredPer = Math.ceil(Number(values.requests) / connections);
  if (!(port > 0) || !(connections > 0) || !(threads > 0) || !(measuredPer > 0))
    throw new Error("invalid arguments");
  const watchdog = setTimeout(() => {
    process.stderr.write("load client timed out\n");
    process.exit(2);
  }, 120_000);

  const workers = Array.from({ length: threads }, (_, t) => {
    const conns = [];
    for (let c = t; c < connections; c += threads) conns.push(c);
    return new Worker(new URL(import.meta.url), {
      workerData: { port, conns, warmupPer, measuredPer },
    });
  });
  const messages = workers.map((worker) => {
    const queue = [];
    let wake = null;
    worker.on("message", (m) => (wake ? (wake(m), (wake = null)) : queue.push(m)));
    worker.on("error", (error) => {
      process.stderr.write(`load client worker failed: ${error.stack ?? error}\n`);
      process.exit(2);
    });
    return () =>
      queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => (wake = r));
  });
  for (const next of messages) await next();
  // cpuUsage covers every thread of the client process.
  const cpuStart = process.cpuUsage();
  const start = process.hrtime.bigint();
  for (const worker of workers) worker.postMessage("go");
  const finished = await Promise.all(messages.map((next) => next()));
  const measuredMs = Number(process.hrtime.bigint() - start) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  for (const m of finished)
    if (m.type !== "done") {
      process.stderr.write(`load client error: ${m.message}\n`);
      process.exit(2);
    }
  await Promise.all(workers.map((w) => w.terminate()));

  const perConn = finished.flatMap((m) => m.results).sort((a, b) => a.conn - b.conn);
  const digest = createHash("sha256");
  const statuses = new Map();
  const latencies = [];
  for (const r of perConn) {
    digest.update(r.digest);
    for (const [status, n] of r.statuses) statuses.set(status, (statuses.get(status) ?? 0) + n);
    for (const l of r.latencies) latencies.push(l);
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const measured = latencies.length;

  await shutdown(port);
  clearTimeout(watchdog);
  const total = perConn.length * (warmupPer + measuredPer);
  const lines = [`connections ${connections} requests ${total} measured ${measured}`];
  for (const status of [...statuses.keys()].sort((a, b) => a - b))
    lines.push(`status ${status} ${statuses.get(status)}`);
  lines.push(`digest ${digest.digest("hex").slice(0, 32)}`);
  console.log(lines.join("\n"));
  const round = (x) => Math.round(x * 1000) / 1000;
  process.stderr.write(
    "BENCH " +
      JSON.stringify({
        measured_ms: round(measuredMs),
        requests: measured,
        rps: Math.round((measured / measuredMs) * 1000),
        p50_ms: round(pct(0.5)),
        p90_ms: round(pct(0.9)),
        p99_ms: round(pct(0.99)),
        max_ms: round(latencies[latencies.length - 1]),
        client_cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
        threads,
      }) +
      "\n",
  );
}

function shutdown(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let buf = Buffer.alloc(0);
    socket.on("connect", () =>
      socket.write(encode("POST", "/shutdown", { connection: "close" }, "")),
    );
    socket.on("data", (chunk) => (buf = Buffer.concat([buf, chunk])));
    socket.on("error", reject);
    socket.on("close", () => {
      const response = parseResponse(buf, "POST");
      if (response?.status === 200) resolve();
      else reject(new Error(`shutdown failed: ${buf.toString("latin1", 0, 200)}`));
    });
  });
}
