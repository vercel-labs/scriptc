// A socket carries one HTTP/2 session: handshaking it again is Node's
// ERR_HTTP2_SOCKET_BOUND, and through the options form that refusal reaches
// the caller's catch instead of a null session being used.
import * as http2 from "node:http2";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = createServer((socket) => {
  const session = http2.performServerHandshake(socket);
  lines.push(`first type ${session.type}`);
  try {
    const again = http2.performServerHandshake(socket, { settings: {} });
    lines.push(`second type ${again.type}`);
  } catch (error) {
    const refused = error as Error & { code?: string };
    lines.push(`refused ${refused.code} ${refused.message}`);
  }
  session.on("stream", (stream, headers) => {
    lines.push(`stream ${headers[":path"]}`);
    stream.respond({ ":status": 200 });
    stream.end("bound");
  });
  session.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/one" });
  request.on("error", () => {});
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += String(chunk);
  });
  request.on("end", () => {
    lines.push(`done ${body}`);
    client.close(() =>
      server.close(() => {
        for (const line of lines) console.log(line);
      }),
    );
  });
  request.resume();
  request.end();
});
