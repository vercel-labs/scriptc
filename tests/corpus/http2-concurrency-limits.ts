// The peer's maxConcurrentStreams bounds the client: a request created while
// the limit is reached keeps its HEADERS back (Node's `pending`/deferred
// block) and goes out when a slot frees, and a server never opens a stream
// past what it advertised — the excess HEADERS block is refused with
// REFUSED_STREAM, which the peer sees as ERR_HTTP2_STREAM_ERROR.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function listen(server: http2.Http2Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http2.Http2Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A: the client defers a request while the server's advertised limit is full.
{
  const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } });
  server.on("stream", (stream, headers) => {
    lines.push(`A server stream ${String(headers[":path"])}`);
    setTimeout(() => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    }, 150);
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    const make = (path: string) => {
      const request = client.request({ ":path": path });
      lines.push(`A client ${path} pending=${request.pending}`);
      request.on("ready", () => lines.push(`A client ${path} ready id=${String(request.id)}`));
      request.on("error", () => lines.push(`A client ${path} error`));
      request.on("response", (headers) =>
        lines.push(`A client ${path} response ${String(headers[":status"])}`),
      );
      request.on("close", () => lines.push(`A client ${path} close rst=${request.rstCode}`));
      request.resume();
    };
    make("/one");
    setTimeout(() => make("/two"), 20);
    setTimeout(() => {
      client.destroy();
      resolve();
    }, 700);
  });
  await close(server);
}

// B: the server refuses the HEADERS blocks past the limit it advertised.
{
  const server = http2.createServer();
  server.on("session", (session) => {
    session.settings({ maxConcurrentStreams: 1 });
    session.on("error", (error) => {
      const err = error as Error & { code?: string };
      lines.push(`B server session error ${err.code ?? "-"} ${err.message}`);
    });
  });
  server.on("stream", (stream, headers) => {
    lines.push(`B server stream ${String(headers[":path"])}`);
    stream.on("close", () =>
      lines.push(`B server stream close ${String(headers[":path"])} rst=${stream.rstCode}`),
    );
    setTimeout(() => {
      if (!stream.destroyed) {
        stream.respond({ ":status": 200 });
        stream.end("ok");
      }
    }, 300);
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    const make = (path: string) => {
      const request = client.request({ ":path": path });
      request.on("error", (error) => {
        const err = error as Error & { code?: string };
        lines.push(`B client ${path} error ${err.code ?? "-"} ${err.message}`);
      });
      request.on("close", () => lines.push(`B client ${path} close rst=${request.rstCode}`));
      request.on("response", (headers) =>
        lines.push(`B client ${path} response ${String(headers[":status"])}`),
      );
      request.resume();
    };
    make("/one");
    make("/two");
    setTimeout(() => {
      client.close(() =>
        close(server).then(() => {
          resolve();
        }),
      );
    }, 500);
  });
}

for (const line of lines.sort()) console.log(line);
