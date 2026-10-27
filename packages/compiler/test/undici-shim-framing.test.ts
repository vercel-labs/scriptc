/* Message framing in the undici shim (packages/compiler/shims/undici),
 * against the real undici 5.12 and 7.30 the undici5/undici7 npm fixtures
 * vendor:
 *
 * - a chunk-size line is read as it arrives: an extension streamed in many
 *   pieces is skipped without keeping its bytes, and an oversized chunk
 *   size fails the response;
 * - a request with two Content-Length fields is rejected in both profiles
 *   before anything is written.
 */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as shim5 from "../shims/undici/v5.ts";
import * as shim7 from "../shims/undici/v7.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const real7 = (await import(
  join(repoRoot, "tests/fixtures/npm/cases/undici7/node_modules/undici/index.js")
)) as typeof shim7;
const real5 = (await import(
  join(repoRoot, "tests/fixtures/npm/cases/undici5/node_modules/undici/index.js")
)) as typeof shim7;

type Respond = (socket: Socket) => void;
let respond: Respond = () => {};
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((socket) => {
    socket.once("data", () => respond(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The body text, or the error's name, code and message. */
async function outcome(undici: typeof shim7, path: string): Promise<string> {
  const agent = new undici.Agent();
  try {
    const res = await undici.request(`${origin}${path}`, { dispatcher: agent });
    return `body ${await res.body.text()}`;
  } catch (err) {
    const e = err as Error & { code?: string };
    return `${e.name} ${e.code ?? ""} ${e.message}`;
  } finally {
    await agent.close();
  }
}

const HEAD = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

describe("undici shim chunked framing", () => {
  test("a chunk extension streamed in many pieces is skipped", async () => {
    // The bytes the shim's parser holds while the extension streams in.
    let parser: { buf: Buffer; queue: Buffer[] } | null = null;
    let retained = 0;
    respond = (socket) => {
      socket.write(HEAD + "5;name=");
      let left = 2048;
      const piece = "x".repeat(1024);
      const next = (): void => {
        if (parser !== null) {
          const held = parser.buf.length + parser.queue.reduce((n, b) => n + b.length, 0);
          retained = Math.max(retained, held);
        }
        if (left-- > 0) {
          socket.write(piece);
          setImmediate(next);
        } else {
          socket.end("\r\nhello\r\n0\r\n\r\n");
        }
      };
      next();
    };
    const expected = await outcome(real7, "/extension");
    expect(expected).toBe("body hello");

    const client = new shim7.Client(origin) as unknown as {
      __parser: { buf: Buffer; queue: Buffer[] } | null;
      request(options: object): Promise<{ body: { text(): Promise<string> } }>;
      close(): Promise<void>;
    };
    const pending = client.request({ path: "/extension", method: "GET" });
    const watch = setInterval(() => {
      if (client.__parser !== null) parser = client.__parser;
    }, 0);
    const res = await pending;
    expect(await res.body.text()).toBe("hello");
    clearInterval(watch);
    await client.close();
    expect(parser).not.toBeNull();
    expect(retained).toBeLessThan(64 * 1024);
  }, 60_000);

  for (const [name, real, undici] of [
    ["5.x", real5, shim5 as unknown as typeof shim7],
    ["7.x", real7, shim7],
  ] as const) {
    test(`${name}: an oversized chunk size fails the response`, async () => {
      respond = (socket) => socket.end(HEAD + "fffffffffffffffffff\r\n");
      const expected = await outcome(real, "/overflow");
      expect(expected).toContain("Chunk size overflow");
      expect(await outcome(undici, "/overflow")).toBe(expected);
    });

    test(`${name}: an invalid chunk-size character fails the response`, async () => {
      respond = (socket) => socket.end(HEAD + "5z\r\nhello\r\n0\r\n\r\n");
      const expected = await outcome(real, "/invalid");
      expect(expected).toContain("Invalid character in chunk size");
      expect(await outcome(undici, "/invalid")).toBe(expected);
    });
  }
});

describe("undici shim Content-Length", () => {
  const headers = { "content-length": "5", "Content-Length": "5" };
  for (const [name, undici] of [
    ["5.x", shim5 as unknown as typeof shim7],
    ["7.x", shim7],
  ] as const) {
    test(`${name} rejects a duplicate Content-Length`, async () => {
      let wrote = false;
      respond = (socket) => {
        wrote = true;
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      };
      const agent = new undici.Agent();
      const err = await undici
        .request(`${origin}/duplicate`, {
          dispatcher: agent,
          method: "POST",
          headers,
          body: "hello",
        })
        .then(
          () => null,
          (e: Error & { code?: string }) => e,
        );
      await agent.close();
      expect(err?.message).toBe("duplicate content-length header");
      expect(err?.code).toBe("UND_ERR_INVALID_ARG");
      expect(wrote).toBe(false);
    });
  }

  test("real undici 7.x rejects it with the same error", async () => {
    const agent = new real7.Agent();
    const err = await real7
      .request(`${origin}/duplicate`, { dispatcher: agent, method: "POST", headers, body: "hello" })
      .then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
    await agent.close();
    expect(err?.message).toBe("duplicate content-length header");
    expect(err?.code).toBe("UND_ERR_INVALID_ARG");
  });
});
