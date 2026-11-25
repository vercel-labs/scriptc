// A typed connect listener on an HTTP/1 server declares its head as
// `Buffer | undefined`; the adapter builds the bytes arm, so the listener
// narrows and reads the bytes read past the CONNECT head.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  console.log("request", req.url);
  res.end("no");
});
server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer | undefined) => {
  console.log(
    "connect",
    req.url,
    head === undefined,
    head !== undefined && Buffer.isBuffer(head),
    head !== undefined ? head.length : -1,
    head !== undefined ? JSON.stringify(head.toString("utf8")) : "none",
  );
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = net.connect(port, "127.0.0.1", () => {
    client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\nEARLY");
  });
  let seen = "";
  client.on("data", (chunk: Buffer) => (seen += chunk.toString("utf8")));
  client.on("close", () => {
    console.log("client close", JSON.stringify(seen.split("\r\n")[0] ?? ""));
    server.close();
  });
});
