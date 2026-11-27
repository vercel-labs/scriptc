// tlsSocket.renegotiate({ requestCert: true }) on a TLS 1.3 socket is refused
// — false, then the callback's ERR_SSL_WRONG_SSL_VERSION — and the refusal
// must leave the socket's authorization answer as it was. A server that never
// asked for a client certificate keeps authorized false, even though the
// connection verified nothing: the review's repro was a resumed TLS 1.3
// session (no client certificate, a zero verification result), and a full
// TLS 1.3 connection has that same state here, where sessions are never
// resumed.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);

let client: tls.TLSSocket | null = null;
const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.on("error", (err) => say("server-error", codeOf(err)));
  const state = (): string =>
    `authorized ${socket.authorized} authError ${String(socket.authorizationError)}`;
  say("connection", socket.getProtocol(), state());
  // the options ask for a client certificate on a connection that cannot
  // renegotiate: nothing about the socket may change
  const ret = socket.renegotiate({ requestCert: true }, (err) => {
    const outcome = err === null ? "null" : `${codeOf(err)} ${messageOf(err)}`;
    say("callback", outcome, state());
  });
  say("return", ret, state());
  setTimeout(() => {
    say("settled", state());
    client?.destroy();
    server.close(() => {
      console.log(out.join("\n"));
    });
  }, 50);
});
server.on("error", () => {});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const socket = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    say("client", socket.getProtocol(), "reused", socket.isSessionReused());
  });
  client = socket;
  client.on("error", (err) => say("client-error", codeOf(err)));
});
