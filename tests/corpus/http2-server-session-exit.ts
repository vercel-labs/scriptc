// A process that exits with a live HTTP/2 server session: both session
// sockets are unref'd, so the loop drains while the server's session (and
// the session list the server.close() path keeps) is still open. The
// exit-time cleanup must release the session and its socket — the RC audit
// (sanitized lane) fails with live listener closures otherwise.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
const lines: string[] = [];
const server = http2.createServer();
server.on("session", (session) => {
  lines.push("session");
  session.on("close", () => lines.push("session close"));
  session.socket.unref();
});
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/exit" });
  request.on("end", () => {
    client.socket.unref();
    server.unref();
    for (const line of lines) console.log(line);
  });
  request.resume();
  request.end();
});
