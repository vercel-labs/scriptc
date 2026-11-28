// A server 'timeout' listener registered with once() counts as handling the
// timeout: the session is not destroyed once that listener has run (Node
// destroys only when no listener exists at the fire), so the connection
// survives the idle period even though the listener list is empty again.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.setTimeout(30);
  let fires = 0;
  const onTimeout = (): void => {
    fires += 1;
    lines.push(`timeout ${fires}`);
    if (fires < 2) server.once("timeout", onTimeout);
  };
  server.once("timeout", onTimeout);
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
