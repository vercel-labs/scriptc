// A respondWithFile body in flight keeps its descriptor open, and that
// descriptor must not leak into a spawned child: Node opens files
// non-inheritable (O_CLOEXEC), so a child spawned while the response is
// parked sees no readable copy of the download.
import * as http2 from "node:http2";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const dir = fs.mkdtempSync(join(tmpdir(), "h2-cloexec-"));
const bigPath = join(dir, "download.txt");
fs.writeFileSync(bigPath, "x".repeat(4 * 1024 * 1024));
const target = bigPath.slice(bigPath.lastIndexOf("/") + 1);

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respondWithFile(bigPath, { ":status": 200 });
  stream.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  // the response is never read, so it parks with its descriptor open
  setTimeout(() => {
    const child = spawn("/bin/sh", ["-c", "for f in /proc/self/fd/*; do readlink $f; done"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const stdout = child.stdout;
    if (stdout !== null) {
      stdout.on("data", (chunk: Buffer) => {
        out += String(chunk);
      });
    }
    child.on("error", () => {});
    child.on("close", () => {
      lines.push(`child saw download: ${out.includes(target)}`);
      client.destroy();
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
  }, 150);
});
