// The socket status reads a value the compiler does not type as a
// TLSSocket reach agree with the typed ones: a peer the custom verifier
// refused on a lenient connection reports authorized false and the
// verifier's code as authorizationError, and a peer it accepted reports
// authorized true and null.
import * as https from "node:https";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);
const ca = readFileSync(`${d}/ca.pem`);

const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));

class Refused extends Error {
  code = "EIDENT";
  constructor() {
    super("identity refused");
  }
}

// the opaque view: these property reads take the dynamic path
function opaque(socket: any): any {
  return socket;
}

function report(label: string, socket: any): void {
  console.log(label, socket.authorized, socket.authorizationError);
}

function request(
  port: number,
  path: string,
  checkServerIdentity: (host: string, cert: object) => Error | undefined,
  done: () => void,
): void {
  const req = https.request(
    { hostname: "127.0.0.1", port, path, ca, agent: false, rejectUnauthorized: false, checkServerIdentity },
    (res) => {
      res.resume();
      res.on("end", () => {
        const socket = req.socket as tls.TLSSocket;
        console.log("typed", path, socket.authorized, socket.authorizationError);
        report("dynamic", opaque(socket));
        done();
      });
    },
  );
  req.on("error", (e: Error) => console.log("error", path, (e as any).code));
  req.end();
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;

  request(
    port,
    "/refused",
    (host: string) => {
      console.log("check", host);
      return new Refused();
    },
    () => {
      request(
        port,
        "/accepted",
        (host: string) => {
          console.log("check", host);
          return undefined;
        },
        () => server.close(() => console.log("closed")),
      );
    },
  );
});
