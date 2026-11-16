// connect() on an established socket re-runs the connect flow: 'connect'
// fires again, the call's listener runs, and the socket stays open.
import * as net from "node:net";

const events: string[] = [];
const server = net.createServer((socket) => socket.on("data", () => {}));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const socket = net.connect(port, "127.0.0.1", () => events.push("first"));
socket.on("connect", () => events.push("connect"));
await new Promise<void>((resolve) => setTimeout(resolve, 30));

socket.connect(port, "127.0.0.1", () => events.push("second"));
await new Promise<void>((resolve) => setTimeout(resolve, 60));
events.push(`open=${!socket.destroyed}`);
console.log(events.join(","));

socket.destroy();
server.close();
