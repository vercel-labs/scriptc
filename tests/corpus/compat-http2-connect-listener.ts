// A node:http2 client's 'connect' listener and connect() callback receive
// (session, socket). A listener may declare the socket with its own type,
// or leave it untyped: the socket then arrives as a dynamic value that is
// still the socket.
import * as http2 from "node:http2";
import type { AddressInfo, Socket } from "node:net";

const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const client = http2.connect(`http://127.0.0.1:${port}`, (session: http2.Http2Session, socket: unknown) => {
    console.log("callback", session === client, typeof socket);
  });
  client.on("connect", (session: http2.Http2Session, socket: unknown) => {
    console.log("untyped socket", session === client, typeof socket);
  });
  client.on("connect", (session: http2.Http2Session, socket: Socket) => {
    console.log("typed socket", session === client, typeof socket.remotePort);
  });
  client.on("connect", (session: http2.Http2Session) => {
    console.log("session only", session === client);
    client.close();
  });
  client.on("close", () => {
    console.log("close");
    server.close();
  });
});
