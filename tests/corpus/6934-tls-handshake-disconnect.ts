// A server that closes the connection before the TLS handshake completes:
// tls.connect and https.get fail with ECONNRESET and Node's "Client network
// socket disconnected before secure TLS connection was established".
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

const server = net.createServer((socket) => {
  socket.end();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
    console.log("tls connected");
  });
  client.on("error", (error: Error) => {
    console.log("tls", (error as NodeJS.ErrnoException).code, error.message);
    const request = https.get({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      console.log("https response");
    });
    request.on("error", (err: Error) => {
      console.log("https", (err as NodeJS.ErrnoException).code, err.message);
      server.close();
    });
  });
});
