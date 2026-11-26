// net.connect({ path, allowHalfOpen: true }) on a Unix socket: the
// Socket constructor's half-open member reaches the pipe form — the
// socket reports allowHalfOpen, and the peer's FIN leaves the write half
// open instead of ending the socket.
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-half-open-"));
const socketPath = path.join(dir, "server.sock");
const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};

let peer: net.Socket | null = null;
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  peer = socket;
  socket.end(); // the peer's FIN arrives at the client right away
});

server.listen(socketPath, () => {
  const client = net.connect({ path: socketPath, allowHalfOpen: true }, () => {
    say("connect", "allowHalfOpen", client.allowHalfOpen);
  });
  client.on("error", (err) => say("error", (err as NodeJS.ErrnoException).code));
  client.on("end", () => {
    say("end", "allowHalfOpen", client.allowHalfOpen, "writable", client.writable, "destroyed", client.destroyed);
    client.destroy();
  });
  client.on("close", () => {
    say("closed", "destroyed", client.destroyed);
    if (peer !== null) (peer as net.Socket).destroy();
    server.close(() => {
      say("server-closed");
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(out.join("\n"));
    });
  });
});
