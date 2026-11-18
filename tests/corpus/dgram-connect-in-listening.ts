// Connects issued from a 'listening' callback: their deferred 'connect'
// emits must reach the loop in the same turn, not behind the program's
// next timer.
import * as dgram from "node:dgram";

const peer = dgram.createSocket("udp4");
peer.on("message", () => {});
await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));
const port = peer.address().port;

await new Promise<void>((resolve) => {
  const listening = dgram.createSocket("udp4");
  const connected: string[] = [];
  listening.bind(0, "127.0.0.1", () => {
    const clients = [dgram.createSocket("udp4"), dgram.createSocket("udp4")];
    clients.forEach((client, index) => {
      client.connect(port, "127.0.0.1", () => connected.push(String(index)));
    });
    setTimeout(() => {
      console.log("connected", connected.join(","));
      for (const client of clients) client.close();
      listening.close();
      resolve();
    }, 60);
  });
});

peer.close();
