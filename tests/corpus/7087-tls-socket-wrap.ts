// new tls.TLSSocket(socket, { isServer: true, ... }) over a net server's
// connection: the wrap is a new socket that runs the server handshake, with
// cert/key or a secureContext and ALPNProtocols. The wrapped socket stays
// open without I/O, destroy() on it closes both, and its 'close' fires just
// before the TLS socket's. A peer that closes, resets or sends bytes that
// are not TLS fails the handshake with Node's events and codes.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const context = tls.createSecureContext({ cert, key });

// cert/key and ALPN: the events, the state of both sockets, and the data.
function certKey(next: () => void): void {
  const server = net.createServer((raw) => {
    raw.on("close", (hadError: boolean) => console.log("raw close", hadError, raw.destroyed));
    const s = new tls.TLSSocket(raw, { isServer: true, cert, key, ALPNProtocols: ["h2", "http/1.1"] });
    console.log("after wrap", raw.destroyed, raw.readyState, raw.writable, s === raw);
    console.log("before handshake", s.destroyed, s.encrypted, s.alpnProtocol);
    console.log("same peer", s.remoteAddress === raw.remoteAddress, s.remotePort === raw.remotePort);
    s.on("connect", () => console.log("never: connect"));
    s.on("secureConnect", () => console.log("never: secureConnect"));
    s.on("secure", () => {
      console.log("secure", s.getProtocol(), s.alpnProtocol, s.authorized, s.authorizationError);
    });
    s.on("data", (chunk: Buffer) => {
      console.log("server data", chunk.toString());
      s.end("pong");
    });
    s.on("end", () => console.log("server end"));
    s.on("close", (hadError: boolean) => {
      console.log("tls close", hadError, raw.destroyed, s.destroyed);
      server.close(next);
    });
  });
  server.listen(0, () => {
    const port = (server.address() as net.AddressInfo).port;
    const c = tls.connect({ port, host: "localhost", ca, ALPNProtocols: ["http/1.1"] }, () => {
      console.log("client secureConnect", c.authorized, c.alpnProtocol);
      c.write("ping");
    });
    c.on("secure", () => console.log("client secure"));
    c.on("data", (chunk: Buffer) => console.log("client data", chunk.toString()));
    c.on("close", () => console.log("client close"));
  });
}

// secureContext, and destroy() on the wrapped socket.
function secureContext(next: () => void): void {
  const server = net.createServer((raw) => {
    raw.on("close", (hadError: boolean) => console.log("raw close", hadError));
    const s = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
    s.on("secure", () => {
      console.log("context secure", s.alpnProtocol);
      raw.destroy();
    });
    s.on("close", (hadError: boolean) => {
      console.log("tls close", hadError, s.destroyed);
      server.close(next);
    });
  });
  server.listen(0, () => {
    const port = (server.address() as net.AddressInfo).port;
    const c = tls.connect({ port, host: "localhost", ca }, () => console.log("client secureConnect"));
    c.on("error", (err: Error & { code?: string }) => console.log("client error", err.code));
    c.on("close", () => console.log("client close"));
  });
}

// Handshakes the peer fails.
function failure(mode: string, next: () => void): void {
  const server = net.createServer((raw) => {
    const s = new tls.TLSSocket(raw, { isServer: true, cert, key });
    s.on("secure", () => console.log("never: secure"));
    s.on("error", (err: Error & { code?: string }) => console.log(mode, "error", err.code));
    s.on("end", () => console.log(mode, "end"));
    s.on("close", (hadError: boolean) => {
      console.log(mode, "close", hadError);
      server.close(next);
    });
  });
  server.listen(0, () => {
    const port = (server.address() as net.AddressInfo).port;
    const c = net.connect(port, "localhost", () => {
      if (mode === "close") c.end();
      else if (mode === "garbage") c.end("hello there, this is not tls\r\n");
      else if (mode === "http") c.end("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      else c.resetAndDestroy();
    });
    c.on("error", () => {});
  });
}

certKey(() =>
  secureContext(() =>
    failure("close", () =>
      failure("garbage", () => failure("http", () => failure("reset", () => console.log("done")))),
    ),
  ),
);
