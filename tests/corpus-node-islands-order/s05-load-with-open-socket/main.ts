// @requires-libnode
// Switch: a TCP server and a client connection of the program are open when Node
// loads: their I/O continues on Node's loop.
import { callSync } from "@scriptc/node";
import { readFile, writeSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";

function log(s: string): void {
  writeSync(1, `${s}\n`);
}

function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function island(src: string): void {
  callSync("../island.cjs", "run", src);
}

const server = createServer((socket: Socket) => {
  socket.on("data", (data: Buffer) => {
    log(`h-server-data ${data.toString()}`);
    socket.end("pong");
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  log("h-listening");
  const client = createConnection(port, "127.0.0.1", () => {
    log("h-connected");
    island("K { L i-k } M { L i-m } T 200 { L i-late }");
    client.write("ping");
  });
  client.on("data", (data: Buffer) => log(`h-client-data ${data.toString()}`));
  client.on("end", () => {
    log("h-client-end");
    server.close(() => log("h-closed"));
  });
});
