// A named options record crosses into the checked-dynamic lane as a typed
// capsule. net.BoundSocket reads its materialized fields, so a record
// variable binds exactly like the inline literal, and server.listen too
// reads the handle the record carries.
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-bound-record-"));
const socketPath = path.join(dir, "record.sock");
const mask = (text: string): string => text.split(dir).join("<dir>");

const tcpOptions: { port: number; host: string } = { port: 0, host: "127.0.0.1" };
const tcp = new net.BoundSocket(tcpOptions);
const tcpAddress = tcp.address() as { family: string; address: string; port: number };
console.log("tcp record", tcpAddress.family, tcpAddress.address, tcpAddress.port > 0, tcp.isPipe);
tcp.close();

const pipeOptions: { path: string } = { path: socketPath };
const bound = new net.BoundSocket(pipeOptions);
console.log("pipe record", bound.address() === socketPath, bound.isPipe, fs.existsSync(socketPath));

// The options bag a typed variable holds may carry the handle: listen reads
// it through the runtime ladder, which adopts the bound socket.
const adopt: any = { handle: bound };
const server = net.createServer((socket) => socket.end("ok"));
server.on("error", (err: NodeJS.ErrnoException) =>
  console.log("server error", err.code, mask(err.message)),
);
server.listen(adopt, () => {
  console.log("adopted", server.listening, fs.existsSync(socketPath));
  server.close(() => {
    console.log("unlinked", fs.existsSync(socketPath));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("done");
  });
});
