// The TypeScript twin of compat-http2-basics.mjs: node:http2 from a typed
// source, over cleartext on loopback. A client session's 'connect',
// 'close' and 'error' events, its type and socket, close() with a
// callback, the server session's 'stream' event, a stream's session, and
// through the compatibility API the request's complete flag and 'close'
// event, and the response's getHeaderNames(), getHeaders() and
// setTimeout(). The 'connect' listener takes no parameters here; the
// JavaScript program reads its session and socket arguments.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

/** A header value as text: a pseudo-header or a single-valued header. */
const text = (value: string | string[] | number | undefined): string =>
  typeof value === "string" ? value : typeof value === "number" ? `${value}` : "";

// Core API: session events and state.
await new Promise<void>((resolve) => {
  const lines: string[] = [];
  const server = http2.createServer();
  server.on("session", (session) => {
    lines.push(`server type ${session.type === http2.constants.NGHTTP2_SESSION_SERVER}`);
    session.on("stream", (_stream, headers, flags) => lines.push(`session stream ${text(headers[":path"])} ${typeof flags}`));
  });
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      lines.push("client connect");
      lines.push(`client type ${client.type === http2.constants.NGHTTP2_SESSION_CLIENT}`);
      lines.push(`client socket ${typeof client.socket.remotePort} ${client.socket.remoteAddress}`);
    });
    client.on("close", () => lines.push("client close"));
    const request = client.request({ ":path": "/core" });
    lines.push(`stream session ${request.session === client}`);
    request.resume();
    request.on("end", () =>
      client.close(() => {
        lines.push(`closed ${client.closed} ${client.destroyed}`);
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
          resolve();
        });
      }),
    );
    request.end();
  });
});

// A session to a closed port reports the connection error and closes.
await new Promise<void>((resolve) => {
  const client = http2.connect("http://127.0.0.1:1");
  client.on("error", (error: NodeJS.ErrnoException) => console.log("error", error.code));
  client.on("close", () => {
    console.log("close after error");
    resolve();
  });
});

// Compatibility API: request flags and events, response header reads.
// The two ends run concurrently, so the lines are sorted.
await new Promise<void>((resolve) => {
  const lines: string[] = [];
  const server = http2.createServer((request, response) => {
    request.on("close", () => lines.push("request close"));
    request.resume();
    request.on("end", () => {
      lines.push(`request ${request.complete}`);
      response.setHeader("X-A", "1");
      response.setHeader("x-b", ["2", "3"]);
      lines.push(`headers ${response.getHeaderNames().join(",")} ${JSON.stringify(response.getHeaders())}`);
      response.setTimeout(1000, () => {});
      response.end("done");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/compat" });
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => lines.push(`status ${text(headers[":status"])} ${text(headers["x-a"])}`));
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      lines.push(`body ${body}`);
      client.close(() =>
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
          resolve();
        }),
      );
    });
    request.end();
  });
});
