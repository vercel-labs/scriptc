// tlsSocket.setKeyCert(context): the context's certificate pair serves the
// socket's next server handshake, so a wrapped TLSSocket that the program
// holds before the handshake can be re-keyed. A SecureContext passes as it
// is; over createSecureContext's options the call builds one, and a context
// without a complete pair throws Node's error. A call the socket rejects
// leaves it serviceable: the pair a later call installs is the one the
// handshake serves. Each phase prints both sides' events in their own order,
// so the interleaving between them is not part of the test.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const otherCert = readFileSync(`${certs}/other-server.pem`);
const otherKey = readFileSync(`${certs}/other-server-key.pem`);

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);
const attempt = (log: string[], label: string, call: () => void): void => {
  try {
    call();
    log.push(`${label} accepted`);
  } catch (err) {
    log.push(`${label} throw ${(err as Error).name} ${codeOf(err)} ${messageOf(err)}`);
  }
};

// one wrapped server socket per phase: the client reports the certificate it
// received, so the installed pair is what the handshake actually served
const run = (label: string, install: (socket: tls.TLSSocket, log: string[]) => void,
             next: () => void): void => {
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
    server.close(() => setTimeout(next, 20));
  };
  const server = net.createServer((raw) => {
    const socket = new tls.TLSSocket(raw, { isServer: true, cert, key });
    socket.on("error", (err) => serverLog.push(`error ${codeOf(err)}`));
    socket.on("data", () => {});
    install(socket, serverLog);
    socket.on("secure", () => serverLog.push("secure"));
    socket.on("close", (hadError) => {
      serverLog.push(`close had_error ${hadError}`);
      serverClosed = true;
      finish();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    const client = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
      const peer = client.getPeerCertificate();
      clientLog.push(`peer-cn ${(peer.subject as { CN?: string }).CN}`);
      client.destroy();
    });
    client.on("error", (err) => clientLog.push(`error ${codeOf(err)}`));
    client.on("close", () => {
      clientClosed = true;
      finish();
    });
  });
};

run("pair", (socket, log) => attempt(log, "pair", () => socket.setKeyCert({ cert: otherCert, key: otherKey })), () => {
  const context = tls.createSecureContext({ cert: otherCert, key: otherKey });
  run("context", (socket, log) => attempt(log, "context", () => socket.setKeyCert(context)), () => {
    // an empty context throws, and the config's own certificate still
    // serves the handshake
    run("empty", (socket, log) => attempt(log, "empty", () => socket.setKeyCert({})), () => {
      run("cert-only", (socket, log) => {
        attempt(log, "cert-only", () => socket.setKeyCert({ cert: otherCert }));
        attempt(log, "cert-only-then-pair", () => socket.setKeyCert({ cert: otherCert, key: otherKey }));
      }, () => {
        run("key-only", (socket, log) => {
          attempt(log, "key-only", () => socket.setKeyCert({ key: otherKey }));
          attempt(log, "key-only-then-pair", () => socket.setKeyCert({ cert: otherCert, key: otherKey }));
        }, () => {
          // a socket that has been destroyed applies nothing and throws
          // nothing, even for an argument it would otherwise reject
          run("destroyed", (socket, log) => {
            socket.destroy();
            attempt(log, "destroyed", () => socket.setKeyCert("junk" as unknown as {}));
          }, () => console.log(out.join("\n")));
        });
      });
    });
  });
});
