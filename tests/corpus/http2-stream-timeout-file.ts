// The stream idle timer stays quiet while a response is genuinely making
// progress: a file body whose transfer is briefly window-blocked on a paused
// client, and app writes buffered behind the same flow control.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-idle-"));
const bigPath = join(dir, "big.txt");
fs.writeFileSync(bigPath, "x".repeat(200000));

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
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
server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as AddressInfo).port;
  for (const path of ["/file", "/buffered"]) {
    await new Promise<void>((resolve) => {
      const client = http2.connect(`http://127.0.0.1:${port}`);
      const request = client.request({ ":path": path });
      request.on("error", () => {});
      // briefly paused: the transfer is window-blocked, then resumes well
      // inside the idle timeout (a full stall is http2-stream-timeout-stalled)
      setTimeout(() => request.resume(), 30);
      request.on("end", () => {
        lines.push(`${path} end`);
        client.destroy();
        resolve();
      });
    });
  }
  server.close(() => {
    for (const line of lines) console.log(line);
  });
});
