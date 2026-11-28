// A session created by http2.performServerHandshake arms the same idle timer
// the accepted-connection and client paths do: session.setTimeout fires its
// typed 'timeout' listeners and the checked-dynamic registrations.
import * as http2 from "node:http2";
import { createServer } from "node:net";

const lines: string[] = [];
const server = createServer((socket) => {
  const session = http2.performServerHandshake(socket);
  session.setTimeout(30);
  session.on("timeout", () => lines.push("typed timeout"));
  const dynamic: any = session;
  dynamic.on("timeout", () => lines.push("dynamic timeout"));
  session.on("close", () => lines.push("session close"));
  session.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  client.on("error", () => {});
  // the connection stays idle: the session's timer is the only event
  setTimeout(() => {
    client.destroy();
    server.close(() => {
      const counts = new Map<string, number>();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      for (const key of [...counts.keys()].sort()) console.log(`${key} x${counts.get(key)}`);
    });
  }, 250);
});
