// tls.connect's options.checkServerIdentity: the callback runs with the
// servername (or the host when none is set) beside the verified chain, its
// error answer fails the handshake, and a non-function option throws
// Node's TypeError before anything is dialled.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);
const ca = readFileSync(`${d}/ca.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("hello"));

class Refused extends Error {
  code = "EIDENT";
  constructor() {
    super("identity refused");
  }
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;

  // servername names the verified host, so the CA's localhost chain passes.
  const good = tls.connect(
    {
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      checkServerIdentity: (name: string, peer: tls.PeerCertificate) => {
        console.log("check", name, peer.subject.CN);
      },
    },
    () => {
      console.log("secureConnect", good.authorized);
      good.end();

      const refused = tls.connect(
        {
          port,
          host: "127.0.0.1",
          servername: "localhost",
          ca,
          checkServerIdentity: () => new Refused(),
        },
        () => console.log("unexpected secureConnect"),
      );
      refused.on("error", (e: Error) => {
        const err = e as any;
        console.log("refused", err.name, err.code, err.message, refused.authorized);
        refused.destroy();

        for (const bad of [undefined, 42 as any]) {
          try {
            tls.connect({ port, host: "127.0.0.1", ca, checkServerIdentity: bad });
            console.log("built");
          } catch (e) {
            const err = e as any;
            console.log("threw", err.name, err.code, err.message);
          }
        }
        server.close(() => console.log("closed"));
      });
    },
  );
  good.on("error", (e: Error) => console.log("good error", (e as any).code));
});
