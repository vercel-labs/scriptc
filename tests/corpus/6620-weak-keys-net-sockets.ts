// Sockets and servers key WeakMaps and WeakSets by identity: the socket a
// connect callback sees, the one a 'connection' listener sees, and the
// same socket read back out of a diagnostics_channel message are one key.
// Entries of closed sockets stop answering once the socket is gone.
import * as net from "node:net";
import type { Server, Socket } from "node:net";
import { channel } from "node:diagnostics_channel";

interface Conn {
  label: string;
  bytes: number;
}

const connections = new WeakMap<Socket, Conn>();
const seen = new WeakSet<Socket>();
const servers = new WeakMap<Server, string>();
const opened = channel("example:socket:opened");

opened.subscribe((message) => {
  const { socket, label } = message as { socket: Socket; label: string };
  console.log(`[diag] ${label} known ${connections.has(socket)}, seen ${seen.has(socket)}`);
  const conn = connections.get(socket);
  if (conn !== undefined) conn.label = `${conn.label}+diag`;
});

// Each dial waits for both ends to close, so the two sides log in order.
let serverClosed: () => void = () => {};

const server = net.createServer((socket) => {
  seen.add(socket);
  connections.set(socket, { label: "server side", bytes: 0 });
  socket.on("data", (chunk) => {
    const conn = connections.get(socket);
    if (conn !== undefined) conn.bytes += chunk.length;
    socket.end(`echo ${chunk.toString()}`);
  });
  socket.on("close", () => {
    const conn = connections.get(socket);
    console.log("server socket closed", conn?.label, conn?.bytes);
    console.log("delete", connections.delete(socket), connections.delete(socket));
    serverClosed();
  });
});
servers.set(server, "echo server");

function dial(port: number, label: string): Promise<void> {
  const bothClosed = new Promise<void>((resolve) => {
    serverClosed = resolve;
  });
  const clientClosed = new Promise<void>((resolve) => {
    const client: Socket = net.connect(port, "127.0.0.1", () => {
      connections.set(client, { label, bytes: 0 });
      console.log(label, "connected; has", connections.has(client), "seen", seen.has(client));
      opened.publish({ socket: client, label });
      client.write(label);
    });
    let reply = "";
    client.on("data", (chunk) => {
      reply += chunk.toString();
    });
    client.on("close", () => {
      console.log(label, "reply", JSON.stringify(reply), "entry", connections.get(client)?.label);
      resolve();
    });
  });
  return Promise.all([clientClosed, bothClosed]).then(() => undefined);
}

server.listen(0, "127.0.0.1", async () => {
  console.log("server known", servers.has(server), servers.get(server));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await dial(port, "first");
  await dial(port, "second");
  try {
    connections.set(1 as unknown as Socket, { label: "number", bytes: 0 });
  } catch (err) {
    console.log((err as Error).name, (err as Error).message);
  }
  server.close(() => console.log("closed; server still known", servers.has(server)));
});
