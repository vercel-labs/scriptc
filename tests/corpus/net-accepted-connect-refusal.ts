// connect() on an accepted socket (one that already has an established
// descriptor) refuses with Node's EISCONN error instead of dialing over the
// live connection; the message names the target and the local endpoint.
import * as net from "node:net";

const masked = (text: string): string =>
  text.replace(/\(\d{1,3}(?:\.\d{1,3}){3}:\d+\)/, "(<local>)");

const server = net.createServer((peer) => {
  peer.on("data", () => {});
  peer.on("error", (error: Error & { code?: string }) => {
    console.log("refused", error.code, masked(error.message));
    peer.destroy();
    server.close();
  });
  console.log("accepted");
  peer.connect(9, "127.0.0.1");
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
    setTimeout(() => client.end(), 50);
  });
  client.on("error", () => {});
  client.on("close", () => {});
});
