// A stalled body is idle: with the peer never reading, the stream's timeout
// fires even while a respondWithFile body or buffered writes are parked
// behind flow control — the retry passes that keep re-parking must not
// refresh the idle deadline (Node times such a stream out).
import * as fs from "node:fs";
import * as http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-stall-"));
const bigPath = join(dir, "big.txt");
fs.writeFileSync(bigPath, "x".repeat(200000));

function stall(path: string): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      lines.push(`${path} stream`);
      stream.on("timeout", () => lines.push(`${path} timeout event`));
      stream.setTimeout(60, () => lines.push(`${path} timeout cb`));
      if (path === "/file") {
        stream.respondWithFile(bigPath, { ":status": 200 });
      } else {
        stream.respond({ ":status": 200 });
        for (let i = 0; i < 20; i++) stream.write("y".repeat(10000));
        stream.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": path });
      request.on("error", () => {});
      // the peer never reads: the body stays parked behind flow control
      setTimeout(() => {
        client.destroy();
        server.close(() => resolve());
      }, 400);
    });
  });
}

await stall("/file");
await stall("/buffered");

for (const line of lines) console.log(line);
