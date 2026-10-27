// Requests against a raw TCP peer that sends malformed or endless
// responses: header values with CR or LF never reach the wire, a
// chunk-size line is read as llhttp reads it (so an endless one holds no
// memory), and fetch() resolves at the headers with a body that streams,
// cancels and fails as undici's does.
import * as net from "node:net";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { Agent, errors, fetch, request } from "undici";

function describe(err: unknown): string {
  // HTTPParserError extends Error, not UndiciError.
  if (err instanceof errors.HTTPParserError) return `${err.name} ${err.code ?? ""} ${err.message}`;
  if (err instanceof errors.UndiciError) return `${err.name} ${err.code} ${err.message}`;
  if (err instanceof DOMException) return `${err.name} ${err.message}`;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    const cause = err.cause !== undefined ? ` cause: ${describe(err.cause)}` : "";
    return `${err.name} ${code} ${err.message}${cause}`;
  }
  return String(err);
}

const MiB = 1024 * 1024;
const text = "hello ".repeat(2000);
const packed = gzipSync(text);

// Chunked bodies whose chunk-size lines the client reads. Each is a
// complete response, or fails at the size line.
const chunkCases: [string, string][] = [
  ["plain", "5\r\nhello\r\n0\r\n\r\n"],
  ["extensions", '5;a=b;c="d e";f\r\nhello\r\n0\r\n\r\n'],
  ["quoted pair", '5;a="b\\"c"\r\nhello\r\n0\r\n\r\n'],
  ["value then extension", "5;a=b;c=d\r\nhello\r\n0\r\n\r\n"],
  ["space in name", "5;a b\r\nhello\r\n0\r\n\r\n"],
  ["empty extension", "5;\r\nhello\r\n0\r\n\r\n"],
  ["bad value", "5;a=b c\r\nhello\r\n0\r\n\r\n"],
  ["bad quoted value", '5;a="b\x01"\r\nhello\r\n0\r\n\r\n'],
  ["after quoted value", '5;a="b"c\r\nhello\r\n0\r\n\r\n'],
  ["LF after name", "5;a\nhello\r\n0\r\n\r\n"],
  ["LF after value", "5;a=b\nhello\r\n0\r\n\r\n"],
  ["space after size", "5 \r\nhello\r\n0\r\n\r\n"],
  ["space before size", " 5\r\nhello\r\n0\r\n\r\n"],
  ["empty size", "\r\nhello\r\n0\r\n\r\n"],
  ["not hex", "g\r\nhello\r\n0\r\n\r\n"],
  ["LF only", "5\nhello\r\n0\r\n\r\n"],
  ["CR then other byte", "5\rXhello\r\n0\r\n\r\n"],
  ["16 hex digits", `${"0".repeat(11)}00005\r\nhello\r\n0\r\n\r\n`],
  ["17 significant digits", "10000000000000000\r\nhello\r\n0\r\n\r\n"],
  ["1 MiB of leading zeros", `${"0".repeat(MiB)}5\r\nhello\r\n0\r\n\r\n`],
  ["1 MiB extension", `5;a=${"b".repeat(MiB)}\r\nhello\r\n0\r\n\r\n`],
  ["1 MiB of digits", `1${"0".repeat(MiB)}\r\nhello\r\n0\r\n\r\n`],
  ["1 MiB of spaces", `5${" ".repeat(MiB)}\r\nhello\r\n0\r\n\r\n`],
];

let chunkBody = "";
let closes = 0;

