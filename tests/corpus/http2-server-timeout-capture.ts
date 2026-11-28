// Node captures the server timeout policy when a session is accepted: a later
// server.timeout = 0 does not stop an already-accepted session from
// forwarding its idle timeout to the server's listeners.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.setTimeout(40);
  server.on("timeout", () => lines.push("server timeout"));
  server.on("session", () => {
    server.timeout = 0;
    lines.push("timeout cleared");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("error", () => {});
    client.on("connect", () => {
      void delay(120).then(() => {
        lines.push(`alive ${!client.destroyed}`);
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
});

for (const line of lines.sort()) console.log(line);
