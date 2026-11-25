// node:http2 server session failures: a peer whose client magic is wrong
// raises the server's 'sessionError' and the session's 'error', both
// ERR_HTTP2_ERROR with Node's message, before the session closes.
import * as http2 from "node:http2";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("session", (session) => {
  lines.push("server session");
  session.on("error", (err: Error & { code?: string }) => {
    lines.push(`session error ${err.code} ${err.message}`);
  });
  session.on("close", () => lines.push("session close"));
});
server.on("sessionError", (err: Error & { code?: string }, session) => {
  lines.push(`sessionError ${err.code} ${err.message} session ${session !== null}`);
});
server.listen(0, "127.0.0.1", () => {
  const raw = connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    raw.write("GARBAGE\r\n\r\n");
  });
  raw.on("close", () => {
    server.close(() => {
      for (const line of lines.sort()) console.log(line);
      process.exit(0);
    });
  });
  raw.resume();
});
