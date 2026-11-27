// http2.performServerHandshake on a socket handed over by an HTTP/1 upgrade:
// the parser's context the upgraded socket kept until death must be released
// when the session takes the socket over (no leak at exit; the sanitized lane
// audits it), and the session closes with the destroyed socket.
import * as http from "node:http";
import * as http2 from "node:http2";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
let sessionClosed = false;
let serverClosed = false;

function maybeDone(): void {
  if (!sessionClosed || !serverClosed) return;
  for (const line of lines) console.log(line);
}

const server = http.createServer((req, res) => {
  res.end("http");
});
server.on("upgrade", (req, socket, head) => {
  lines.push(`upgrade ${String(req.headers.upgrade)} head ${head.length}`);
  const session = http2.performServerHandshake(socket);
  lines.push(`session type ${session.type}`);
  session.on("close", () => {
    lines.push("session close");
    sessionClosed = true;
    maybeDone();
  });
  session.on("error", (error) => {
    lines.push(`session error ${String((error as NodeJS.ErrnoException).code)}`);
  });
  socket.destroy();
});
server.listen(0, "127.0.0.1", () => {
  const client = connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    client.write("GET /upgrade HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n");
  });
  client.on("data", () => {});
  client.on("error", () => {});
  client.on("close", () => {
    server.close(() => {
      lines.push("server closed");
      serverClosed = true;
      maybeDone();
    });
  });
});
