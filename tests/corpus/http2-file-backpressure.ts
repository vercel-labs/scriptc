// node:http2 file responses under transport backpressure: a client that
// stops reading a large respondWithFile response must not stall the
// process — another connection's request and timers keep running, and the
// paused download resumes to the full length when the client reads again.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-bp-"));
const file = join(dir, "big.txt");
fs.writeFileSync(file, "x".repeat(512000));
const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
  if (path === "/slow") {
    stream.respondWithFile(file, { ":status": 200 });
  } else {
    stream.respond({ ":status": 200 });
    stream.end("fast");
  }
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const slow = http2.connect(`http://127.0.0.1:${port}`);
  const fast = http2.connect(`http://127.0.0.1:${port}`);
  const slowReq = slow.request({ ":path": "/slow" });
  let slowBytes = 0;
  let paused = false;
  slowReq.on("data", (chunk: Buffer) => {
    slowBytes += chunk.length;
    if (!paused) {
      paused = true;
      slowReq.pause();
      lines.push("slow paused");
      const timer = setTimeout(() => lines.push("timer ran while slow blocked"), 30);
      const fastReq = fast.request({ ":path": "/fast" });
      let body = "";
      fastReq.on("data", (d: Buffer) => (body += String(d)));
      fastReq.on("response", (h: http2.IncomingHttpHeaders) =>
        lines.push(`fast response ${h[":status"]}`),
      );
      fastReq.on("end", () => {
        clearTimeout(timer);
        lines.push(`fast body ${body}`);
        setTimeout(() => {
          slowReq.resume();
          slowReq.on("end", () => {
            lines.push(`slow bytes ${slowBytes}`);
            slow.close();
            fast.close();
            fs.rmSync(dir, { recursive: true, force: true });
            server.close(() => {
              for (const line of lines) console.log(line);
            });
          });
        }, 50);
      });
      fastReq.resume();
      fastReq.end();
    }
  });
  slowReq.resume();
  slowReq.end();
});
