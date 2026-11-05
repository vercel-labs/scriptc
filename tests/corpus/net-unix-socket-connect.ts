// net.createConnection and net.connect to a Unix domain socket: a path
// argument, the `path` option, a connect listener, data both ways, the
// error for a path nothing listens on, and a numeric string, which Node
// treats as a localhost port.
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-unix-connect-"));
const socketPath = path.join(dir, "server.sock");
const missingPath = path.join(dir, "missing.sock");

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    socket.write(`echo:${chunk.toString()}`);
  });
});

function exchange(label: string, socket: net.Socket, message: string): Promise<void> {
  return new Promise((resolve) => {
    socket.on("data", (chunk) => {
      console.log(label, chunk.toString());
      socket.end();
    });
    socket.on("close", () => resolve());
    socket.write(message);
  });
}

server.listen(socketPath, async () => {
  console.log("listening");
  const first = net.createConnection(socketPath);
  first.once("connect", () => console.log("first connected"));
  await exchange("first", first, "one");

  let listenerCalls = 0;
  const second = net.connect(socketPath, () => {
    listenerCalls++;
  });
  await exchange("second", second, "two");
  console.log("second listener calls", listenerCalls);

  const third = net.createConnection({ path: socketPath });
  await exchange("third", third, "three");

  await new Promise<void>((resolve) => {
    const missing = net.createConnection(missingPath);
    missing.once("connect", () => console.log("missing connected"));
    missing.once("error", (error: NodeJS.ErrnoException) => {
      console.log("missing", error.code, error.message === `connect ENOENT ${missingPath}`);
      resolve();
    });
  });

  server.close(() => {
    const tcp = net.createServer((socket) => socket.end("tcp"));
    tcp.listen(0, "localhost", () => {
      const { port } = tcp.address() as net.AddressInfo;
      const client = net.createConnection(String(port));
      client.on("data", (chunk) => console.log("numeric string", chunk.toString()));
      client.on("close", () => {
        tcp.close();
        fs.rmSync(dir, { recursive: true, force: true });
        console.log("done");
      });
    });
  });
});
