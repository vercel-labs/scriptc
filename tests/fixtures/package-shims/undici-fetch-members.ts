// Every RequestInit member undici's fetch is given, one value per cell,
// without a dispatcher and through an Agent: what the server receives
// compared with a plain call, or how the call ends. The expected output is
// undici's under Node 24 (5.29.0 and 7.30.0) wherever the two agree, and a
// refusal that names the member wherever the built-in undici does not act
// on a value (package-shims.test.ts counts both): no member is taken and
// then ignored.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Agent, fetch } from "undici";

interface Seen {
  method: string;
  headers: Record<string, string>;
  bytes: number;
}

const payload = "twelve bytes";
const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (chunk: Buffer) => parts.push(chunk));
  req.on("end", () => {
    const headers: Record<string, string> = {};
    for (const name of Object.keys(req.headers).sort()) {
      if (name === "host" || name === "connection") continue;
      headers[name] = String(req.headers[name]);
    }
    const seen: Seen = { method: req.method ?? "", headers, bytes: Buffer.concat(parts).length };
    res.setHeader("x-seen", JSON.stringify(seen));
    res.end(payload);
  });
});

let plain: Seen = { method: "", headers: {}, bytes: 0 };

function against(seen: Seen): string {
  const out: string[] = [];
  if (seen.method !== plain.method) out.push(`method=${seen.method}`);
  if (seen.bytes !== plain.bytes) out.push(`bytes=${seen.bytes}`);
  for (const name of Object.keys(seen.headers)) {
    if (plain.headers[name] === undefined) out.push(`+${name}=${seen.headers[name]}`);
    else if (plain.headers[name] !== seen.headers[name]) out.push(`~${name}=${seen.headers[name]}`);
  }
  for (const name of Object.keys(plain.headers)) {
    if (seen.headers[name] === undefined) out.push(`-${name}`);
  }
  return out.length === 0 ? "as a plain call" : out.join(" ");
}

function ending(err: unknown): string {
  const error = err as { name?: string; message?: string; code?: unknown; cause?: unknown };
  let text = `${String(error.name)}${error.code !== undefined ? ` ${String(error.code)}` : ""}: ${String(error.message)}`;
  const cause = error.cause as { name?: string; message?: string } | undefined;
  if (cause !== undefined && cause !== null) text += ` (cause ${String(cause.name)}: ${String(cause.message)})`;
  return text;
}

/** One line per cell: the port and line breaks spelled out. */
function say(line: string): void {
  console.log(
    line
      .replace(/127\.0\.0\.1:\d+/g, "HOST")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\u0000/g, "\\0"),
  );
}

async function cell(label: string, start: () => Promise<unknown>): Promise<void> {
  try {
    const res = (await start()) as Response;
    const seen = JSON.parse(res.headers.get("x-seen") ?? "{}") as Seen;
    const text = await res.text();
    say(`${label}: ${res.status} ${text === payload ? "body" : JSON.stringify(text)}, ${against(seen)}`);
  } catch (err) {
    say(`${label}: rejected ${ending(err)}`);
  }
}


type Init = NonNullable<Parameters<typeof fetch>[1]>;
let url = "";
let good = "";
let bad = "";
let good512 = "";

