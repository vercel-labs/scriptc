// https.request's options.checkServerIdentity edge cases: an error answer
// fails the request with that error; rejectUnauthorized: false accepts the
// connection and reports the answer as authorizationError; a failing
// chain is reported before the callback runs; and a non-function option
// throws Node's TypeError before anything is dialled.
import * as https from "node:https";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);
const ca = readFileSync(`${d}/ca.pem`);

const server = https.createServer({ cert, key }, (req, res) => {
  console.log("server", req.url);
  res.end("pong");
});

class Refused extends Error {
  code = "EIDENT";
  constructor() {
    super("identity refused");
  }
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;

  const failing = https.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/refused",
      ca,
      agent: false,
      checkServerIdentity: (host: string) => {
        console.log("check", host);
        return new Refused();
      },
    },
    () => console.log("unexpected response"),
  );
  failing.on("error", (e: Error) => {
    const err = e as any;
    console.log("refused", err.name, err.code, err.message);

    // rejectUnauthorized: false keeps the connection; the answer becomes
    // authorizationError.
    const lenient = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/lenient",
        ca,
        agent: false,
        rejectUnauthorized: false,
        checkServerIdentity: (host: string) => {
          console.log("check", host);
          return new Refused();
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => {
          const socket = lenient.socket as tls.TLSSocket;
          console.log("lenient", res.statusCode, text, socket.authorized, socket.authorizationError);

          // A failing chain is reported before the callback runs.
          const chained = https.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/chain",
              agent: false,
              checkServerIdentity: (host: string) => {
                console.log("chain check", host);
              },
            },
            () => console.log("unexpected response"),
          );
          chained.on("error", (e: Error) => {
            console.log("chain", (e as any).code);

            for (const bad of [undefined, 42 as any]) {
              try {
                https.request({ hostname: "127.0.0.1", port, path: "/", ca, checkServerIdentity: bad });
                console.log("built");
              } catch (e) {
                const err = e as any;
                console.log("threw", err.name, err.code, err.message);
              }
            }
            server.close(() => console.log("closed"));
          });
          chained.end();
        });
      },
    );
    lenient.on("error", (e: Error) => console.log("lenient error", (e as any).code));
    lenient.end();
  });
  failing.end();
});
