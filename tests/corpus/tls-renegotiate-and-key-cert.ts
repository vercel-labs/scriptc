// tlsSocket.renegotiate(options[, callback]) and setKeyCert(context): the
// argument ladders, the TLS 1.3 refusal (false and the callback's
// ERR_SSL_WRONG_SSL_VERSION), and the TLS 1.2 renegotiation (true, a second
// 'secure' and a null callback).
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);

let serverPeer: tls.TLSSocket | null = null;

const run = (maxVersion: "TLSv1.2" | "TLSv1.3", done: () => void): void => {
  const server = tls.createServer({ key, cert, maxVersion }, (socket) => {
    socket.on("error", () => {});
    serverPeer = socket;
  });
  server.on("error", () => {});
  server.listen(0, "127.0.0.1", () => {
    const client = tls.connect(
      {
        port: (server.address() as { port: number }).port,
        host: "127.0.0.1",
        rejectUnauthorized: false,
        maxVersion,
      },
      () => {
        // the argument ladders throw Node's type errors before any state: an
        // empty-object cast carries the value Node's ladder judges
        const probe = (label: string, call: () => unknown): void => {
          try {
            call();
            say(maxVersion, label, "accepted");
          } catch (err) {
            say(maxVersion, label, codeOf(err), messageOf(err));
          }
        };
        const noOptions = undefined as unknown as {};
        probe("none", () => client.renegotiate(noOptions));
        probe("function", () => client.renegotiate((() => {}) as unknown as {}));
        probe("bad-callback", () => client.renegotiate({}, "x" as unknown as () => void));
        probe("setKeyCert-string", () => client.setKeyCert("x" as unknown as {}));
        probe("setKeyCert-object", () => client.setKeyCert({}));

        // registered after the handshake's emission: misses the initial
        // 'secure' but sees a later one (Node's rule)
        let lateSecure = 0;
        client.on("secure", () => {
          lateSecure += 1;
        });
        let answered = false;
        const finish = (): void => {
          if (answered) return;
          answered = true;
          client.destroy();
          server.close(() => done());
        };
        const ret = client.renegotiate({}, (err) => {
          say(maxVersion, "callback", err === null ? "null" : codeOf(err), "secure", secure, "late", lateSecure);
          if (maxVersion === "TLSv1.2" && serverPeer !== null) {
            // the peer's own renegotiation: the client walks a new chain.
            // Its 'secure' lands when the client processes the server's
            // flight, so the count is read once both sides have settled
            // rather than inside the callback.
            const sr = serverPeer.renegotiate({}, (serverErr) => {
              const outcome = serverErr === null ? "null" : codeOf(serverErr);
              setTimeout(() => {
                say(maxVersion, "server-callback", outcome, "client-secure", secure);
                finish();
              }, 50);
            });
            say(maxVersion, "server-return", sr);
            return;
          }
          finish();
        });
        say(maxVersion, "return", ret);
        setTimeout(() => {
          say(maxVersion, "timeout", "secure", secure, "late", lateSecure);
          finish();
        }, 500);
      },
    );
    let secure = 0;
    client.on("secure", () => {
      secure += 1;
    });
    client.on("data", () => {});
    client.on("error", (err) => say(maxVersion, "client-error", codeOf(err)));
  });
};

// Repeated renegotiations: OpenSSL's session-attack guard reports the fourth
// and later ones on the server socket while the client keeps completing.
const runRepeat = (done: () => void): void => {
  const serverErrors: string[] = [];
  const server = tls.createServer({ key, cert, maxVersion: "TLSv1.2" }, (socket) => {
    socket.on("error", (err) => {
      serverErrors.push(codeOf(err));
    });
  });
  server.on("error", () => {});
  server.listen(0, "127.0.0.1", () => {
    const client = tls.connect(
      {
        port: (server.address() as { port: number }).port,
        host: "127.0.0.1",
        rejectUnauthorized: false,
        maxVersion: "TLSv1.2",
      },
      () => {
        let renegs = 0;
        const once = (): void => {
          renegs += 1;
          const ret = client.renegotiate({}, (err) => {
            say("repeat", renegs, err === null ? "ok" : codeOf(err), "ret", ret);
            if (renegs < 4) {
              once();
              return;
            }
            setTimeout(() => {
              say("repeat-server-errors", serverErrors.join(","));
              client.destroy();
              server.close(() => done());
            }, 50);
          });
        };
        once();
      },
    );
    client.on("data", () => {});
    client.on("error", (err) => say("repeat-client-error", codeOf(err)));
  });
};

run("TLSv1.3", () => {
  run("TLSv1.2", () => {
    runRepeat(() => console.log(out.join("\n")));
  });
});

