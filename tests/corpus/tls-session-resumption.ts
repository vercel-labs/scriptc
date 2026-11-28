// Session resumption: the session a client received (getSession(), or the
// 'session' event) is offered on a second connection, and the resumed
// handshake answers isSessionReused() true on both sides; a resumed
// handshake presents no certificate and fires no further 'session' event.
// TLS 1.2 (the session rides the handshake) and TLS 1.3 (the ticket follows
// it) both resume. Each side prints its events in its own order.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const ca = readFileSync(`${certs}/ca.pem`);

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

const run = (version: "TLSv1.2" | "TLSv1.3", done: () => void): void => {
  const label = version;
  const serverLog: string[] = [];
  const clientLog: string[] = [];
  const connectOptions = (port: number) => ({
    port,
    host: "127.0.0.1",
    ca,
    servername: "localhost",
    minVersion: version,
    maxVersion: version,
  });
  const server = tls.createServer(
    { key, cert, minVersion: version, maxVersion: version },
    (socket) => {
      serverLog.push(`connection ${socket.getProtocol()} reused ${socket.isSessionReused()}`);
      socket.on("data", () => {});
      socket.on("error", (err) => serverLog.push(`error ${codeOf(err)}`));
    },
  );
  server.on("error", () => {});
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    // the first connection: a full handshake that yields a session
    let session: Buffer | null = null;
    let sessionSeen = false;
    const first = tls.connect(connectOptions(port), () => {
      clientLog.push(`first connect reused ${first.isSessionReused()}`);
    });
    first.on("session", (s) => {
      session = s;
      if (!sessionSeen) clientLog.push("first session-seen");
      sessionSeen = true;
    });
    first.on("error", (err) => clientLog.push(`first error ${codeOf(err)}`));
    setTimeout(() => {
      first.destroy();
      clientLog.push(`first session ${session === null ? "none" : "got"}`);
      if (session === null) {
        server.close(() => finish());
        return;
      }
      // the second connection offers the session
      let secondSessionEvents = 0;
      const second = tls.connect({ ...connectOptions(port), session }, () => {
        clientLog.push(`second connect reused ${second.isSessionReused()}`);
      });
      second.on("session", () => {
        secondSessionEvents += 1;
      });
      second.on("data", () => {});
      second.on("error", (err) => clientLog.push(`second error ${codeOf(err)}`));
      setTimeout(() => {
        clientLog.push(`second session-event ${secondSessionEvents > 0}`);
        second.destroy();
        server.close(() => finish());
      }, 400);
    }, 600);
  });

  const finish = (): void => {
    say(label, "server", serverLog.join(", "));
    say(label, "client", clientLog.join(", "));
    done();
  };
};

run("TLSv1.2", () => {
  run("TLSv1.3", () => console.log(out.join("\n")));
});
