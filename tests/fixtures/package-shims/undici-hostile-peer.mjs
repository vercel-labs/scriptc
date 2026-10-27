// A peer for package-shims.test.ts: prints its port, then answers
//   /extension  a chunk whose size line carries 64 MiB of extension,
//   /zeros      a chunk size with 64 MiB of leading zeros,
//   /big        a 64 MiB body, as fast as the socket takes it,
//   /bomb       64 MiB of zeros, gzipped,
//   /redirect-endless  a 302 to /redirect-closed whose body never ends,
//   /redirect-closed   "closed" once the last /redirect-endless connection
//                      closed (waiting up to a second), else "open",
// and exits when its stdin closes.
import * as net from "node:net";
import * as zlib from "node:zlib";

const MiB = 1024 * 1024;
const size = 64 * MiB;
const bomb = zlib.gzipSync(Buffer.alloc(size));

function stream(s, head, piece, tail) {
  s.write(head);
  let sent = 0;
  const pump = () => {
    while (sent < size) {
      sent += piece.length;
      if (!s.write(piece)) return void s.once("drain", pump);
    }
    s.write(tail);
  };
  pump();
}

let redirectClosed = Promise.resolve();

const server = net.createServer((s) => {
  s.on("error", () => {});
  let head = "";
  s.on("data", (d) => {
    head += d.toString("latin1");
    if (!head.includes("\r\n\r\n")) return;
    const path = head.split(" ")[1];
    head = "";
    const chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    if (path === "/extension") {
      stream(s, `${chunked}5;a=`, Buffer.alloc(64 * 1024, 98), "\r\nhello\r\n0\r\n\r\n");
    } else if (path === "/zeros") {
      stream(s, chunked, Buffer.alloc(64 * 1024, 48), "5\r\nhello\r\n0\r\n\r\n");
    } else if (path === "/big") {
      stream(s, `HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\n\r\n`, Buffer.alloc(64 * 1024, 97), "");
    } else if (path === "/redirect-endless") {
      redirectClosed = new Promise((resolve) => s.on("close", resolve));
      s.write("HTTP/1.1 302 Found\r\nLocation: /redirect-closed\r\nTransfer-Encoding: chunked\r\n\r\n");
      const timer = setInterval(() => s.write("4\r\ndata\r\n"), 5);
      s.on("close", () => clearInterval(timer));
    } else if (path === "/redirect-closed") {
      const timeout = new Promise((resolve) => setTimeout(() => resolve("open"), 1000));
      void Promise.race([redirectClosed.then(() => "closed"), timeout]).then((state) => {
        s.write(`HTTP/1.1 200 OK\r\nContent-Length: ${state.length}\r\n\r\n${state}`);
      });
    } else {
      s.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${bomb.length}\r\n\r\n`);
      s.write(bomb);
    }
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.stdin.on("end", () => process.exit(0)).resume();
