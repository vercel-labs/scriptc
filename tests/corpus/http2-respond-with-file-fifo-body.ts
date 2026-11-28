// respondWithFile on a FIFO streams it like Node's file stream does: the
// response goes out at once, the body follows as a writer produces it, and
// the stream ends at the writer's EOF (a read that returns nothing before
// any data is "not yet", not the end).
import * as http2 from "node:http2";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-fifo-body-"));
const fifo = join(dir, "pipe");
spawn("mkfifo", [fifo], { stdio: "ignore" }).on("exit", () => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respondWithFile(fifo, { ":status": 200 });
    stream.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/" });
    let body = "";
    request.on("error", () => {});
    request.on("data", (chunk: Buffer) => {
      body += String(chunk);
    });
    request.on("response", (headers) => lines.push(`response ${String(headers[":status"])}`));
    request.on("end", () => {
      lines.push(`body ${JSON.stringify(body)}`);
      client.destroy();
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
    request.resume();
    setTimeout(() => {
      const writer = spawn("/bin/sh", ["-c", `printf hi > '${fifo}'`], { stdio: "ignore" });
      writer.on("error", () => {});
    }, 150);
    setTimeout(() => {
      lines.push("giving up");
      client.destroy();
      server.close(() => {});
      for (const line of lines.sort()) console.log(line);
      process.exit(0);
    }, 900);
  });
});
