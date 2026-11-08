// Other builtin handles where a record type names some of their members: a
// server, a file's stats and a socket stay themselves as arguments of a
// declared function, so a member read answers the handle's value at the
// time of the read.
import { statSync } from "node:fs";
import { connect, createServer } from "node:net";

function up(server: { listening: boolean }): boolean {
  return server.listening;
}
function sized(stats: { size: number; isDirectory(): boolean }): string {
  return `${stats.size >= 0}:${stats.isDirectory()}`;
}
function ends(socket: { remotePort?: number; destroyed: boolean }): string {
  return `${typeof socket.remotePort}:${socket.destroyed}`;
}

console.log(sized(statSync(".")), sized({ size: 3, isDirectory: () => false }));

const server = createServer((socket) => {
  socket.end();
});
console.log(up(server), up({ listening: true }));
server.listen(0, "127.0.0.1", () => {
  console.log(up(server));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client = connect(port, "127.0.0.1", () => {
    console.log(ends(client));
  });
  client.on("close", () => {
    console.log(ends(client), ends({ destroyed: false }));
    server.close(() => {
      console.log(up(server));
    });
  });
});
