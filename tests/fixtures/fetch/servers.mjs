/* The fetch fixtures' local HTTP servers — the routes fetch.test.ts always
 * ran in-process, extracted so the Linux lane can run the IDENTICAL routes
 * inside its container (linux-differential.test.ts). Two entry forms, one
 * behavior:
 *
 * - module: `startFetchServers()` binds the target, refused-port probe, and
 *   HTTP/HTTPS proxy legs locally and resolves their URLs plus counters
 *   (fetch.test.ts's in-process use).
 * - standalone: `node servers.mjs` starts the same legs and prints
 *   `BASE <url>` / `REFUSED <url>` / `PROXY <url>` /
 *   `SECURE_PROXY <url>` on stderr (the PORT protocol's channel — never a
 *   compared stream), then serves until killed. The proxied-request COUNT
 *   is queryable over the wire in this form: a plain `GET /__count` to the
 *   HTTP proxy (a relative-path request no real proxy client sends) answers
 *   the current count.
 *
 * Routes: /text /json /post-echo /header-echo /header-empty /headers-source
 * /headers-reuse /request-defaults /raw-headers /header-init-echo
 * /redirect /redirect-stream-302 /redirect-stream-303 /redirect-credentials
 * /redirect-fragment/path /redirect-backslash /redirect-invalid-utf8
 * /redirect-same-scheme/dir/start
 * /early-hints
 * /switching-protocols /invalid-utf8 /slow /drip
 * /chunked /backpressure /backpressure-state /gzip /gzip-concat
 * /gzip-truncated /gzip-pressure /deflate
 * /status-meta /no-content /reset-content /reset-content-large
 * /truncated-response /upload-failure /sse,
 * 404 for the rest;
 * the proxy relays absolute-URI requests and CONNECT tunnels, counting one
 * per proxied request either way. */
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