async function round(way: string, send: (init: Init) => Promise<unknown>): Promise<void> {
  const cellOf = (label: string, start: () => Promise<unknown>): Promise<void> => cell(`${way}, ${label}`, start);
  await cellOf("empty init", () => send({}));
  for (const cache of ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached", "sometimes"]) {
    await cellOf(`cache ${cache}`, () => send({ cache }));
  }
  for (const credentials of ["same-origin", "omit", "include", "sometimes"]) {
    await cellOf(`credentials ${credentials}`, () => send({ credentials }));
  }
  for (const duplex of ["half", "full"]) {
    await cellOf(`duplex ${duplex}`, () => send({ duplex }));
  }
  await cellOf("integrity empty", () => send({ integrity: "" }));
  await cellOf("integrity matching sha256", () => send({ integrity: good }));
  await cellOf("integrity matching sha512", () => send({ integrity: good512 }));
  await cellOf("integrity other body", () => send({ integrity: bad }));
  await cellOf("integrity other body, then matching", () => send({ integrity: `${bad} ${good}` }));
  await cellOf("integrity unknown algorithm", () => send({ integrity: "md5-AAAA" }));
  await cellOf("integrity not a digest", () => send({ integrity: "nonsense" }));
  await cellOf("keepalive false", () => send({ keepalive: false }));
  await cellOf("keepalive true", () => send({ keepalive: true }));
  for (const mode of ["cors", "no-cors", "same-origin", "navigate", "websocket", "sometimes"]) {
    await cellOf(`mode ${mode}`, () => send({ mode }));
  }
  await cellOf("mode no-cors with PUT", () => send({ mode: "no-cors", method: "PUT" }));
  await cellOf("mode no-cors with a header", () => send({ mode: "no-cors", headers: { "x-own": "1" } }));
  for (const priority of ["auto", "high", "low", "sometimes"]) {
    await cellOf(`priority ${priority}`, () => send({ priority }));
  }
  for (const referrer of ["", "about:client", "https://elsewhere.example/page", url + "/from", "not a url"]) {
    await cellOf(`referrer ${JSON.stringify(referrer)}`, () => send({ referrer }));
  }
  for (const referrerPolicy of ["", "no-referrer", "origin", "unsafe-url", "strict-origin-when-cross-origin", "sometimes"]) {
    await cellOf(`referrerPolicy ${JSON.stringify(referrerPolicy)}`, () => send({ referrerPolicy }));
  }
  await cellOf("referrer with unsafe-url", () => send({ referrer: url + "/from", referrerPolicy: "unsafe-url" }));
  await cellOf("window null", () => send({ window: null }));
  await cellOf("window a value", () => send({ window: 1 }));

  for (const redirect of ["follow", "manual", "error", "sometimes"]) {
    await cellOf(`redirect ${redirect}`, () => send({ redirect }));
  }
  for (const method of ["get", "post", "Put", "patch", "PATCH", "PROPFIND", "CONNECT", "TRACE", "TRACK", "bad method"]) {
    await cellOf(`method ${method}`, () => send({ method }));
  }
  await cellOf("body with GET", () => send({ body: "x" }));
  await cellOf("body with HEAD", () => send({ method: "HEAD", body: "x" }));
  await cellOf("body string", () => send({ method: "POST", body: "abc" }));
  await cellOf("body null", () => send({ method: "POST", body: null }));
  await cellOf("body bytes", () => send({ method: "POST", body: new Uint8Array([1, 2, 3, 4]) }));
  await cellOf("body ArrayBuffer", () => send({ method: "POST", body: new Uint8Array([1, 2]).buffer }));
  await cellOf("body DataView", () => send({ method: "POST", body: new DataView(new Uint8Array([1, 2, 3]).buffer, 1) }));
  await cellOf("body URLSearchParams", () => send({ method: "POST", body: new URLSearchParams({ a: "1" }) }));
  await cellOf("body number", () => send({ method: "POST", body: 42 }));
  await cellOf("body object", () => send({ method: "POST", body: { a: 1 } }));

  await cellOf("headers record", () => send({ headers: { "x-own": "1" } }));
  await cellOf("headers pairs", () => send({ headers: [["x-own", "1"], ["x-own", "2"]] }));
  await cellOf("headers Headers", () => send({ headers: new Headers({ "x-own": "1" }) }));
  await cellOf("headers null", () => send({ headers: null }));
  await cellOf("headers record, array value", () => send({ headers: { "x-own": ["1", "2"] } }));
  await cellOf("headers record, number value", () => send({ headers: { "x-own": 7 } }));
  await cellOf("headers pair of three", () => send({ headers: [["x-own", "1", "2"]] }));
  await cellOf("headers a number", () => send({ headers: 7 }));
  await cellOf("headers a string", () => send({ headers: "x-own: 1" }));
  await cellOf("headers value with a line break", () => send({ headers: { "x-own": "1\r\nx-added: 2" } }));
  await cellOf("headers pair value with a line break", () => send({ headers: [["x-own", "1\r\nx-added: 2"]] }));
  await cellOf("headers value with a line feed", () => send({ headers: { "x-own": "1\nx-added: 2" } }));
  await cellOf("headers value with a NUL", () => send({ headers: { "x-own": "1\u00002" } }));
  await cellOf("headers name with a space", () => send({ headers: { "x own": "1" } }));
  await cellOf("headers name with a colon", () => send({ headers: [["x-own: 1\r\nx-added", "2"]] }));
  await cellOf("headers empty name", () => send({ headers: [["", "2"]] }));
  await cellOf("headers value with outer spaces", () => send({ headers: { "x-own": "  1  " } }));
  await cellOf("headers value beyond latin1", () => send({ headers: { "x-own": "€" } }));
  await cellOf("headers forbidden name", () => send({ headers: { "content-length": "99", "transfer-encoding": "chunked" } }));

  const stopped = new AbortController();
  stopped.abort();
  await cellOf("signal aborted", () => send({ signal: stopped.signal }));
  await cellOf("signal null", () => send({ signal: null }));
  await cellOf("signal live", () => send({ signal: new AbortController().signal }));

}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/item`;
  const first = (await fetch(url)) as Response;
  plain = JSON.parse(first.headers.get("x-seen") ?? "{}") as Seen;
  await first.text();
  console.log(`plain: ${first.status} ${plain.method} ${Object.keys(plain.headers).join(",")}`);

  good = "sha256-" + createHash("sha256").update(payload).digest("base64");
  bad = "sha256-" + createHash("sha256").update("another body").digest("base64");
  good512 = "sha512-" + createHash("sha512").update(payload).digest("base64");

  const lines = new Agent();
  await round("direct", (init) => fetch(url, init));
  await round("agent", (init) => fetch(url, { ...init, dispatcher: lines }));
  await cell("dispatcher Agent", () => fetch(url, { dispatcher: lines }));
  await cell("dispatcher null", () => fetch(url, { dispatcher: null }));
  await cell("dispatcher an object", () => fetch(url, { dispatcher: {} }));
  await cell("dispatcher a number", () => fetch(url, { dispatcher: 5 }));
  await lines.close();
  await cell("unknown member", () => fetch(url, { colour: "blue" } as Init));
  server.close();
});
