// A server request that holds its body (nothing reads it yet, or its
// reader paused it) stops reading its socket once its buffer is full, so
// a client that keeps uploading is held back by TCP. Each client writes
// 64 KiB chunks, one after the previous write's callback, and stops when
// the response arrives. An unread body followed by a pipelined request is
// discarded once the response finishes, and the second request is served.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const MiB = 1024 * 1024;

function upload(port: number, path: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const frame = Buffer.concat([Buffer.from("10000\r\n"), Buffer.alloc(65536, 98), Buffer.from("\r\n")]);
    let sent = 0;
    let sentBeforeResponse = -1;
    let response = "";
    const writeNext = (): void => {
      if (sentBeforeResponse >= 0 || socket.destroyed || sent >= 256 * MiB) return;
      sent += 65536;
      socket.write(frame, () => {
        writeNext();
      });
    };
    socket.on("connect", () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n`);
      writeNext();
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (sentBeforeResponse < 0 && response.includes("\r\n\r\n")) {
        sentBeforeResponse = sent;
        socket.destroy();
        resolve(sentBeforeResponse);
      }
    });
    socket.on("error", () => {});
  });
}

function pipelined(port: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const body = "c".repeat(300000);
    let response = "";
    socket.on("connect", () => {
      socket.write(
        `POST /unread HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n${body}` +
          "GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => {
      const lines = response.split("\r\n").filter((line) => line.startsWith("HTTP/") || line.startsWith("served"));
      resolve(lines);
    });
  });
}

let pausedRequest: http.IncomingMessage | undefined;

const server = http.createServer((req, res) => {
  if (req.url === "/unconsumed") {
    setTimeout(() => {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("unconsumed");
    }, 300);
    return;
  }
  if (req.url === "/paused") {
    let seen = 0;
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (pausedRequest === undefined) {
        pausedRequest = req;
        req.pause();
        setTimeout(() => {
          res.writeHead(413, { "content-type": "text/plain" });
          res.end(`paused after ${seen > 0}`);
          req.resume();
        }, 300);
      }
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`served ${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  void (async () => {
    const before = process.memoryUsage().rss;
    const unconsumed = await upload(port, "/unconsumed");
    console.log("unconsumed: client stopped before 32 MiB:", unconsumed < 32 * MiB);
    const paused = await upload(port, "/paused");
    console.log("paused: client stopped before 32 MiB:", paused < 32 * MiB);
    console.log("memory grew under 64 MiB:", process.memoryUsage().rss - before < 64 * MiB);
    for (const line of await pipelined(port)) console.log(line);
    server.close(() => console.log("closed"));
  })();
});
