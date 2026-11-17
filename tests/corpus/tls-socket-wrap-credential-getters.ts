// new tls.TLSSocket(socket, { isServer: true, ... }) reads its client
// certificate options through ordinary property access: getter-based
// requestCert and rejectUnauthorized still decide whether a client without a
// certificate completes the handshake.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const client = readFileSync(`${certs}/client.pem`);
const clientKey = readFileSync(`${certs}/client-key.pem`);

let label = "";

const server = net.createServer((raw) => {
  const socket = new tls.TLSSocket(raw, {
    isServer: true,
    cert,
    key,
    ca,
    get requestCert() {
      return true;
    },
    get rejectUnauthorized() {
      return true;
    },
  });
  socket.on("secure", () => {
    console.log(label, "handshake ok");
    socket.destroy();
  });
  socket.on("error", () => {
    console.log(label, "handshake failed");
    socket.destroy();
  });
  socket.on("data", () => {});
});

function probe(withCert: boolean, done: () => void): void {
  label = withCert ? "client cert" : "no cert";
  const connection = withCert
    ? tls.connect({ host: "localhost", port, ca, cert: client, key: clientKey })
    : tls.connect({ host: "localhost", port, ca });
  connection.on("error", () => {});
  connection.on("secureConnect", () => {});
  connection.on("close", () => setTimeout(done, 20));
  setTimeout(() => connection.destroy(), 150);
}

// A standalone socket treats a falsy rejectUnauthorized as "allow" (null, 0
// and the empty string included), unlike tls.Server's true default.
let falsyValue: unknown = null;
const falsyServer = net.createServer((raw) => {
  const socket = new tls.TLSSocket(raw, {
    isServer: true,
    cert,
    key,
    ca,
    requestCert: true,
    get rejectUnauthorized() {
      return falsyValue;
    },
  });
  socket.on("secure", () => {
    console.log("falsy reject secure", socket.authorized);
    socket.destroy();
  });
  socket.on("error", () => {
    console.log("falsy reject failed");
    socket.destroy();
  });
  socket.on("data", () => {});
});

function probeFalsy(value: unknown, done: () => void): void {
  falsyValue = value;
  const connection = tls.connect({ host: "localhost", port: falsyPort, ca });
  connection.on("error", () => {});
  connection.on("close", () => setTimeout(done, 20));
  setTimeout(() => connection.destroy(), 150);
}

let port = 0;
let falsyPort = 0;
server.listen(0, () => {
  port = (server.address() as net.AddressInfo).port;
  falsyServer.listen(0, () => {
    falsyPort = (falsyServer.address() as net.AddressInfo).port;
    probe(true, () =>
      probe(false, () =>
        probeFalsy(null, () =>
          probeFalsy(0, () =>
            probeFalsy("", () =>
              falsyServer.close(() => server.close(() => console.log("closed"))),
            ),
          ),
        ),
      ),
    );
  });
});
