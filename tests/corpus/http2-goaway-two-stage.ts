// node:http2 'goaway' fires for EVERY GOAWAY frame a session receives: a
// graceful two-stage close sends the frame that stops new streams and, once
// the live streams drain, a second one with the final last stream id. A raw
// peer delivers both to an h2 client, which must report both.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

// SETTINGS (empty), then GOAWAY(last stream id 5) and GOAWAY(last stream id 1).
const FRAMES = Buffer.from([
  0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 8, 7, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 8, 7, 0, 0,
  0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
]);

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = net.createServer((socket) => {
    socket.write(FRAMES.subarray(0, 9));
    socket.on("data", () => {});
    setTimeout(() => socket.write(FRAMES.subarray(9)), 100);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("goaway", (code, lastStreamID) => {
      lines.push(`goaway ${code} ${lastStreamID}`);
    });
    setTimeout(() => {
      client.destroy();
      server.close(() => resolve());
    }, 400);
  });
});

for (const line of lines) console.log(line);
