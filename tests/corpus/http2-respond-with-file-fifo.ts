// respondWithFile on a FIFO must not block the event loop: Node opens the
// stream off the loop and the request stays pending until a writer appears,
// while timers keep firing. The loop-liveness line is the assertion.
import * as http2 from "node:http2";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-fifo-"));
const fifo = join(dir, "pipe");
spawn("mkfifo", [fifo], { stdio: "ignore" }).on("exit", () => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    lines.push("stream");
    stream.respondWithFile(fifo, { ":status": 200 });
    stream.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/" });
    request.on("error", () => {});
    request.resume();
    setTimeout(() => lines.push("loop alive"), 100);
    setTimeout(() => {
      // a writer makes the pending open finish; the child blocks, not us
      const writer = spawn("/bin/sh", ["-c", `echo hi > '${fifo}'`], { stdio: "ignore" });
      writer.on("error", () => {});
    }, 150);
    setTimeout(() => {
      lines.push("giving up");
      client.destroy();
      server.close(() => {});
      for (const line of lines.sort()) console.log(line);
      process.exit(0);
    }, 400);
  });
});
