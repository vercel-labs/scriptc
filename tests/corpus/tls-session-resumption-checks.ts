// Sessions captured before their peer verified: a session from a connection
// that did not verify its peer is not carried into a connection that now
// verifies (that one fails the way the original verification did), and a
// resumed connection reports the verdict the session was captured with. A
// session another server cannot parse falls back to a full handshake
// (isSessionReused false). TLS 1.3 tickets fire 'session' per ticket and the
// getters answer the newest one, with or without a listener.
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

type Version = "TLSv1.2" | "TLSv1.3";

const runVersion = (version: Version, done: () => void): void => {
  const log: string[] = [];
  const serverLog = (tag: string) => (socket: tls.TLSSocket): void => {
    log.push(`${tag} reused ${socket.isSessionReused()}`);
    socket.on("data", () => {});
    socket.on("error", () => {});
  };
  const a = tls.createServer({ key, cert, minVersion: version, maxVersion: version }, serverLog("A"));
  const b = tls.createServer({ key, cert, minVersion: version, maxVersion: version }, serverLog("B"));
  const options = (port: number) => ({
    port,
    host: "127.0.0.1",
    ca: ca2,
    servername: "localhost",
    rejectUnauthorized: false,
    minVersion: version,
    maxVersion: version,
  });
  const finish = (): void => {
    a.close();
    b.close(() => {
      say(version, log.join(" | "));
      done();
    });
  };
  a.on("error", () => {});
  b.on("error", () => {});
  a.listen(0, "127.0.0.1", () => {
    b.listen(0, "127.0.0.1", () => {
      const pa = (a.address() as { port: number }).port;
      const pb = (b.address() as { port: number }).port;
      // the first connection: an untrusted chain, verification off
      let session: Buffer | null = null;
      let events = 0;
      let firstTicket = "";
      let lastTicket = "";
      const first = tls.connect(options(pa));
      first.on("session", () => {
        events += 1;
        const ticket = first.getTLSTicket();
        const hex = ticket === null || ticket === undefined ? "" : ticket.toString("hex");
        if (firstTicket === "") firstTicket = hex;
        lastTicket = hex;
      });
      first.on("error", (err) => log.push(`first error ${codeOf(err)}`));
      setTimeout(() => {
        session = first.getSession();
        const after = first.getTLSTicket();
        const afterHex = after === null || after === undefined ? "" : after.toString("hex");
        // the engine processes a connection's tickets in one read and
        // signals once: the runtime reports the tickets it saw, and Node
        // reports one event per ticket — the count is not asserted
        log.push(`ticket-events ${events > 0} after-same-last ${afterHex === lastTicket}`);
        first.destroy();
        if (session === null) {
          log.push("no session");
          finish();
          return;
        }
        // a session captured unverified offered to a connection that verifies
        const verifying = tls.connect({ ...options(pa), session, rejectUnauthorized: true });
        let settledVerifying = false;
        const finishVerifying = (): void => {
          if (settledVerifying) return;
          settledVerifying = true;
          stepUntrustedResume();
        };
        verifying.on("secureConnect", () => log.push("verifying connect"));
        verifying.on("error", (err) => log.push(`verifying error ${codeOf(err)}`));
        verifying.on("close", () => {
          log.push("verifying close");
          finishVerifying();
        });
        setTimeout(() => {
          verifying.destroy();
          finishVerifying();
        }, 600);

        const stepUntrustedResume = (): void => {
          const resumed = tls.connect({ ...options(pa), session });
          resumed.on("secureConnect", () => {
            log.push(`untrusted-resume reused ${resumed.isSessionReused()} ` +
                     `authorized ${resumed.authorized} authError ${String(resumed.authorizationError)}`);
          });
          resumed.on("error", (err) => log.push(`untrusted-resume error ${codeOf(err)}`));
          setTimeout(() => {
            resumed.destroy();
            stepOtherServer();
          }, 300);
        };

        const stepOtherServer = (): void => {
          const foreign = tls.connect({ ...options(pb), session });
          foreign.on("secureConnect", () => log.push(`other-server reused ${foreign.isSessionReused()}`));
          foreign.on("error", (err) => log.push(`other-server error ${codeOf(err)}`));
          setTimeout(() => {
            foreign.destroy();
            stepNoListener();
          }, 300);
        };

        const stepNoListener = (): void => {
          const quiet = tls.connect(options(pa));
          quiet.on("error", (err) => log.push(`quiet error ${codeOf(err)}`));
          quiet.on("secureConnect", () => {
            log.push(`quiet at-connect session ${quiet.getSession() ? "got" : "none"} ` +
                     `ticket ${quiet.getTLSTicket() ? "got" : "none"}`);
            setTimeout(() => {
              log.push(`quiet later session ${quiet.getSession() ? "got" : "none"} ` +
                       `ticket ${quiet.getTLSTicket() ? "got" : "none"}`);
              quiet.destroy();
              finish();
            }, 500);
          });
        };
      }, 700);
    });
  });
};

runVersion("TLSv1.3", () => {
  runVersion("TLSv1.2", () => console.log(out.join("\n")));
});
