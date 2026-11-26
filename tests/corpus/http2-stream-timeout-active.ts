// A slow-but-draining body is not idle: every window refresh that releases
// more DATA refreshes the stream's timeout, so a transfer that outlives the
// timeout still completes without a 'timeout' event (Node's stream timer
// tracks activity, not the initial write). A body that stops moving times
// out — see http2-stream-timeout-stalled.ts.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const body = Buffer.alloc(2 * 1024 * 1024, 0x78);

function transfer(path: string, readDelay: number): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      lines.push(`${path} stream`);
      stream.setTimeout(40);
      stream.on("timeout", () => lines.push(`${path} timeout event`));
      stream.setTimeout(40, () => lines.push(`${path} timeout cb`));
      stream.respond({ ":status": 200 });
      stream.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": path });
      let got = 0;
      request.on("data", (chunk: Buffer) => {
        got += chunk.length;
        if (readDelay > 0) {
          request.pause();
          setTimeout(() => request.resume(), readDelay);
        }
      });
      request.on("error", () => {});
      request.on("close", () => {
        lines.push(`${path} done ${got === body.length ? "full" : got}`);
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
}

// the read side pauses briefly after each chunk: the body keeps moving for
// far longer than the timeout, so no timeout may fire
await transfer("/slow", 4);
// an undelayed body also finishes without one
await transfer("/fast", 0);

for (const line of lines) console.log(line);
