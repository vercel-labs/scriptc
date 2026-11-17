// connect() on an established socket re-runs the connect flow: 'connect'
// fires again and the call's listener runs — also when the connect() is
// issued from that deferred 'connect' listener itself, with nothing else
// keeping the loop busy.
import * as net from "node:net";

const events: string[] = [];
const server = net.createServer((socket) => socket.on("data", () => {}));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const socket = net.connect(port, "127.0.0.1");
let connects = 0;
await new Promise<void>((resolve) => {
  socket.on("connect", () => {
    connects += 1;
    events.push(`connect ${connects}`);
    if (connects === 1) {
      socket.connect(port, "127.0.0.1", () => {
        events.push("second callback");
        resolve();
      });
    }
  });
});
events.push(`open=${!socket.destroyed}`);
console.log(events.join(","));

socket.destroy();
server.close();
