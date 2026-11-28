// A session read with getSession() inside secureConnect still carries the
// connection's verification verdict: the session of an untrusted TLS 1.2
// connection, offered to a connection that verifies, must not authorize
// anything (the full handshake re-checks the chain and fails the way the
// original verification did); offered without verification it resumes and
// reports authorized false with the stored error.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const ca2 = readFileSync(`${certs}/ca2.pem`);

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

const serverLog: string[] = [];
const log: string[] = [];
let finished = false;
const finish = (): void => {
  if (finished) return;
  finished = true;
  say("server", serverLog.join(", "));
  say("client", log.join(", "));
  server.close(() => console.log(out.join("\n")));
};

const version = "TLSv1.2" as const;
const server = tls.createServer({ key, cert, minVersion: version, maxVersion: version }, (socket) => {
  serverLog.push(`reused ${socket.isSessionReused()}`);
  socket.on("data", () => {});
  socket.on("error", () => {});
});
server.on("error", () => {});
const options = (port: number) => ({
  port,
  host: "127.0.0.1",
  ca: ca2,
  servername: "localhost",
  minVersion: version,
  maxVersion: version,
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let session: Buffer | null = null;
  const first = tls.connect({ ...options(port), rejectUnauthorized: false });
  first.on("secureConnect", () => {
    // the session is taken before the connection's later bookkeeping runs
    session = first.getSession();
    log.push(`first authorized ${first.authorized} authError ${String(first.authorizationError)} ` +
             `session ${session === null ? "none" : "got"}`);
  });
  first.on("error", (err) => log.push(`first error ${codeOf(err)}`));
  setTimeout(() => {
    first.destroy();
    const cached = session;
    if (cached === null) {
      log.push("no session");
      finish();
      return;
    }
    // the same session, offered to a connection that verifies
    const verifying = tls.connect({ ...options(port), session: cached, rejectUnauthorized: true });
    verifying.on("secureConnect", () => log.push("verifying connect"));
    verifying.on("error", (err) => log.push(`verifying error ${codeOf(err)}`));
    verifying.on("close", () => {
      log.push("verifying close");
      // and to one that does not
      const resumed = tls.connect({ ...options(port), session: cached, rejectUnauthorized: false });
      resumed.on("data", () => {});
      resumed.on("secureConnect", () => {
        log.push(`resume reused ${resumed.isSessionReused()} authorized ${resumed.authorized} ` +
                 `authError ${String(resumed.authorizationError)}`);
      });
      resumed.on("error", (err) => log.push(`resume error ${codeOf(err)}`));
      setTimeout(() => {
        resumed.destroy();
        finish();
      }, 300);
    });
    // a peer that never closes would hang the program: end it plainly
    setTimeout(() => {
      if (!verifying.destroyed) verifying.destroy();
    }, 600);
  }, 500);
});