export async function startFetchServers() {
  const fragmentRedirects = new Set();
  const backpressureStates = new Map();
  let gzipPressurePayload;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/upload-failure") {
      // The client-side body source fails after the request begins. Keep
      // the peer quiet so fetch must settle from that upload error, and
      // absorb the expected reset when fetch tears the socket down.
      req.on("error", () => {});
      req.resume();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (url.startsWith("/backpressure-state?")) {
        const parsed = new URL(url, "http://fixture.invalid");
        const key = parsed.searchParams.get("key") ?? "missing";
        const state = backpressureStates.get(key);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(state?.done ? "unbounded" : state ? "bounded" : "missing");
        backpressureStates.delete(key);
      } else if (url.startsWith("/backpressure?")) {
        const parsed = new URL(url, "http://fixture.invalid");
        const key = parsed.searchParams.get("key") ?? "missing";
        const state = { closed: false, done: false, sent: 0 };
        backpressureStates.set(key, state);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.on("close", () => {
          state.closed = true;
        });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const total = 32 * 1024 * 1024;
        const pump = () => {
          while (!state.closed && state.sent < total) {
            const size = Math.min(chunk.length, total - state.sent);
            state.sent += size;
            if (!res.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
              res.once("drain", pump);
              return;
            }
          }
          if (!state.closed && state.sent === total) {
            state.done = true;
            res.end();
          }
        };
        pump();
      } else if (url === "/text") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-kind": "greeting" });
        res.end("héllo wörld 😀");
      } else if (url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ n: 42, s: "wide é", arr: [1, "two"] }));
      } else if (url === "/post-echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers["content-type"] ?? null,
            contentLength: req.headers["content-length"] ?? null,
            body: body.toString("utf8"),
          }),
        );
      } else if (url === "/header-echo") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-multi": ["a", "b"],
          "x-latin": "é",
          "set-cookie": ["first=1", "second=2", "flavor=é"],
        });
        res.end(`one=${req.headers["x-echo-one"]} two=${req.headers["x-echo-two"]}`);
      } else if (url === "/header-empty") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-empty": ["", "b"],
        });
        res.end("empty header");
      } else if (url === "/headers-source") {
        // `connection: close` keeps Node from minting its keep-alive
        // response header, which undici correctly refuses as a request
        // header when the response Headers object is reused below.
        res.writeHead(200, {
          connection: "close",
          "content-length": "0",
          "x-reuse": ["one", "two"],
        });
        res.end();
      } else if (url === "/headers-reuse") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(req.headers["x-reuse"] ?? "missing"));
      } else if (url === "/request-defaults") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            host: req.headers.host ?? null,
            accept: req.headers["accept"] ?? null,
            acceptLanguage: req.headers["accept-language"] ?? null,
            secFetchMode: req.headers["sec-fetch-mode"] ?? null,
            userAgent: req.headers["user-agent"] ?? null,
            acceptEncoding: req.headers["accept-encoding"] ?? null,
          }),
        );
      } else if (url === "/raw-headers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.rawHeaders));
      } else if (url === "/header-init-echo") {
        const count = (name) => {
          let matches = 0;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === name) matches++;
          }
          return matches;
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            duplicate: req.headers["x-duplicate"] ?? null,
            duplicateLines: count("x-duplicate"),
            cookie: req.headers.cookie ?? null,
            cookieLines: count("cookie"),
          }),
        );
      } else if (url === "/redirect") {
        res.writeHead(302, { location: "/text" });
        res.end();
      } else if (url === "/redirect-stream-302") {
        res.writeHead(302, { location: "/post-echo" });
        res.end();
      } else if (url === "/redirect-stream-303") {
        res.writeHead(303, { location: "/post-echo" });
        res.end();
      } else if (url === "/redirect-credentials") {
        res.writeHead(302, {
          location: `http://user:pass@${req.headers.host}/text`,
        });
        res.end();
      } else if (url === "/redirect-backslash") {
        // WHATWG special URLs treat backslashes as path separators. Two
        // leading separators make this an authority-relative reference.
        res.writeHead(302, {
          location: `\\\\${req.headers.host}\\text`,
        });
        res.end();
      } else if (url === "/redirect-same-scheme/dir/start") {
        // In a special URL, a matching scheme without `//` is relative to
        // the current URL rather than an absolute URL whose host is "next".
        res.writeHead(302, { location: "http:next" });
        res.end();
      } else if (url === "/redirect-same-scheme/dir/next") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("same-scheme final");
      } else if (url === "/redirect-invalid-utf8") {
        // node:http serializes this ByteString as a raw E9 octet. Fetch
        // UTF-8-decodes that invalid one-byte sequence to U+FFFD before
        // resolving the redirect URL.
        res.writeHead(302, { location: "/café" });
        res.end();
      } else if (url.startsWith("/caf")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(url);
      } else if (url === "/redirect-fragment/path") {
        const key = String(req.headers["x-redirect-key"] ?? "missing");
        if (!fragmentRedirects.has(key)) {
          fragmentRedirects.add(key);
          res.writeHead(302, { location: "#next" });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("fragment final");
        }
      } else if (url === "/early-hints") {
        res.writeEarlyHints({
          link: "</style.css>; rel=preload; as=style",
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("final");
      } else if (url === "/switching-protocols") {
        res.writeHead(101, {
          connection: "upgrade",
          upgrade: "fixture",
        });
        res.end();
      } else if (url === "/invalid-utf8") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(Buffer.from([0x61, 0xc3, 0x28, 0x62]));
      } else if (url === "/slow") {
        // Answers after 1500ms: the abort/timeout cases cancel long before.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow done");
        }, 1500);
      } else if (url === "/drip") {
        // First chunk immediately, the rest after 3000ms: the mid-stream
        // abort case reads the first chunk and cancels during the gap.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first");
        setTimeout(() => {
          res.end("tail");
        }, 3000);
      } else if (url === "/chunked") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        // split a multibyte sequence ACROSS chunks: € is e2 82 ac
        const bytes = Buffer.from("first€second", "utf8");
        res.write(bytes.subarray(0, 6)); // "first" + e2
        setTimeout(() => {
          res.write(bytes.subarray(6, 8)); // 82 ac
          setTimeout(() => {
            res.end(bytes.subarray(8));
          }, 15);
        }, 15);
      } else if (url === "/gzip") {
        // gzip-encoded body, written in two chunks so decompression spans
        // arrivals: fetch must deliver the DECODED text on both lanes.
        const payload = gzipSync(Buffer.from("compressed héllo 😀 ".repeat(40), "utf8"));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(payload.length) });
        res.write(payload.subarray(0, Math.floor(payload.length / 2)));
        setTimeout(() => {
          res.end(payload.subarray(Math.floor(payload.length / 2)));
        }, 15);
      } else if (url === "/gzip-concat") {
        // RFC 1952 permits multiple gzip members in one representation.
        const firstMembers = Buffer.concat([
          gzipSync(Buffer.from("member one ", "utf8")),
          gzipSync(Buffer.from("member two", "utf8")),
        ]);
        const finalMember = gzipSync(Buffer.from(" member three", "utf8"));
        const contentLength = firstMembers.length + finalMember.length;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(contentLength) });
        res.write(firstMembers);
        setTimeout(() => {
          res.end(finalMember);
        }, 15);
      } else if (url === "/gzip-truncated") {
        // Node fetch accepts a clean HTTP EOF with incomplete gzip framing
        // and exposes the decoded prefix; pin that distinct fetch contract.
        const complete = gzipSync(Buffer.from("truncated compressed body", "utf8"));
        const payload = complete.subarray(0, Math.floor(complete.length / 2));
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-encoding": "gzip",
          "content-length": String(payload.length),
        });
        res.end(payload);
      } else if (url === "/gzip-pressure") {
        // The representation fits in one 64 KiB socket read but expands to
        // 64 MiB. An unread body must retain only one decoded stream chunk.
        gzipPressurePayload ??= gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61));
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-length": String(gzipPressurePayload.length),
        });
        res.end(gzipPressurePayload);
      } else if (url === "/deflate") {
        // zlib-wrapped deflate (Node servers' `deflate` spelling).
        const payload = deflateSync(Buffer.from("deflated wörld", "utf8"));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "deflate" });
        res.end(payload);
      } else if (url === "/status-meta") {
        res.writeHead(206, "Custom Partial", { "content-type": "text/plain" });
        res.end("partial");
      } else if (url === "/no-content") {
        res.writeHead(204);
        res.end();
      } else if (url === "/reset-content") {
        res.writeHead(205, { "content-length": "4" });
        res.end("body");
      } else if (url === "/reset-content-large") {
        // Fetch exposes a null body for 205 even when a peer violates the
        // protocol and sends content. Make the payload larger than the
        // native socket's read window so an inaccessible backpressured
        // stream would stall the process instead of merely wasting bytes.
        const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
        res.writeHead(205, { "content-length": String(payload.length) });
        res.end(payload);
      } else if (url === "/truncated-response") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-length": "100",
        });
        res.write("partial");
        setTimeout(() => res.destroy(), 10);
      } else if (url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          'data: {"type":"delta","text":"hé"}\n\n',
          'event: usage\nid: 7\ndata: {"tokens":3}\n\n',
          "data: multi\ndata: line 😀\n\n",
          "data: [DONE]\n\n",
        ];
        let i = 0;
        const tick = () => {
          if (i === frames.length) {
            res.end();
            return;
          }
          // split each frame mid-way so parsing must span chunk boundaries
          const buf = Buffer.from(frames[i], "utf8");
          const cut = Math.floor(buf.length / 2);
          res.write(buf.subarray(0, cut));
          setTimeout(() => {
            res.write(buf.subarray(cut));
            i++;
            setTimeout(tick, 10);
          }, 10);
        };
        tick();
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`not found: ${url}`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("no server address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // A port that was just bound and released: connecting to it refuses.
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const paddr = probe.address();
  if (paddr === null || typeof paddr !== "object") throw new Error("no probe address");
  const refusedUrl = `http://127.0.0.1:${paddr.port}`;
  await new Promise((resolve) => probe.close(() => resolve()));

  // The forward proxy, both wire forms: absolute-URI requests (curl's
  // http_proxy shape for http:// targets) relay through http.request, and
  // CONNECT tunnels (undici's ProxyAgent shape — it tunnels even plain
  // http) splice raw sockets. One count per proxied request either way.
  let proxiedRequests = 0;
  const proxyAuthorizations = [];
  const proxyRequest = (req, res) => {
    // Relative-path requests are never proxy traffic — the standalone
    // form's count query rides one; anything else relative is a 404.
    if ((req.url ?? "").startsWith("/")) {
      if (req.url === "/__count") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(proxiedRequests));
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    proxiedRequests++;
    proxyAuthorizations.push(req.headers["proxy-authorization"] ?? "");
    const target = new URL(req.url ?? "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && k !== "proxy-connection" && k !== "connection") headers[k] = v;
      }
      const upstream = request(
        { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
        (ures) => {
          res.writeHead(ures.statusCode ?? 502, ures.headers);
          ures.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end("proxy error");
      });
      upstream.end(Buffer.concat(chunks));
    });
  };
  const proxyConnect = (req, clientSocket, head) => {
    proxiedRequests++;
    proxyAuthorizations.push(req.headers["proxy-authorization"] ?? "");
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = connect(Number(portStr ?? "80"), host ?? "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  };

  const proxy = createServer(proxyRequest);
  proxy.on("connect", proxyConnect);
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const pxaddr = proxy.address();
  if (pxaddr === null || typeof pxaddr !== "object") throw new Error("no proxy address");
  const proxyUrl = `http://127.0.0.1:${pxaddr.port}`;

  const secureProxy = createHttpsServer(
    {
      key: readFileSync(new URL("../server/certs/localhost-key.pem", import.meta.url)),
      cert: readFileSync(new URL("../server/certs/localhost.pem", import.meta.url)),
    },
    proxyRequest,
  );
  secureProxy.on("connect", proxyConnect);
  await new Promise((resolve) => secureProxy.listen(0, "127.0.0.1", resolve));
  const securePxaddr = secureProxy.address();
  if (securePxaddr === null || typeof securePxaddr !== "object") {
    throw new Error("no secure proxy address");
  }
  const secureProxyUrl = `https://localhost:${securePxaddr.port}`;

  return {
    baseUrl,
    refusedUrl,
    proxyUrl,
    secureProxyUrl,
    proxiedRequests: () => proxiedRequests,
    proxyAuthorizations: () => proxyAuthorizations.slice(),
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => proxy.close(() => resolve()));
      await new Promise((resolve) => secureProxy.close(() => resolve()));
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startFetchServers();
  process.stderr.write(`BASE ${s.baseUrl}\nREFUSED ${s.refusedUrl}\nPROXY ${s.proxyUrl}\n`);
  process.stderr.write(`SECURE_PROXY ${s.secureProxyUrl}\n`);
  // Serve until killed (the lane owns the process's lifetime).
}
