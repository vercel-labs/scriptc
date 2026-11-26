// tls.connect({ checkServerIdentity }): the caller's verifier replaces the
// builtin hostname check — an accepting verifier lets a name-mismatched
// leaf through when the chain verifies, and a rejecting one fails the
// connection with its own error. Without the option the builtin check
// reports Node's alternative-name error.
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

type Case = {
  label: string;
  check: ((hostname: string, cert: unknown) => Error | undefined) | null;
  servername?: string;
  reject?: boolean;
  reportAuth?: boolean;
};
const cases: Case[] = [
  {
    label: "accept",
    // the chain verifies, so the caller's verifier decides the identity; the
    // peer-certificate object carries the certificate's fields
    check: (hostname, peer) => {
      const subject = (peer as { subject?: { CN?: string } }).subject;
      say("accept-called", hostname, typeof peer, subject !== undefined ? subject.CN : "no-subject");
      return undefined;
    },
  },
  {
    label: "reject",
    check: () => {
      const err = new Error("certificate pin mismatch");
      (err as { code?: string }).code = "ERR_PIN_MISMATCH";
      return err;
    },
  },
  { label: "builtin", check: null },
  {
    // a servername the certificate does not name: the caller's verifier
    // replaces the builtin name check
    label: "servername",
    servername: "pin.example",
    check: (hostname) => {
      say("servername-called", hostname);
      return undefined;
    },
  },
  {
    // a connection-scoped verifier captures its own socket: settlement must
    // release the verifier so the cycle does not retain the closed socket
    label: "capture",
    check: () => {
      say("capture-called", captured !== null);
      return undefined;
    },
  },
  {
    // rejectUnauthorized:false: a rejecting verifier leaves the socket
    // unauthorized and secureConnect still fires
    label: "no-reject",
    reject: false,
    reportAuth: true,
    check: () => {
      const err = new Error("pinned out");
      (err as { code?: string }).code = "ERR_PIN_MISMATCH";
      return err;
    },
  },
];

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("error", () => {});
  socket.end("bye");
});

let captured: tls.TLSSocket | null = null;

const next = (): void => {
  const entry = cases.shift();
  if (entry === undefined) {
    server.close(() => {
      say("server-closed");
      console.log(out.join("\n"));
    });
    return;
  }
  let connected = false;
  const port = (server.address() as { port: number }).port;
  const check = entry.check;
  const servername = entry.servername;
  const reject = entry.reject ?? true;
  const client =
    check !== null
      ? tls.connect(
          {
            port,
            host: "127.0.0.1",
            ca,
            rejectUnauthorized: reject,
            ...(servername !== undefined ? { servername } : {}),
            checkServerIdentity: (hostname: string, peer: object) => check(hostname, peer),
          },
          () => {
            connected = true;
            if (entry.reportAuth === true) {
              say(entry.label, "connected", "authorized", client.authorized,
                  "reason", JSON.stringify(client.authorizationError));
            }
          },
        )
      : tls.connect({ port, host: "127.0.0.1", ca, rejectUnauthorized: reject }, () => {
          connected = true;
        });
  if (entry.label === "capture") captured = client;
  client.on("data", () => {});
  client.on("error", (err) => {
    say(entry.label, "error", codeOf(err), messageOf(err));
    client.destroy();
    next();
  });
  client.on("close", () => {
    if (connected) {
      say(entry.label, "connected");
      next();
    }
  });
};

server.listen(0, "127.0.0.1", next);
