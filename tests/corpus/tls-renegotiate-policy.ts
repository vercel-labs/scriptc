// tlsSocket.renegotiate(options): requestCert and rejectUnauthorized update
// the socket's client-certificate policy for that handshake (Node merges them
// over the socket's current values, which a server seeds from its options).
// A server that never asked for a certificate can demand one this way: the
// handshake completes, the callback answers null, authorizationError reports
// the missing certificate, and with rejectUnauthorized the connection ends
// without an 'error' on either side. Each phase prints both sides' events in
// their own order, so the interleaving between them is not part of the test.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

type RenegOptions = { requestCert?: boolean; rejectUnauthorized?: boolean };

// Node's tls.Server defaults are requestCert: false and rejectUnauthorized:
// true, so `{ requestCert: true }` alone reaches the rejecting combination
// and `{ rejectUnauthorized: true }` alone changes nothing.
const phases: readonly [string, { rejectUnauthorized?: boolean }, RenegOptions][] = [
  ["cert-on", {}, { requestCert: true }],
  ["cert-on-reject-off", { rejectUnauthorized: false }, { requestCert: true }],
  ["reject-on-only", {}, { rejectUnauthorized: true }],
  ["unchanged", {}, {}],
];

const runPhase = (index: number): void => {
  if (index >= phases.length) {
    console.log(out.join("\n"));
    return;
  }
  const [label, serverOptions, renegOptions] = phases[index]!;
  const serverLog: string[] = [];
  const clientLog: string[] = [];
  let serverClosed = false;
  let clientClosed = false;
  let finished = false;
  const finish = (): void => {
    if (finished || !serverClosed || !clientClosed) return;
    finished = true;
    say(label, "server", serverLog.join(", "));
    say(label, "client", clientLog.join(", "));
    server.close(() => setTimeout(() => runPhase(index + 1), 20));
  };
  let client: tls.TLSSocket | null = null;
  // the surviving combinations are ended by the program once the socket is
  // still open a moment after the callback; a rejected one closes itself
  const checkStillOpen = (socket: tls.TLSSocket): void => {
    setTimeout(() => {
      if (socket.destroyed) return;
      serverLog.push("still-open");
      socket.destroy();
    }, 40);
  };
  const server = tls.createServer({ key, cert, maxVersion: "TLSv1.2", ...serverOptions }, (socket) => {
    socket.on("data", () => {});
    socket.on("secure", () => serverLog.push("secure"));
    socket.on("error", (err) => serverLog.push(`error ${codeOf(err)}`));
    socket.on("close", (hadError) => {
      serverLog.push(`close had_error ${hadError}`);
      serverClosed = true;
      finish();
    });
    const ret = socket.renegotiate(renegOptions, (err) => {
      serverLog.push(`callback ${err === null ? "null" : codeOf(err)} authorized ${socket.authorized} ` +
                     `authError ${String(socket.authorizationError)}`);
      checkStillOpen(socket);
    });
    serverLog.push(`return ${ret}`);
  });
  server.on("error", () => {});
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    client = tls.connect(
      { port, host: "127.0.0.1", rejectUnauthorized: false, maxVersion: "TLSv1.2" },
      () => clientLog.push("connect"),
    );
    client.on("secure", () => clientLog.push("secure"));
    client.on("data", () => {});
    client.on("error", (err) => clientLog.push(`error ${codeOf(err)}`));
    client.on("close", (hadError) => {
      clientLog.push(`close had_error ${hadError}`);
      clientClosed = true;
      finish();
    });
    // a peer that never closes would hang the program: end it plainly
    setTimeout(() => {
      if (!clientClosed) client?.destroy();
    }, 300);
  });
};

runPhase(0);