const peer = net.createServer((s: Socket) => {
  s.on("error", () => {});
  s.on("close", () => {
    closes++;
  });
  let head = "";
  s.on("data", (d: Buffer) => {
    head += d.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    const lines = head.split("\r\n");
    const path = lines[0]!.split(" ")[1]!;
    head = "";
    const send = (status: string, fields: string, body: string): void => {
      s.write(`HTTP/1.1 ${status}\r\n${fields}\r\n`);
      s.write(body);
    };
    if (path === "/echo") {
      const received = lines.slice(1).filter((l) => l !== "");
      send("200 OK", `Content-Length: ${JSON.stringify(received).length}\r\n`, JSON.stringify(received));
    } else if (path === "/chunked") {
      send("200 OK", "Transfer-Encoding: chunked\r\n", chunkBody);
    } else if (path === "/endless") {
      s.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
      const timer = setInterval(() => s.write("4\r\ndata\r\n"), 5);
      s.on("close", () => clearInterval(timer));
    } else if (path === "/gzip") {
      s.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${packed.length}\r\n\r\n`);
      for (let i = 0; i < packed.length; i += 50) s.write(packed.subarray(i, i + 50));
    } else if (path === "/gzip-truncated") {
      const part = packed.subarray(0, packed.length - 12);
      s.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${part.length}\r\n\r\n`);
      s.write(part);
    } else if (path === "/gzip-empty") {
      send("200 OK", "Content-Encoding: gzip\r\nContent-Length: 0\r\n", "");
    } else if (path === "/gzip-bad") {
      send("200 OK", "Content-Encoding: gzip\r\nContent-Length: 8\r\n", "not gzip");
    } else if (path === "/cut") {
      s.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789");
      setTimeout(() => s.destroy(), 20);
    } else if (path === "/no-content") {
      send("204 No Content", "", "");
    } else {
      send("200 OK", "Content-Length: 5\r\n", "plain");
    }
  });
});

export async function checkPeers(): Promise<void> {
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(peer.address() as net.AddressInfo).port}`;
  const dispatcher = new Agent();

  console.log("== peers: header values");
  // undici 5.12 writes a Host value with CR or LF into the request head;
  // the built-in implementation rejects it as undici 5.29 does
  // (package-shims.test.ts covers that).
  for (const [name, value] of [["x-test", "a\r\nX-Injected: 1"]]) {
    try {
      const res = await request(`${origin}/echo`, { dispatcher, headers: { [name!]: value! } });
      console.log(JSON.stringify(value), "sent:", await res.body.text());
    } catch (err) {
      console.log(JSON.stringify(value), describe(err));
    }
  }

  console.log("== peers: chunk-size lines");
  for (const [label, body] of chunkCases) {
    chunkBody = body;
    try {
      const res = await request(`${origin}/chunked`, { dispatcher });
      console.log(label, res.statusCode, JSON.stringify(await res.body.text()));
    } catch (err) {
      console.log(label, describe(err));
    }
  }

  console.log("== peers: fetch bodies");
  const tryFetch = async (
    label: string,
    path: string,
    read: (res: Response) => Promise<void>,
    method = "GET",
    signal: AbortSignal | null = null,
  ): Promise<void> => {
    try {
      const res = await fetch(`${origin}${path}`, { dispatcher, method, signal });
      console.log(label, res.status, res.body === null ? "null body" : "body");
      await read(res);
    } catch (err) {
      console.log(label, describe(err));
    }
  };
  await tryFetch("endless", "/endless", async (res) => {
    const reader = res.body!.getReader();
    const first = await reader.read();
    console.log("first chunk:", first.done, new TextDecoder().decode(first.value!).slice(0, 4));
    const before = closes;
    await reader.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    console.log("cancel closed the connection:", closes > before);
  });
  await tryFetch("gzip", "/gzip", async (res) => console.log("text matches:", (await res.text()) === text));
  await tryFetch("gzip-truncated", "/gzip-truncated", async (res) =>
    console.log("length", (await res.text()).length),
  );
  await tryFetch("gzip-empty", "/gzip-empty", async (res) => console.log(JSON.stringify(await res.text())));
  await tryFetch("gzip-bad", "/gzip-bad", async (res) => console.log(JSON.stringify(await res.text())));
  await tryFetch("cut", "/cut", async (res) => console.log(JSON.stringify(await res.text())));
  const controller = new AbortController();
  await tryFetch(
    "abort after headers",
    "/endless",
    async (res) => {
      controller.abort();
      console.log(await res.text());
    },
    "GET",
    controller.signal,
  );
  await tryFetch("no-content", "/no-content", async (res) => console.log(JSON.stringify(await res.text())));
  await tryFetch("head", "/plain", async (res) => console.log(JSON.stringify(await res.text())), "HEAD");

  await dispatcher.close();
  peer.close();
}
