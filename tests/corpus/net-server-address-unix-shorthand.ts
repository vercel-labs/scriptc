// server.listen({ path }) with the shorthand property: the binding's own
// type is the path option's type, so the program listens on a Unix socket
// and address() answers the socket path while listening (null after close),
// never the TCP record.
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sock = join(tmpdir(), `scriptc-address-shorthand-${process.pid}.sock`);
const path = sock;
const server = net.createServer((socket) => socket.end("hello"));

function show(value: string | net.AddressInfo | null): string {
  if (typeof value === "string") return value.split(sock).join("<sock>");
  if (value === null) return "null";
  return `${value.address} ${value.family} ${value.port}`;
}

server.listen({ path }, () => {
  console.log("address", show(server.address()));
  server.close(() => console.log("closed", show(server.address())));
});
