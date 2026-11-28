// A lengthless source that produces nothing still ends its response: a
// writer that opens and closes a FIFO without writing, and /dev/null, both
// make Node send an empty body and end the stream.
import * as http2 from "node:http2";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-fifo-empty-"));
const fifo = join(dir, "pipe");

function serve(label: string, path: string, writer: (() => void) | null): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.respondWithFile(path, { ":status": 200 });
      stream.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/" });
      let body = "";
      request.on("error", () => {});
      request.on("response", (headers) => lines.push(`${label} response ${String(headers[":status"])}`));
      request.on("data", (chunk: Buffer) => {
        body += String(chunk);
      });
      request.on("end", () => lines.push(`${label} body ${JSON.stringify(body)}`));
      request.resume();
      if (writer !== null) setTimeout(writer, 100);
      setTimeout(() => {
        client.destroy();
        server.close(() => resolve());
      }, 500);
    });
  });
}

await new Promise<void>((resolve) => {
  spawn("mkfifo", [fifo], { stdio: "ignore" }).on("exit", () => resolve());
});
await serve("devnull", "/dev/null", null);
await serve("empty-writer", fifo, () => {
  const writer = spawn("/bin/sh", ["-c", `exec 3>'${fifo}'; exec 3>&-`], { stdio: "ignore" });
  writer.on("error", () => {});
});
for (const line of lines.sort()) console.log(line);
