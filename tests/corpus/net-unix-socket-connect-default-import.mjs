// net.createConnection(path) through the default import of node:net, as a
// JavaScript module reads it: a client of a Unix domain socket server.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-unix-default-"));
const socketPath = path.join(dir, "server.sock");
const server = net.createServer((socket) => socket.end("hello"));
server.listen(socketPath, () => {
  const sock = net.createConnection(socketPath);
  sock.once("connect", () => console.log("connected"));
  sock.on("data", (chunk) => console.log("data", String(chunk)));
  sock.once("error", (e) => console.log("error", String(e)));
  sock.on("close", () => {
    server.close(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("closed");
    });
  });
});
