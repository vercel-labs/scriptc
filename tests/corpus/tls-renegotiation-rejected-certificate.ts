// A TLS 1.2 renegotiation that switches to requiring and rejecting a client
// certificate the server's trust store cannot chain. The handshake completes
// — the peer re-sends the self-signed certificate it has — and the server then
// destroys the socket from its own 'secure' listener, as Node's server does:
// from that point the socket answers like a destroyed one, so the rejected
// certificate is no longer handed out by getPeerCertificate. Each side prints
// its events in its own order, so the cross-side interleaving is not part of
// the test.
import { readFileSync } from "node:fs";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const ca = readFileSync(`${certs}/ca.pem`);
const untrustedCert = readFileSync(`${certs}/other-server.pem`);
const untrustedKey = readFileSync(`${certs}/other-server-key.pem`);

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const peer = (socket: tls.TLSSocket): string => {
  const certificate = socket.getPeerCertificate();
  const subject = certificate?.subject as { CN?: string } | undefined;
  return subject === undefined ? "none" : subject.CN ?? "?";
};
const state = (socket: tls.TLSSocket): string =>
  `authorized ${socket.authorized} authError ${String(socket.authorizationError)} peer ${peer(socket)}`;

const serverLog: string[] = [];
const clientLog: string[] = [];
let serverClosed = false;
let clientClosed = false;
let finished = false;
const finish = (): void => {
  if (finished || !serverClosed || !clientClosed) return;
  finished = true;
  say("server", serverLog.join(", "));
  say("client", clientLog.join(", "));
  server.close(() => console.log(out.join("\n")));
};

const server = tls.createServer(
  { key, cert, ca, requestCert: true, rejectUnauthorized: false, maxVersion: "TLSv1.2" },
  (socket) => {
    serverLog.push(`connection ${socket.getProtocol()} ${state(socket)}`);
    socket.on("data", () => {});
    socket.on("error", (err) => serverLog.push(`error ${codeOf(err)}`));
    socket.on("secure", () => serverLog.push(`secure ${state(socket)}`));
    socket.on("close", (hadError) => {
      serverLog.push(`close had_error ${hadError}`);
      serverClosed = true;
      finish();
    });
    // the policy now requires a certificate and rejects a failed one; the
    // peer can only re-send the certificate the store cannot chain
    const ret = socket.renegotiate({ requestCert: true, rejectUnauthorized: true }, (err) => {
      serverLog.push(`callback ${err === null ? "null" : codeOf(err)} ${state(socket)}`);
    });
    serverLog.push(`return ${ret}`);
  },
);
server.on("error", () => {});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({
    port,
    host: "127.0.0.1",
    ca,
    servername: "localhost",
    maxVersion: "TLSv1.2",
    rejectUnauthorized: false,
    cert: untrustedCert,
    key: untrustedKey,
  });
  client.on("data", () => {});
  client.on("secure", () => clientLog.push("secure"));
  client.on("error", (err) => clientLog.push(`error ${codeOf(err)}`));
  client.on("close", (hadError) => {
    clientLog.push(`close had_error ${hadError}`);
    clientClosed = true;
    finish();
  });
  // a peer that never closes would hang the program: end it plainly
  setTimeout(() => {
    if (!clientClosed) client.destroy();
  }, 500);
});
